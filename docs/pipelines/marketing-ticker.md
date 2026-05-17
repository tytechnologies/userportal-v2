# Marketing ticker

Admin-managed live-data ticker that sits below the top nav on the public website. Each row picks a `kind` resolver (live counts, city pulse, etc.) and a label template with `{{value}}` substitution. Disable per-row or globally.

## Components

### Migration
- `20260514000001_marketing_ticker.sql` — `marketing_ticker_messages` table + 5-value kind enum + 6-value tone enum + RLS + 3 seed rows.

### Table
```
marketing_ticker_messages (
  id uuid PK,
  kind text CHECK IN ('static','new_listings_recent','active_agents','total_listings_online','city_pulse'),
  label text,              -- with {{value}} placeholder
  source_config jsonb,     -- kind-specific params
  tone text,               -- success | warning | destructive | info | primary | neutral
  link_url text,
  priority int,            -- lower = earlier in marquee
  enabled bool,
  created_by uuid, created_at timestamptz, updated_at timestamptz
)
```

### RLS
- `anon SELECT WHERE enabled = true`
- admin `ALL`

### Portal utilities
- `server/utils/tickerResolvers.ts` — 5 kinds, fail-soft per resolver. Uses `count: 'planned'` on listings (no full scan).

### Portal endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/public/ticker` | none | Anon-read of enabled rows + resolved values |
| GET | `/api/admin/ticker` | admin | List all rows |
| POST | `/api/admin/ticker` | admin | Create |
| PATCH | `/api/admin/ticker/[id]` | admin | Update |
| DELETE | `/api/admin/ticker/[id]` | admin | Delete |

### Website endpoint
- `GET /api/public/ticker` — same-origin proxy that queries Supabase directly (no portal hop) using the anon client + `public_listing_details` view. Eliminates cross-server dependency for the read path.

### Website utility
- `server/utils/tickerResolvers.ts` — mirrors the portal's, but queries `public_listing_details` (anon-readable view) instead of `listings`.

### Components
- Portal `/admin/ticker.vue` — full CRUD page with modal editor.
- Website `app/components/TickerBanner.vue` — SSR + 60s client refresh marquee. Hover-pause. Reduced-motion fallback.
- Website `app/layouts/default.vue` — renders `<TickerBanner />` between header and slot.

### Tone palette
Maps to Tailwind shade tokens. Website palette uses `{50, 500, 700}` for status colors (no DEFAULT), and DEFAULT-with-alpha for `primary` / `destructive` / `muted`.

## Operate

### Seed rows (already in the migration)
- `🆕 {{value}} new listings this week` (success, last 7 days)
- `👥 {{value}} active brokers + agents` (info, last 30 days)
- `🏘️ {{value}} live listings on the platform` (primary, current count)

### Add a row
From `/admin/ticker` (sidebar → Infrastructure → Marketing ticker, or `/admin/ticker` direct):

1. Click **New ticker entry**.
2. Pick a `kind`:
   - `static` — verbatim label, no live value
   - `new_listings_recent` — count over last N days (config: `{"window_days": 7}`)
   - `active_agents` — distinct contacts on listings touched in N days (config: `{"window_days": 30}`)
   - `total_listings_online` — current is_online count (no config)
   - `city_pulse` — median sale price vs 90-day baseline (config: `{"city_id": 1}` or `{"city_slug": "makati"}`)
3. Write the label with `{{value}}` where the live count substitutes.
4. Pick a tone.
5. Save. Cache invalidates within 60s.

### Disable
- Per-row: clear the `enabled` checkbox in the editor.
- Globally: delete all rows OR set them all to disabled.

When no rows are enabled, the website banner renders nothing — the `<aside v-if="hasItems">` skips the DOM.

## Smoke

```sql
-- 1. Seed rows present
SELECT kind, label, tone, enabled FROM public.marketing_ticker_messages ORDER BY priority;

-- 2. Anon can read enabled rows
-- (run as anon — adjust JWT in your client)
SELECT count(*) FROM public.marketing_ticker_messages WHERE enabled = true;
```

```powershell
# 3. Website endpoint resolves
curl -s "http://localhost:3001/api/public/ticker" | jq '.items'
# Expect: [{ id, kind, label (with substituted value), tone, ... }]
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Banner empty when items exist | RLS blocking anon SELECT | Confirm `marketing_ticker_anon_read` policy exists on the table |
| Banner empty + 200 from `/api/public/ticker` | Resolver returns null for all rows (e.g. `public_listing_details` view missing) | Run smoke #3 — check `degraded` field |
| Live counts stale | 60s cache + 60s client refresh = up to 2min lag | Acceptable. To force, redeploy or `cache-purge` in admin (planned, not yet wired) |
| Banner crashes page | Network error during SSR fetch | Component catches; renders empty. Check Nitro logs |

## Open work

- Cache invalidation hook on admin edits (today: implicit 60s + 60s = up to 2min lag).
- Click tracking — `link_url` clicks aren't analytics-tracked yet.
- Sidebar-nav badge counts for items expiring soon (e.g. city_pulse stale data).

## Related guides

- [aggregation-ingest.md](aggregation-ingest.md) — feeds the counts the ticker resolves
