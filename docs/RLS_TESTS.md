# RLS policy tests

End-to-end tests that exercise Postgres row-level security policies by
signing into a real Supabase project as synthetic users at each role
(admin / manager / agent_a / agent_b) and asserting that each
policy lets the right roles in and rejects the rest.

## Why

Mocked Supabase clients tell us nothing — RLS lives inside Postgres.
A test that imports a function and stubs the DB will pass even if the
underlying policy is broken. These tests connect to a real DB and
exercise the policies in situ.

## Why opt-in (not part of the default `pnpm test`)

The harness creates and deletes auth users + writes test rows. Pointing
it at production would corrupt data and lock out real users. The suite
is silently skipped unless **all** of these env vars are set:

```
SUPABASE_TEST_PROJECT=1                     # confirmation flag
SUPABASE_URL=http://127.0.0.1:54321         # local Supabase URL
SUPABASE_ANON_KEY=eyJ...                    # anon key
SUPABASE_SERVICE_ROLE_KEY=eyJ...            # service-role key
```

If `SUPABASE_TEST_PROJECT=1` is set but the URL looks like a hosted
Supabase project (`*.supabase.co`), the harness refuses to run unless
you ALSO set `SUPABASE_TEST_PROJECT_HOSTED=1` — a second knob to
acknowledge "yes, I'm pointing at a hosted (non-prod) project."

## Local quick-start

```bash
# Spin up local Supabase (one-time install: brew install supabase/tap/supabase)
supabase start
# Apply migrations to the local DB
supabase db reset
# Note the URL + keys printed by `supabase start`

# Then:
SUPABASE_TEST_PROJECT=1 \
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_ANON_KEY=eyJhbGc... \
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
pnpm test tests/rls/
```

## What's covered today

| File | Asserts |
|---|---|
| `tests/rls/webhook-subscriptions.test.ts` | admin full CRUD; agent + manager denied select/insert; webhook_deliveries denied to agent |
| `tests/rls/inquiries.test.ts` | assigned agent sees own inquiry; other agent does not; authenticated cannot direct-insert (must go through server) |
| `tests/rls/legacy-reconcile.test.ts` | admin can call `legacy_creators_summary`; agent + manager rejected with 42501; apply RPC also gated |

## Adding a new suite

1. Pick a table or RPC whose RLS policy you want to lock down.
2. Create `tests/rls/<name>.test.ts`.
3. Use the harness:

   ```ts
   import { rlsEnvOrSkip } from './env'
   import { setupRlsContext, expectRlsDenied, expectNoRows } from './harness'

   const env = rlsEnvOrSkip()

   describe.skipIf(!env)('RLS · my_table', () => {
     const runId = `mytable_${Date.now().toString(36)}`
     let ctx
     beforeAll(async () => {
       if (!env) return
       ctx = await setupRlsContext(env, { runId })
     }, 60_000)
     afterAll(async () => { if (ctx) await ctx.cleanup() })

     it('positive case', async () => { ... })
     it('negative case', async () => {
       await expectRlsDenied(
         (client as any).from('my_table').insert({ ... }).select(),
         'agent my_table insert',
       )
     })
   })
   ```

4. The four available roles are `admin`, `manager`, `agent_a`, `agent_b`.
   `agent_b` is intentionally distinct from `agent_a` so cross-agent
   visibility tests have a real "other agent" identity to use.

## Cleanup

`ctx.cleanup()` calls `auth.admin.deleteUser()` for each test user; the
profile rows cascade via the FK in the auth → profiles trigger. Test
rows tagged with the runId in their text fields can be found later if
a suite crashed before cleanup ran:

```sql
DELETE FROM public.listings WHERE title LIKE '%RLS test listing%';
DELETE FROM public.profiles WHERE full_name LIKE 'RLS Test %';
-- auth users:
SELECT id, email FROM auth.users WHERE email LIKE 'rls+%@example.test';
```

## Caveats

- **Test isolation** assumes each `runId` is unique. The harness uses a
  base36 timestamp, which is unique per millisecond per worker. If you
  run two suites at the exact same ms in the same project, collide.
  In practice, never seen.
- **Auth user creation** is the slow part — about 200ms × 4 users +
  profile upserts. Each suite pays this cost once via `beforeAll`.
- **The harness assumes a `profiles.role` column** exists (added in
  migration `20260429000006_phase4_rbac_audit`). On older snapshots,
  the upsert will fail with a clear message.
