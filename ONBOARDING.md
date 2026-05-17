# Housing Interactive — User Portal onboarding

Welcome. This guide gets a new operator, admin, or engineer productive on the userportal in under an hour. If you're trying to use the public-facing website, that's a separate codebase (`websiteo/`).

---

## What this is

The **user portal** is the operations + admin interface for Housing Interactive — a Philippine real-estate marketplace + property-management platform. It's the back-of-house side of three repos that share one Supabase database:

| Repo | Role | Default port |
|---|---|---|
| `db-main-reference/` | **Canonical schema** — source of truth. Read-only reference. **Never modify.** |
| `userportal-v2/` | **Portal** — Nuxt 4 + Supabase. CRM, admin tools, ingest pipelines. | 3002 |
| `websiteo/` | **Public website** — Nuxt 4 + Supabase anon. Browse, search, inquire. | 3001 |

The portal is what brokers, agents, ops, and finance use day-to-day. The website is what buyers, renters, and visitors see.

---

## Who uses it

Different roles get different surfaces. The portal's RBAC enforces this via Supabase RLS + the `has_permission('<scope>')` function.

| Role | What they do | Where they land |
|---|---|---|
| **Agent / Broker** | Publish listings, manage their inquiries, track deals | `/dashboard` → personalized listings + pipeline |
| **Team admin** | Manage their org's users, listings, deals, statements | `/admin` (org-scoped views) |
| **Platform admin** | Cross-org operations, schema governance, broadcasts | `/admin` (full surfaces) + `/admin/operations` |
| **Finance / ops** | Billing, BIR submissions, statements, accounting | `/admin/accounting`, `/admin/eis-submissions` |
| **Tenant** (read-only) | View own statements, sign inspections | `/tenant` (gated by one-time invitation token) |

---

## Get it running locally

### Prerequisites

- Node.js 20+ and `pnpm` 9+
- Supabase project (URL + anon + service-role keys)
- AWS S3 bucket for listing images
- (Optional) Tavily API key, Resend API key, Typesense host

### Steps

```powershell
# 1. Install
pnpm install

# 2. Copy the env template
cp .env.example .env

# 3. Fill in REQUIRED values (see "Environment variables" below)

# 4. Start the dev server
pnpm dev
# → http://localhost:3002
```

If you see `[server/utils/supabase] Missing SUPABASE_URL or SUPABASE_KEY` in the console, your `.env` isn't being read — restart the dev server after editing `.env`.

### Environment variables (the must-haves)

`.env.example` documents every variable. Bare minimum to get the portal to boot:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service-role key>

INTERNAL_CRON_SECRET=<openssl rand -hex 32>
INTERNAL_PORTAL_URL=http://localhost:3002
USERPORTAL_URL=http://localhost:3002
WEBSITE_URL=http://localhost:3001

AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-southeast-1
S3_BUCKET_NAME=hi-images-staging

GOOGLE_MAPS_API_KEY=...        # client-side, referrer-restricted
GOOGLE_MAPS_SERVER_KEY=...     # server-side, no referrer restriction
```

Optional (per feature):
- `TAVILY_API_KEY` → hybrid live-search external arm
- `RESEND_API_KEY` + `RESEND_FROM_EMAIL` → outbound email (digests, inquiries, invitations)
- `TYPESENSE_HOST` + `TYPESENSE_API_KEY` → search engine cutover (B-4)
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` → AI listing suggestions + document generation

The same `INTERNAL_CRON_SECRET` MUST be set in BOTH the portal `.env` AND the website `.env`, AND in `internal_config.digest_cron_secret` for pg_cron to work.

---

## The 10-minute tour

### 1. Dashboard (`/dashboard`)
Per-user landing. For agents: personal listings + active deals + recent activity. For admins: also pipeline alerts + system status strip.

### 2. Listings (`/listings`)
The MLS-like inventory view. Filter, search, bulk actions. Click any row → `/listings/[id]` for the detail / edit flow. Add a new one via the **Create** dropdown in the top nav (or `/listings/new`).

### 3. Inquiries (`/inquiries`)
CRM view of buyer/renter inquiries from the website. Auto-routed via the lead-routing rules engine. Filter by assignee, status, source.

### 4. Tasks (`/tasks`)
Personal + team task list. Tasks are created automatically by deal workflows (see `/admin/workflow-templates`) and manually by operators.

### 5. Deals (`/deals`)
Pipeline view of in-flight transactions. Stages, attached docs, signed agreements, commission splits.

### 6. Admin shell (`/admin`)
The operations hub. Tabbed groups:
- **Identity & Access** — users, roles, organizations, broker invitations
- **Data Operations** — broker imports, listing imports, pending listings, reconcile, **duplicates** (the dedup review queue)
- **Moderation & Review** — triage, moderation, activity
- **Property Management** — leases, units, owners, vendors, maintenance, work orders
- **Billing & Revenue** — charges, statements, platform fees, EIS submissions, BIR forms 2306/2307
- **Infrastructure** — webhooks, sources, broadcast, digest preview, AI suggestions, audit-log export, platform settings, **Operations** (system health), **Live search** (hybrid orchestrator), **Marketing ticker**

Pages also reachable via the **command palette** — press <kbd>Cmd</kbd>+<kbd>K</kbd> (Mac) or <kbd>Ctrl</kbd>+<kbd>K</kbd> (Win/Linux) and type. Two-key chords: <kbd>g</kbd> then a letter (e.g. `g d` for dashboard, `g o` for operations).

### 7. Operations dashboard (`/admin/operations`)
The single pane of glass for ops. Schema drift, pipeline alerts, storage, MV refresh state, search-index queue depth, source health.

---

## Common workflows

### Publish a listing
1. Click **Create → New listing** (top nav) or visit `/listings/new`.
2. Wizard walks through property type → building → unit details → pricing → photos → review.
3. **Property type slugs** are canonical — pick from the dropdown, never type. Same for **condition**.
4. Upload photos. The wizard awaits the S3 upload before redirect (since the 2026-05-14 fix), so the gallery shows immediately.
5. Submit. The listing is live and indexed.

### Route a new inquiry
1. Buyer fills the inquiry form on the website's listing detail page.
2. The website proxies to portal `/api/public/inquiries`.
3. A BEFORE INSERT trigger consults `lead_routing_rules` and sets `assigned_user_id` if any rule matches.
4. If no rule matches, falls back to the listing's primary contact.
5. Assignee gets an email (if `RESEND_API_KEY` is set) + the row appears in their `/inquiries` queue.

### Resolve a duplicate property
1. A nightly cron runs `find_listing_duplicate_candidates()` — finds pairs by GPS proximity, address trigram, within-building, etc.
2. Pairs land in `/admin/duplicates` with confidence + signals.
3. Operator picks one of three verdicts:
   - **Distinct** — false positive
   - **Merge as same** — variants of the same property → close the candidate
   - **Reparent variant** — listing moves under a different property
4. Variants are visible at `/admin/properties/[id]`.

### Generate tenant statements
1. Configure a `tenant_statement_policy` per property/lease (cadence, day-of-month).
2. Daily 05:00 UTC cron runs `generate_tenant_statements()`.
3. Statement rows generated. Open in `/admin/tenant-statements/[id]` for detail + PDF download.

---

## Where to find more

### Internal docs (`docs/`)

| File | What it covers |
|---|---|
| `docs/design-system.md` | Token + primitive composition rules. Authoritative spec |
| `docs/design-tokens.md` | The CSS-var palette |
| `docs/PUBLIC_API.md` | Anon-facing surface (what the website hits) |
| `docs/PUBLIC_DATA_SURFACE.md` | What the anon Supabase key can read |
| `docs/RLS_TESTS.md` | Authoritative RLS spec per table |
| `docs/SMOKE_TESTS.md` | Smoke test catalog |
| `docs/MV_REFRESH_STRATEGY.md` | When and how MVs refresh |
| `docs/LAUNCH_CHECKLIST.md` | Pre-launch gate |
| `docs/DEPENDENCIES.md` | Critical npm deps + their purpose |
| `docs/eis-submitter-runbook.md` | BIR / EIS submitter runbook |
| `docs/pipelines/` | Pipeline operations guides (hybrid search, ingest, statements, etc.) |
| `CONTRIBUTING.md` | Operating contract, service-role allowlist, commit conventions |
| `CHANGELOG.md` | Shipped log |
| `LAUNCH_STATUS.md` | Pre-launch readiness summary |

### Pipeline ops cheat sheet (`docs/pipelines/`)

If you're investigating an async / cron / cross-service flow, start here:

- **hybrid-live-search.md** — Zillow-style internal+external orchestrator
- **aggregation-ingest.md** — listings_raw → normalized → listings
- **search-indexing.md** — Typesense queue + worker
- **marketing-ticker.md** — live banner below the website nav
- **lead-routing.md** — rules-first inquiry assignment
- **saved-search-digest.md** — daily email digests
- **inquiry-pipeline.md** — public form → CRM
- **image-upload.md** — wizard → S3 → gallery
- **late-fee-cron.md** — 04:00 UTC past-due assessment
- **tenant-statement-aggregation.md** — 05:00 UTC tenant statements
- **owner-statement-aggregation.md** — owner-side statements + PDF
- **inspection-workflow.md** — inspections + tenant signing + damages
- **listing-syndication.md** — outbound JSON feeds (coming)
- **self-serve-brokerage-onboarding.md** — broker org bootstrap (coming)

Each guide has the same shape: components → operate → smoke → failure modes → open work.

---

## How development works here

### Branching
- `launch-readiness-2026-05-08` is the current trunk for the portal.
- Feature work goes in `feat/<scope>-<feature>` branches.
- Migrations are date-prefixed (`YYYYMMDDXXXXXX_<name>.sql`) and **strictly additive** — no destructive changes to `db-main-reference/` tables.

### Database
- One Supabase project; the portal and website share it.
- Run migrations from Supabase Studio (SQL editor) or `supabase db push` if you have the CLI.
- Most operational state is in tables — `internal_config` for cron, `source_connectors` for hybrid search, `lead_routing_rules` for routing.

### Testing
- `pnpm test` — Vitest (smoke tests for RPCs, gated by `SUPABASE_TEST_PROJECT=1` for the ones that touch real Supabase).
- `pnpm typecheck` — surfaces strict-mode TS errors.
- `pnpm check:tokens` — design-token CI guard.
- `pnpm check:reference-drift` — verifies portal migrations don't violate `db-main-reference/` shape.
- `pnpm check:seed-drift` — compares production reference data against the root-dir `seed.sql` fixture.

### Workflows
- **New endpoint?** Drop in `server/api/<area>/<name>.<method>.ts`. Auto-routed by Nuxt.
- **New admin page?** Use the primitive recipe in `docs/design-system.md` — `AdminPageShell` + `UiPageHeader` + `UiCard` + `UiStatCard` + `UiBadge`. Reference: `/admin/lead-routing.vue`.
- **New migration?** Add to `supabase/migrations/`. Re-read `[[feedback-schema-preservation]]` rules.
- **Internal endpoint?** Auth via `x-internal-secret` header matching `INTERNAL_CRON_SECRET`. Use `timingSafeEqual`.

---

## Help & escalation

- **Slack** — `#housing-interactive` (engineering), `#housing-interactive-ops` (operations).
- **Issue tracker** — GitHub Issues on the relevant repo.
- **On-call rotation** — defined in PagerDuty (`housing-interactive` service).
- **Production access** — request via `#housing-interactive-ops`; reviewed daily.

---

## Quick links

- Portal repo: `https://github.com/Hi-Merkado/userportal-v2`
- Website repo: `https://github.com/Hi-Merkado/website-v2`
- Supabase project: <ops to fill in>
- AWS console: <ops to fill in>
- Resend dashboard: https://resend.com
- Tavily dashboard: https://app.tavily.com

Welcome aboard. Start with a `pnpm dev`, log in, click around `/admin` for ten minutes, then open the pipeline guide matching whatever you're about to touch.
