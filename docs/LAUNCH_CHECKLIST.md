# Soft-launch checklist — Housing Interactive user portal

A single-page runbook for the operator who walks through staging before
flipping production for this week's soft launch. Work top-to-bottom;
don't skip steps.

Target build: `v2026.05.11-phase-a` and later. Verify with:
```sh
git describe --tags
```

---

## 1. Migration readiness

Apply outstanding migrations on staging FIRST. Production must never
be the first time a migration runs.

```sh
# From a linked clone:
supabase db push           # applies anything in supabase/migrations/

# Confirm parity:
pnpm check:migrations      # should print "Pending: 0"
```

**Migrations that MUST be applied** for this branch to work:
- `20260509000004` — doc system phase 1 (canonical types)
- `20260509000005` — doc system phase 2 (versioning + approvals)
- `20260509000006` — doc system phase 3 (signature placeholders)
- `20260509000007` — invoices past-due orphan fix
- `20260509000008` — transaction_rooms RLS recursion fix
- `20260511000001_fix_deal_stage_history_trigger_rls`
- `20260511000001_tasks_metadata_column`
- `20260511000002_listings_attributes_column` — wizard writes here
- `20260511000002_split_deal_stage_history_trigger`
- `20260511000003_cities_barangays_open_select_to_anon` — wizard needs this for the locality picker

If staging applies cleanly, repeat on production AFTER you complete steps 2-5 below.

---

## 2. Build + dependency sanity

```sh
pnpm install --frozen-lockfile
pnpm build
```

Both must complete without errors. The trailing `EBUSY` on `rmdir .output`
is fine (it's the running server holding the directory); the actual
client+server build logs must say `built in Xs` with no `ERROR` line.

Watch for:
- `Could not resolve "..."` — missing module / wrong import path
- `[vue/compiler-sfc]` — template parse error (most often `{{ ... }}`
  literal collisions)
- `RollupError` — usually a missing file referenced by a `defineAsyncComponent`

---

## 3. Smoke tests

### Automated (Playwright)

```sh
pnpm e2e:install      # one-time, ~150 MB chromium download
pnpm dev              # in another terminal
pnpm e2e              # against http://localhost:3002
```

All three specs must pass:
- `smoke-auth` — login → dashboard, admin section visible
- `smoke-listing` — wizard mounts without 4xx
- `smoke-documents` — doc wizard, 3 modes visible, no Library button

If any spec fails, fix or scope-out before launch. The cost of
shipping a broken auth flow is higher than the cost of a one-day slip.

### Manual broker walkthrough

Run as the dev admin (`admin@admin.com` / `administrator`). Do every
step against staging. Mark ✓ as you pass.

```
[ ] /login → email + password → land on /dashboard
[ ] Sidebar shows Administration section
[ ] Dashboard counts render (active listings, new inquiries 7d, open tasks, pending shares)
[ ] /listings → grid view loads, at least one card renders
[ ] /listings → toggle "My properties" vs "All properties" both load
[ ] /listings/new → wizard step 1, pick category, advance to step 2
[ ] /listings/new → step 2 City + Barangay dropdowns populate
[ ] /listings/new → step 4 Amenity chips render (after picking category)
[ ] /listings/new → step 5 image picker accepts a file
[ ] /listings/new → step 6 Review summary shows entered data
[ ] /listings/[id] → existing listing detail page loads
[ ] /inquiries → inquiry list loads (or empty state if none)
[ ] /inquiries → convert an inquiry → new deal lands on /deals/[id]
[ ] /deals → pipeline kanban view loads
[ ] /deals/[id] → buyer/seller contact cards render
[ ] /deals/[id] → New Document button opens wizard
[ ] Wizard → Generate from Prompt mode → submit → draft created
[ ] Draft editor renders the AI body
[ ] /document-drafts → recent draft visible in the list
[ ] /viewings → calendar/list of upcoming viewings
[ ] /contacts → list loads, click into a contact → detail renders
[ ] /admin/operations → loads (admin only)
[ ] /admin/document-templates → admin template list loads
[ ] Sign out → redirects to /login
```

If anything red, screenshot + file in your launch-bugs tracker. Do
not flip prod with reds.

---

## 4. Environment variable check (production target)

Confirm each is set on the prod host (Vercel / Render / whatever):

| Var | Source | Why |
|---|---|---|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API | Frontend + server use it |
| `SUPABASE_KEY` | Supabase → API → `anon` public key | Browser auth |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`) | Supabase → API → `service_role` | Server-only; bypasses RLS for the audit-log writer + AI config read |
| `NUXT_SUPABASE_SECRET_KEY` (optional) | New JWT-signing secret if using v2 secret keys | Module reads in this order: `NUXT_SUPABASE_SECRET_KEY` > `SUPABASE_SECRET_KEY` > `SUPABASE_SERVICE_ROLE_KEY` |
| `AI_GENERATION_ENDPOINT` | Anthropic, OpenAI-compat, or Ollama tunnel | AI doc generation; can also live in `platform_settings.ai_generation` |
| `AI_GENERATION_API_KEY` | Provider | Same |
| `AI_GENERATION_HEADER_STYLE` | `bearer` / `anthropic` / `none` | Auth header shape |
| `AI_GENERATION_BODY_STYLE` | `anthropic` / `ollama` | Request body shape |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `AWS_REGION` | AWS console | Listing image upload + thumbnail flow |
| `PUBLIC_APP_URL` | https://userportal.housinginteractive.com.ph | Email links + invitation tokens |
| `WEBSITE_URL` | https://housinginteractive.com.ph | Public cross-domain redirects |
| `PUBLIC_INQUIRIES_DISABLED` | `'true'` / `'false'` | Kill-switch for public form intake |

---

## 5. eSign sandbox verify (if enabled)

Skip if eSign is not part of this launch. Otherwise:

1. Open `/admin/esign-settings` → confirm Integration Key, User ID, Base URI, private key are filled.
2. Hit "Test JWT" — if `consent_required`, click the consent URL once.
3. From any draft: New Document → upload a PDF or generate → Send for signature → fill recipient email → Send.
4. Confirm the envelope appears under `/document-drafts/<id>` → Envelopes tab with status `sent`.
5. From the recipient inbox, complete the signing flow on the sandbox.
6. Confirm webhook fires (server log: `docusign_envelope_signed`).

If the webhook doesn't fire: confirm the webhook URL in the DocuSign admin matches `PUBLIC_APP_URL/api/webhooks/docusign`.

---

## 6. Final pre-flip checks

```
[ ] pnpm build clean
[ ] pnpm check:migrations against PROD → Pending: 0
[ ] git log shows the tag v2026.05.11-phase-a (or later) at HEAD
[ ] Sentry/log destination receives events from staging
[ ] Backup of prod DB taken within last 24h
[ ] Rollback plan written down (see below)
```

---

## 7. Rollback plan

If something breaks after flipping prod:

1. **Code rollback** (~1 minute): redeploy the previous tag.
   ```sh
   git checkout v2026.05.04-pre-launch    # or whatever the last green tag was
   # trigger the deploy on your host
   ```

2. **Migration rollback**: AVOID. Most of this branch's migrations are
   additive (new tables, new columns, new policies). The few that
   modify existing structures are documented inline with a ROLLBACK
   block. If you truly need to roll back schema:
   ```sh
   # Get the inverse SQL from the migration's ROLLBACK comment.
   # Run via Supabase SQL editor. NEVER drop a column that any other
   # commit still reads from.
   ```

3. **Auth-cookie purge**: if the bug looks auth-shaped (401 wave,
   `eq.undefined` in PostgREST URLs), bump `cookieName` in nuxt.config
   and redeploy. Forces every browser to re-login on the new cookie.

4. **Incident comms**: post to #launch with `STATUS:` + symptoms +
   ETA. Brokers panic less when they know an engineer is on it.

---

## 8. Post-launch (within 24h)

Once stable:
- Tag `v2026.05.{date}-soft-launch`.
- Open Phase B follow-ups: NewForm decommission, /app/* URL prefix,
  materialized dashboard views. See the audit doc for full Phase B
  scope.
- Pull the trigger on broker onboarding — comms, training, etc.
