# Integration test suite

Vitest suite that exercises the portal's HTTP + DB surfaces. Env-
gated so they only fire when explicitly targeting a Supabase project
+ a running portal instance — CI defaults skip them all.

## Running

```bash
pnpm test                         # only unit tests (env-gated suites skip)
SUPABASE_TEST_PROJECT=1 \
  SUPABASE_URL=… SUPABASE_SERVICE_KEY=… \
  PORTAL_BASE_URL=http://localhost:3002 \
  INTERNAL_CRON_SECRET=… \
  PORTAL_TEST_ADMIN_JWT=… \
  PORTAL_TEST_AGENT_JWT=… \
  PORTAL_TEST_MEMBER_JWT=… \
  pnpm test:run                   # integration suites fire
```

## Env vars

| Var | Used by | Required for |
|---|---|---|
| `SUPABASE_TEST_PROJECT=1` | every integration test | all |
| `SUPABASE_URL` | service-role DB queries | all |
| `SUPABASE_SERVICE_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | service-role DB queries | all |
| `PORTAL_BASE_URL` | HTTP-level tests | hybrid-search, admin-api-rbac, dashboard-scope, contacts-rbac |
| `INTERNAL_CRON_SECRET` | x-internal-secret auth | hybrid-search, saved-search-digest |
| `PORTAL_TEST_ADMIN_JWT` | admin-role probes | dashboard-scope, admin-api-rbac (positive case) |
| `PORTAL_TEST_AGENT_JWT` | agent-role probes | contacts-rbac, dashboard-scope |
| `PORTAL_TEST_MEMBER_JWT` | member-role probes | admin-api-rbac |

## Test files

| File | What it asserts |
|---|---|
| `canonical-dedup-merge.test.ts` | B-1/B-2 RPCs — elect_primary, merge, find_dup_candidates |
| `hybrid-search.test.ts` | /api/internal/live-search auth + shape; admin overview; admin-gate denies Members |
| `ticker.test.ts` | marketing_ticker_messages CHECK constraints + seed presence |
| `lead-routing.test.ts` | preview RPC + BEFORE INSERT trigger + rule routing |
| `dashboard-scope.test.ts` | Admin vs agent role scoping on stats, attention, listings-breakdown, trend |
| `contacts-rbac.test.ts` | P0 regression — POST persists, owner is auth.uid(), PATCH/DELETE work, strict() rejects unknown keys |
| `admin-api-rbac.test.ts` | Walks `/api/admin/*` and asserts every endpoint returns 401/403 to a Member JWT |
| `cron-pipelines.test.ts` | Late-fee, tenant statement, owner statement — table shape + RPC resolves + cron registered |
| `saved-search-digest.test.ts` | Saved-search tables, due-for-digest RPC, run-digest endpoint auth + dry-run, cron registered |
| `inspections.test.ts` | inspections + inspection_findings tables; complete_inspection happy path; charge_damages no-op |
| `getImageThumbnail.test.js` | e2e Nuxt boot — gated separately, slower |
| `testUpdateListings.test.js` | DANGEROUS — mutates listing id=1; gated separately |

## Adding a test

Match the existing pattern:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const SHOULD_RUN = process.env.SUPABASE_TEST_PROJECT === '1' && /* deps */

describe.skipIf(!SHOULD_RUN)('feature name', () => {
  beforeAll(() => { /* set up client */ })
  afterAll(async () => { /* clean up fixtures */ })
  it('does the thing', async () => { /* … */ })
})
```

Naming: `{surface}.test.ts` for new pipelines, `{bug-class}.test.ts`
for regression armor.

## Cleanup

Each test cleans its own fixtures in `afterAll`. Markers use a
timestamp suffix (`smoke-${Date.now()}`) so concurrent runs don't
collide. Manual cleanup if a test crashes mid-run:

```sql
-- contacts
DELETE FROM public.contacts WHERE full_name LIKE 'smoke-%';
-- lead routing rules
DELETE FROM public.lead_routing_rules WHERE name LIKE 'smoke-rule-%';
-- ticker fixtures
DELETE FROM public.marketing_ticker_messages WHERE notes LIKE 'smoke-test-ticker-%';
-- search-events
DELETE FROM public.search_events WHERE query_hash LIKE 'smoke-test-%';
-- inspections fixtures (synthetic 'periodic' kind + 'Smoke kitchen' findings)
DELETE FROM public.inspection_findings WHERE area = 'Smoke kitchen';
DELETE FROM public.inspections WHERE id IN (
  SELECT i.id FROM public.inspections i
  LEFT JOIN public.inspection_findings f ON f.inspection_id = i.id
  WHERE f.id IS NULL AND i.completed_at IS NULL
    AND i.scheduled_for > now() - interval '1 hour'
);
```
