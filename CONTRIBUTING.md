# Contributing

First-day onboarding for the userportal + website pair. Project-specific
quirks that aren't obvious from reading the code: dual-repo layout,
schema discipline, service-role allowlist, common traps, where the
test harness lives.

If something's missing here, the deeper docs are in `docs/`:

- [`CHANGELOG.md`](./CHANGELOG.md) — what's recently shipped + deferred
- [`docs/PUBLIC_API.md`](./docs/PUBLIC_API.md) — public endpoint surface
- [`docs/PUBLIC_DATA_SURFACE.md`](./docs/PUBLIC_DATA_SURFACE.md) — what anon clients can read
- [`docs/MV_REFRESH_STRATEGY.md`](./docs/MV_REFRESH_STRATEGY.md) — listing_details refresh cadence
- [`docs/RLS_TESTS.md`](./docs/RLS_TESTS.md) — running the RLS test harness

---

## Repo layout

Two repositories. **One Supabase project.**

```
userportal-v2/                          # MLS + CRM (this repo)
  app/                  Nuxt UI (admin, listings, contacts, dashboard)
  server/               Nitro endpoints, repositories, server utils
  supabase/migrations/  Schema migrations (numeric order)
  tests/                Vitest — pure-fn tests + tests/rls/

websiteo/               # Public marketplace (sibling repo)
  app/                  Public pages, listing detail, agent profiles
  server/               Public proxy endpoints (inquiries, etc.)
```

**Don't duplicate domain types or schema knowledge across repos.**
The website reads via the public anon-safe view (`public_listing_details`)
and proxies writes to the userportal's `/api/public/*` endpoints. If
you find yourself writing direct Supabase queries from the website
against tables that have admin/agent data, stop and proxy through the
userportal instead.

---

## Local development

Userportal runs on Nuxt's default port (`http://localhost:3000`); the
website typically runs on `:3001`. Both connect to the same Supabase
URL via env config.

For dev, the project uses **Cloudflare Tunnel** to expose your local
userportal under a stable HTTPS URL so the website can POST inquiries
to it cross-origin without certificate / CORS friction. Production
runs on AWS.

```bash
pnpm install
pnpm dev
```

If `pnpm install` fails on Windows with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`,
prefix with `CI=true`:

```bash
CI=true pnpm install
```

---

## Schema discipline

**Migrations are additive-only.** This is non-negotiable in this codebase:

- Add a column? `ADD COLUMN IF NOT EXISTS`.
- Need a different type? Add a new column, backfill, leave the old one alone.
- Need to drop a column? Get explicit user sign-off; never silent.
- View definitions? `CREATE OR REPLACE` only works if column position +
  type are unchanged. If you need a different shape, drop and recreate
  in the same transaction (and read the section below on the
  `42P16` view-column-rename trap).

Every migration must include:

- A header comment explaining **why** the change exists (constraint,
  ticket, incident).
- A `-- ROLLBACK:` block with the exact undo SQL.
- `NOTIFY pgrst, 'reload schema';` at the end if you added/changed a
  table, function, or RPC the API consumes.

Numeric prefix is `YYYYMMDDNNNNNN` so files sort in apply order. Use
the next free number for the day; don't gap-fill earlier numbers.

### Adding an RPC

Read [`memory/feedback_security_definer_smoke_tests.md`](../.claude/projects/...) — short version:
when a `SECURITY DEFINER` RPC is gated by `has_permission(...)`, also
allow `session_user IN ('postgres', 'supabase_admin', 'service_role')`
so the Supabase SQL editor can smoke-test it. Use `session_user`,
**not** `current_user` — `current_user` rewrites to the function owner
inside SECURITY DEFINER and won't help.

Standard gate template:

```sql
IF NOT (
  public.has_permission('<perm>')
  OR session_user IN ('postgres', 'supabase_admin', 'service_role')
) THEN
  RAISE EXCEPTION 'permission denied: <perm> required'
    USING ERRCODE = '42501';
END IF;
```

---

## Server endpoints

Every endpoint that mutates data goes through:

```
defineApiHandler({ body: zodSchema, auth: 'required', handler: async (...) => {...} })
```

Conventions:

- Validate with Zod at the boundary. No raw `getQuery` / `readBody`
  consumed without a schema.
- Reads scoped to one entity should live in `server/repositories/*.repo.ts`.
  The repo co-locates CRUD + `logActivity` + `notify` so handlers stay
  short.
- Audit every mutation via `logActivity({ event, action, entity, ... })`.
  Never insert directly into `public.activities` — the
  `log_activity` RPC stamps `user_id` from `auth.uid()` server-side,
  which means callers can't lie about whose action it was.

### Audit action naming

Dotted `entity.verb`. The frontend `EVENT_CONFIG` keys off these strings;
keep the prefix matching `entity` so a missing config entry can fall
back to a generic `"<entity>: <verb>"` label.

```
listing.created
listing.updated
listing.archived
listing.legacy_reconciled
contact.created
inquiry.received
verification.approved
webhook.subscribed
```

When you add a new verb, also extend `AuditAction` in `server/utils/audit.ts`
and the `EVENT_CONFIG` map in `app/components/timeline/eventConfig.ts`
(label + color + optional `meta` extractor).

### Service-role allowlist

The userportal allows direct service-role usage in **only** these places:

1. `server/api/public/inquiries/index.post.ts` — anon write needs to bypass RLS
2. `server/api/public/saved-searches/index.post.ts` — same
3. `server/api/admin/listings/ingest.post.ts` — bulk upsert
4. `server/api/admin/broadcasts.post.ts` — fanout
5. `server/utils/notifications.ts` — fanout to recipient regardless of caller
6. `server/utils/webhooks.ts` — outbound dispatcher

If you find yourself reaching for `getServerSupabaseAdmin()` outside of
these, **stop and ask**. The right answer is almost always to write the
endpoint to use the request-scoped `serverSupabaseClient(event)` so RLS
applies, and to add the policy / permission catalog entry that lets the
caller through.

### Promise-rejection discipline

**Never `void <promise>`** in this codebase. `void` evaluates the
expression and discards the value, but does not catch the rejection —
async functions wrap synchronous throws in rejected promises, so a
`void X(...)` that internally rejects becomes an unhandled rejection
at process scope. Nitro logs that as `[request error] [unhandled]`
and (depending on Node config) can cut the request connection.

Always use `.catch(...)`:

```ts
// BAD
void dispatchWebhook('event', payload)

// GOOD
dispatchWebhook('event', payload).catch((err: unknown) => {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err), op: '<scope>' },
    '<scope>_threw',
  )
})
```

If you actually want to wait for the result, `await` it.

---

## Common traps

These have all bitten this codebase recently. If your endpoint is
behaving weirdly, check these first.

### `activities.user_id` vs `notifications.actor_user_id`

`public.activities` uses `user_id` for the actor (migration `20260429000006`).
`public.notifications` uses `actor_user_id` (migration `20260501000009`).
Same concept, different column name. Selecting `actor_user_id` from
`activities` 500's the endpoint silently — observed in production with
the dashboard activity feed.

### Orphan `listings.created_by` UUIDs

Many `listings.created_by` values point at UUIDs with no matching
`profiles` row (legacy data, deleted users, ingested feeds). Code that
copies `created_by` into another table's FK column **must** preflight:

```ts
let assignedUserId: string | null = listing.created_by ?? null
if (assignedUserId) {
  const { data: profileExists } = await admin
    .from('profiles').select('id').eq('id', assignedUserId).maybeSingle()
  if (!profileExists) assignedUserId = null
}
```

The long-term fix is the Reconcile admin tab; writes can't wait for it
to finish.

### View column-position invariants

`CREATE OR REPLACE VIEW` only works if the column count + position +
type are unchanged. If you need to add a column **in the middle**, you
must `DROP VIEW … CASCADE` and recreate. Adding to the end is fine.
Position-based `RETURN QUERY` mappings in plpgsql are unaffected by
column order in callers, but any consumer that does `SELECT * FROM v`
into a typed row will silently shift if you reorder.

### PostGIS schema resolution

PostGIS lives in the `extensions` schema on Supabase, not `public`.
Functions that reference `geometry` must include it in `search_path`:

```sql
CREATE FUNCTION ... SET search_path = public, extensions ...
```

A missing `extensions` here produces a misleading `42704: type
"geometry" does not exist` even though PostGIS is installed.

### `RAISE NOTICE` doesn't abort migrations

Inside a `DO $$ ... $$` block, `RAISE NOTICE` followed by `RETURN` exits
**only the DO block**. Subsequent `CREATE FUNCTION` statements in the
migration still run. Use `RAISE EXCEPTION` if you need the migration to
abort entirely.

---

## Testing

```bash
pnpm test             # default: pure-fn tests, no DB needed
pnpm test tests/rls/  # RLS suite — requires SUPABASE_TEST_PROJECT=1 env, see docs/RLS_TESTS.md
```

The RLS harness creates and deletes auth users — never point it at
production. The two-flag opt-in (`SUPABASE_TEST_PROJECT=1` +
`SUPABASE_TEST_PROJECT_HOSTED=1` if hosted) is intentional friction.

For UI work, **start the dev server and use the feature in a browser
before reporting the task done.** Type checking and the test suite
verify code correctness, not feature correctness. If you can't test
the UI (e.g., headless CI), say so explicitly in the PR rather than
claiming success.

---

## Pull requests

- One topic per PR. If a refactor is incidental to the bug you're
  fixing, split it.
- New columns / tables need a `-- ROLLBACK:` block in the migration.
- Mutations need an audit log entry. No exceptions.
- Public endpoints need rate limiting via `enforceRateLimit` (see
  `server/utils/rate-limit.ts`).
- The website fetches listing data via the anon-safe view, **not**
  the underlying tables. If you're adding a column the website needs,
  extend the view and the public column allowlist
  (`websiteo/server/utils/listingsApi.ts:LISTINGS_PUBLIC_COLS`),
  not the underlying table read.
