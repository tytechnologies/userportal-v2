# Housing Interactive HQ — Userportal Status Report

**Snapshot date:** 2026-05-08
**Audience:** Management / launch-readiness review

---

## Executive summary

- **MLS / CRM core is production-ready.** Listings, contacts, deals,
  inquiries, tasks, document drafts, the public marketplace surface,
  admin tools, and ops observability are all shipping behind a clean
  design system.
- **Property-management + Philippine tax-compliance stack is
  substantially built** (units, leases, owners, tenants, maintenance,
  rent dues, accounting, BIR 2306/2307, EIS submissions, withholding
  tax) — heavier on backend than UI; needs a focused QA / acceptance
  pass.
- **139 database migrations**, **393 server endpoints**, **83
  application pages**, **0 design-token violations** across 343
  files, and a **CI guard + RLS test harness** are in place.
- **Three concrete launch blockers exist** (listing modal crash,
  broken test runner, no email provider). All small / scoped fixes;
  none are architectural.

---

## What's shipped & production-ready

### MLS + CRM core
- Listings, contacts, deals, inquiries, tasks, documents — all on
  the redesigned UI primitives
- Featured-listings curation deck, archives, outdated-listing
  surface, listing change-history drawer
- Saved searches (server side; digest worker stamps
  `last_digest_sent_at`)
- Notifications inbox + dashboard widgets
- Audit / activity coverage standardized across all entities
  (`log_activity` RPC; service-role-safe; audit-by-default
  repository pattern)

### Public marketplace (`websiteo/`)
- Public listing detail with anon-safe view (`public_listing_details`)
- Sort dropdown (Most recent / Recommended / Highest quality /
  Most trusted brokers / Fast-moving / Undervalued / Luxury) with
  server-enforced allowlist
- Layout reorder — listings above filters/SEO copy on category pages
- "Just listed" / "Price changed" badges (7-day windows)
- 301 canonical redirects for merged duplicate listings (SEO
  equity preserved)
- Public `/agent/[slug]` profile pages with JSON-LD schema +
  sitemap

### Admin / operations
- `/admin` shell with 17 grouped tabs (Identity & Access / Data
  Operations / Moderation / Infrastructure)
- `/admin/operations` health dashboard — overview cards, alert
  feed, time-series charts, **DB storage growth panel** (24h / 7d
  byte deltas), schema-drift monitor, per-domain health panels,
  admin-tunable alert thresholds
- Verifications queue, listing duplicate detection + merge
  tooling, broker import pipeline (CSV → invitations), listing
  import pipeline (CSV → staged review → image ingest queue)
- Webhook subscriptions with HMAC-signed delivery, auto-disable
  after 10 failures, 30s auto-refresh during retry chains
- Operations security: rate limiting (atomic `check_rate_limit`
  RPC), service-role allowlist (6 sanctioned call sites;
  documented), SSRF guard on outbound webhooks
- Reconcile tab for legacy data cleanup

### Property management + Philippine tax compliance (newer, less battle-tested)
- **PM domain**: units & occupancy, leases, owners + tenants +
  statements, maintenance vendors + work orders, rent dues +
  charges, charge-due reminders, accounting (mig 53–60)
- **Billing & commercial**: self-serve onboarding, billing &
  payments, API keys + scopes, agreements (co-broker / referral),
  platform commission rules
- **PH tax filings**: BIR Form 2306 (creditable withholding tax
  cert), BIR Form 2307 (expanded WHT), BIR Sales Book, BIR
  Purchases EIS, EIS invoice submission with cancellation reasons
- **Security**: PII encryption helpers, encrypted vendor TINs (the
  only schema DROP in 139 migrations is plaintext TIN, replaced
  atomically by encrypted column), per-tenant platform settings,
  AI suggestions surface
- **Documentation**: 13 SMOKE_*.md test runbooks under `docs/`
  covering each B/C/M track

### Design system & developer tooling
- Token-based design language (shadcn-vue HSL CSS variables,
  dark-mode native, "Estate" editorial aesthetic in active
  rollout)
- 13 `Ui*` primitives + 3 `Admin*` shell primitives + Cmd+K
  command palette (33 commands)
- CI guard `pnpm check:tokens` enforces no raw colors (currently
  0 violations)
- RLS test harness (`tests/rls/`) — synthetic users at each role,
  opt-in via env, 3 concrete suites covering webhooks / legacy
  reconcile / inquiries
- Schema-governance contracts with drift dashboard
- CHANGELOG, CONTRIBUTING (operating contract + service-role
  allowlist + common traps), public API docs, MV refresh strategy
  doc, 13 smoke-test runbooks

---

## What's in progress (scoped, partial)

| Item | Status | Owner action needed |
|---|---|---|
| Userportal UI re-style ("Estate" aesthetic) | Dashboard slice shipped 2026-05-08; remaining 80+ pages will inherit token retune automatically but need page-level layout pass | Decide rollout cadence — full sweep vs. priority pages |
| Phase 6 listings index refresh | Deferred — 2,613-line file, requires simultaneous treatment of 7 child components | Schedule as a separate engagement |
| Detail page refactors (`contacts/[id]`, `deals/[id]`, `listings/[id]`, `document-drafts/*`) | Templates exist; 4 pages pending | Mechanical work, ~1 page/day |
| Public claim/registration UI for agents | Backend pipeline shipped; public-facing form pending | Design + spec for the claim flow |
| `listing_shares` + co-brokering UI on website | Backend complete; public surface pending | Same as above |
| Saved-search wiring on website | Backend digest worker runs daily; needs proxy endpoint and subscription form | Define endpoint contract |
| Drop legacy `*_legacy` quarantine columns | Blocked on Reconcile tab finishing the queue | Operator action — work the Reconcile tab to drain it |

---

## What's required for launch

### Blockers (must fix)
1. **Listing modal TDZ crash** — clicking "New listing" produces
   `ReferenceError: Cannot access 'p' before initialization`.
   Reproducible only in production-minified bundle; needs dev-mode
   stack trace to localize. *Fix size: small once isolated.*
2. **Vitest is broken** — missing peer dep `@vue/test-utils`. All
   9 unit suites fail to collect; RLS suite still works. *Fix:
   `pnpm add -D @vue/test-utils`.* One-line fix, but blocks
   regression coverage for everything else.
3. **No email provider** — Mailgun was removed; `sendEmail()` is a
   logging stub. Saved-search digests, broker invitations,
   notification delivery, market alerts all silently no-op for
   outbound email. *Fix: pick a provider (Postmark / SES /
   Resend), implement the stub, ~half-day of integration.*

### Should-fix before launch (non-blocking, but visible)
4. **`@supabase/supabase-js` missing as direct dep** — works at
   runtime via pnpm hoist; types don't resolve cleanly. *Fix:
   `pnpm add @supabase/supabase-js`.*
5. **~30 strict-mode TypeScript errors on the listings index** —
   runtime works; mostly missing type annotations on `ref({})`
   initializations. Mechanical to fix; bundle with the Phase 6
   refactor.
6. **~25 server-side strict-mode warnings** in
   `server/api/internal/*`, `aiProvider.ts`, `paymentSignatures.ts`,
   etc. — "possibly undefined" on URL params and Zod-parsed
   bodies. Mechanical.
7. **PM/Tax features need a QA pass.** Backend is built and
   migrations are clean, but the SMOKE_*.md runbooks haven't been
   walked against staging end-to-end recently. Recommend assigning
   one tester to walk each runbook before launch.
8. **CDN / image optimization deferred** — hot/cold-path image
   perf is acceptable but not optimized; real `srcset` for
   listing cards and LQIP for galleries are punted.
9. **F-5 Phase 2 (REVOKE on legacy `listing_details` MV)** — the
   anon-safe replacement view is shipping; the original MV still
   has its public read grant for safety. Pending an API-log audit
   before final REVOKE.

---

## Risks & watch list

- **Schema drift on production DB.** Older migrations not all
  applied historically; new migrations now `information_schema`-
  check before FK'ing existing tables. Drift dashboard at
  `/admin/operations` is the source of truth — currently healthy
  but worth monitoring through migrations 50+ rollout.
- **Image ingest is best-effort.** Sharp normalization + S3 upload
  is a background cron with exponential-backoff retry. Transient
  S3 / format failures mark `failed_permanent`; covered by ops
  alerts but could create gaps in listing imagery during incidents.
- **Public market intelligence has sample-size thresholds**
  (≥10 city / ≥5 barangay) — sparse barangays return `null`
  rather than misleading numbers. Website renders this correctly
  today; future consumers must respect the contract.
- **Service-role usage is sanctioned in 6 places only.** Documented
  in `CONTRIBUTING.md`. Drift here is the highest-impact
  security-regression risk; covered by review discipline rather
  than CI today.
- **Email is silently a no-op.** Operational signal preserved
  (`last_digest_sent_at` stamped, saved-search matching runs) but
  no actual sends until a provider is wired. Until then, anything
  that reports "email sent" in the UI is misleading.

---

## Numbers

| Surface | Count |
|---|---|
| Database migrations | 139 (latest `20260508000001`) |
| Server API endpoints | 393 |
| Application pages | 83 |
| UI primitives | 13 `Ui*` + 3 `Admin*` shell |
| Cron jobs registered | 9 (MV refresh, digests, ingestion, ops snapshots, alerts) |
| Documentation files | 24 (incl. 13 SMOKE runbooks for B/C/M tracks) |
| CI workflows | 2 (`deployment.yaml`, `lint.yaml`) |
| Test files | 11 (5 unit + 3 RLS + 3 misc) — *runner currently broken, see blocker #2* |
| Design-token violations | 0 across 343 scanned files |

---

## Recommended path to launch

1. **Week 1 — Unblock**: fix vitest peer dep, listing modal TDZ,
   choose + wire email provider. Run one full QA pass through the
   SMOKE_*.md runbooks against staging.
2. **Week 2 — Polish**: detail-page refactors (4 pages),
   supabase-js dep, strict-mode error cleanup, ripple "Estate"
   aesthetic to top-10 most-trafficked pages.
3. **Week 3 — Public surfaces**: agent claim/registration UI,
   listing-shares public surface, saved-search wiring on website.
   CDN/image optimization decision.
4. **Launch gates**: token guard at 0 (✅ today), RLS suite green
   against staging, all SMOKE runbooks signed off, email provider
   sending in production, ops dashboard showing healthy across all
   6 domains for 7 consecutive days.

**Bottom line for management:** this is not a "build" problem
anymore. It's a finishing problem — three small fixes unblock the
launch path, and the remaining work is visible polish + QA
validation, not architecture.
