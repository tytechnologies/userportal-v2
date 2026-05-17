# Hybrid live search

Zillow-style search: internal listings (authoritative) + external candidates from third-party providers (Tavily today), deduplicated, ranked, and merged on every user query. Internal results always lead; external NEVER blocks render. Strict deadlines + multi-layer cache keep it production-grade.

## Components

### Migrations
- `20260514000002_hybrid_live_search.sql` — `source_connectors`, `live_search_cache`, `external_listing_candidates`, `search_events`, `record_search_event()`, `expire_live_search_cache()`.
- `20260514000003_listing_details_title_fts.sql` — GIN FTS index for the PG-FTS fallback.

### Portal utilities (`server/utils/`)
- `tavily.ts` — fetch-based Tavily client (`tavilySearch`, `tavilyExtract`, `consumeTavilyBudget`).
- `externalProviderAdapter.ts` — Tavily raw → normalized `ExternalCandidate` with parse_confidence (0..0.85).
- `runtimeDedup.ts` — Haversine + Jaccard + price proximity + br/ba/type/city, threshold 0.55.
- `hybridRanking.ts` — internal-authoritative ×1.5 boost, freshness decay, hard "internal > external within ±10% score" tier.

### Portal endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/internal/live-search` | `x-internal-secret` | Cache-first fan-out per enabled connector |
| POST | `/api/internal/search-event` | `x-internal-secret` | Telemetry sink |
| GET | `/api/admin/live-search/overview` | admin | KPIs + cache + 24h events + candidate state |
| PATCH | `/api/admin/live-search/connectors` | admin | Toggle / tune |
| POST | `/api/admin/live-search/cache-purge` | admin | Per-provider or expired-sweep |
| GET | `/api/admin/live-search/candidates` | admin | Paginated, filterable list of external candidates |
| PATCH | `/api/admin/live-search/candidates/[id]` | admin | Update operator/dedup status of one candidate |
| POST | `/api/admin/live-search/candidates/[id]/promote` | admin | Copy a candidate to listings_raw for full ingest |

### Website endpoints
- `GET /api/public/search-hybrid` — orchestrator. Internal (Typesense/PG-FTS) + portal live-search in parallel. Dedup + rank in-process. Telemetry best-effort.
- `GET /api/public/search-stream` — SSE: `internal` → `external` → `done` events.

### Pages
- Portal `/admin/live-search` — operator dashboard (KPIs, cache, connector toggles).
- Portal `/admin/external-candidates` — discovery corpus review queue (blacklist / promote / pin dedup).
- Website `/search-hybrid` — standalone test bed.
- Website `/[...slug]?engine=hybrid` — canonical search page hybrid mode.

### Env vars (portal)
- `TAVILY_API_KEY` — provider key. Unset = all live providers no-op.
- `INTERNAL_CRON_SECRET` — shared with website + cron.

### Env vars (website)
- `USERPORTAL_URL` — base URL of the portal Nitro process.
- `INTERNAL_CRON_SECRET` — must match portal.

## Operate

### Enable from scratch

1. Apply migrations 20260514000002 and 20260514000003.
2. Set env vars: `TAVILY_API_KEY` (portal), `INTERNAL_CRON_SECRET` (both).
3. Open `/admin/live-search` → click **Enable** on `tavily_ph_real_estate`.
4. Test query: `/search-hybrid?q=makati+2br+condo&for_sale=true`.

### Tune a connector

From `/admin/live-search`:
- **Disable** stops live calls; cached rows still serve until TTL expiry.
- **Trust score** (0-100) weights provider hits in ranking. Below internal_authoritative always.
- **Daily budget** caps Tavily calls per day. Tracked via `rate_limit_buckets`. Resets at UTC midnight.
- **Domain allowlist** (comma-separated in `domain_allowlist` text array) filters Tavily to curated partner domains.
- **TTL** controls how long cached candidates stay valid before re-fetch.

### Watch traffic

- `/admin/live-search` shows p50/p95 internal+external latencies (24h), degraded %, dedup collapses.
- `search_events` table holds raw telemetry — query directly for ad-hoc analysis.

## Smoke

```powershell
# 1. Portal endpoint authenticates
curl -s -X POST `
  -H "x-internal-secret: <INTERNAL_CRON_SECRET>" `
  -H "content-type: application/json" `
  -d '{\"q\":\"makati 2br condo\"}' `
  http://localhost:3002/api/internal/live-search

# 2. Website orchestrator returns merged
curl -s "http://localhost:3001/api/public/search-hybrid?q=makati+2br+condo&for_sale=true" | jq '.internal, .external, .dedup'

# 3. Confirm hybrid flag works on canonical page
curl -s "http://localhost:3001/<any-existing-search-slug>?engine=hybrid" | grep -o "hybrid"
```

## Failure modes

The orchestrator response's `external.degraded_reason` field tells you
which class of failure happened (without grepping logs). Possible values:

| `degraded_reason` | What it means | Where to fix |
|---|---|---|
| `not_configured` | Website's `USERPORTAL_URL` or `INTERNAL_CRON_SECRET` env unset | Website `.env`; restart Nitro |
| `circuit_open` | 3+ consecutive failures → 60s cooldown suppressing calls | Wait, or restart the website to reset state |
| `timeout` | Portal call exceeded the transport budget (deadline + 3s) | Check tunnel health; tune `external_deadline_ms` upward |
| `unauthorized` | 401 from portal — secret mismatch | Make `INTERNAL_CRON_SECRET` identical in portal + website + `internal_config.digest_cron_secret` |
| `no_connectors` | Portal reachable, but zero enabled connectors | `/admin/live-search` → Enable `tavily_ph_real_estate` |
| `provider_errors` | At least one provider timed out / errored on this query | Check `providers.<slug>.status` for `timeout` / `error` / `budget_exhausted` |
| `unknown` | Anything else | Server logs for `[/api/public/search-hybrid] external fetch failed:` |

Other:

| Symptom | Cause | Fix |
|---|---|---|
| Internal latency >500ms repeatedly | PG-FTS path, no index | Verify mig 20260514000003 FTS index landed; check `EXPLAIN ANALYZE` |
| External cards show placeholder thumbnails | Tavily `include_images` empty OR returned URLs blocked | Acceptable — placeholder is the designed fallback |

## Open work

- Image fingerprinting for dedup (optional per spec; deferred).
- Partner-feed connectors beyond Tavily (adapter pattern is in place; needs new entries in `runConnector`'s dispatch).
- Async refinement: post-write reconciliation that promotes high-confidence external candidates into `listings_raw` for full ingest.
- `?engine=hybrid` URL flag is opt-in; cutover to default after observation.

## Related guides

- [aggregation-ingest.md](aggregation-ingest.md) — what populates the internal side
- [search-indexing.md](search-indexing.md) — where Typesense lives
- [marketing-ticker.md](marketing-ticker.md) — same flavor of orchestrator pattern, much smaller
