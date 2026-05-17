# Platform Update — 2026-05-07

Status update for management. Covers everything shipped today across
the userportal (admin/agent app) and websiteo (public marketplace),
backed by the shared Supabase project.

---

## TL;DR

- **13 database migrations** (mig 31 → 43) + supporting application
  code shipped against Phase A (Stabilization) and Phase B
  (Marketplace Completion).
- Major capability blocks added: **bulk broker + listing onboarding
  pipelines**, **MLS duplicate detection + merge tooling**, **public
  market & geo intelligence APIs**, **SEO-grade canonical redirects**,
  and **operational observability** (storage growth panel, ops alerts
  fix-up).
- Mailgun integration removed; email is now a no-op stub pending an
  email-provider decision.
- Public website re-ordered to surface listings above filters/SEO copy.
- Branch is clean and CI-stable. Migrations are additive only.

---

## What was built

### 1. Broker Onboarding Pipeline (mig 38, 41)

CSV-driven bulk onboarding of brokerage agents.

- **Admin uploads a CSV** of broker contacts. The system stages each
  row, dedupes within the batch, then either matches an existing
  profile or creates a `broker_invitations` row.
- **Invitation tokens** are generated per row; the admin can copy a
  shareable link or (eventually) trigger an email send. Email send
  state is tracked (`link_shared_at` / `email_sent_at` /
  `email_send_error`) so we know who has been contacted.
- **Acceptance flow** is auth-gated: a logged-in user whose email
  matches the invitation can accept, joining the org. No raw email
  trust — token + email-match double-check.

**Why it matters:** scales agent onboarding from 1-by-1 to dozens at
once with audit trail and dedupe protection.

### 2. Listing Bulk Onboarding Pipeline (mig 39, 40)

Same staged-import pattern, applied to listings.

- **Admin uploads listings CSV** with org_slug, broker_email,
  city_slug, barangay_slug, building_name, image URLs, etc.
- **Resolution chain** runs in SQL: matches the org → broker →
  city → barangay → building (with `pg_trgm` fuzzy match for
  building names within a city, threshold 0.7).
- Newly created listings start as **`is_online = false`** so the
  admin can review before publishing.
- **Image ingest queue**: a trigger automatically enqueues every
  image URL. A cron-driven internal endpoint (every 2 min)
  downloads each image, normalizes via Sharp (1600px JPEG main +
  635×423 thumbnail with attention crop), uploads to S3, and
  attaches it to the listing. Exponential-backoff retry policy.
- **Listing moderation surface** in the admin UI lets ops walk
  through pending listings before flipping `is_online`.

**Why it matters:** lets us bulk-import third-party / scraped /
partner listings with full image fidelity, without exposing
unreviewed inventory to the public site.

### 3. MLS Duplicate Detection + Merge (mig 37, 42)

Listings often arrive twice — partner feed + manual entry, or two
brokers re-listing the same unit. We now detect and resolve.

- **Detection RPC** (`find_listing_duplicate_candidates`) scores
  pairs by weighted signals: same broker (+20), floor area match
  (+30), price match (+25), bedrooms (+10), title trigram
  similarity (+10), geometry proximity (+5). Threshold = 50 to
  surface as a candidate.
- **Two crons run continuously** (nightly full scan + 30-min
  incremental) populating `listing_duplicate_candidates` for
  admin review.
- **Merge RPC** (`merge_listing_duplicate`) lets the admin
  pick a canonical winner and stamp the loser with
  `duplicate_of_id`, soft-deleting it. Idempotent and refuses
  chains (no merging an already-merged loser).
- **Public canonical redirect**: when a public visitor or crawler
  hits a merged loser's URL, the website returns a real **HTTP
  301** to the canonical's URL. SEO crawlers consolidate the
  page rank into the surviving listing.

**Why it matters:** keeps the public catalog clean (no embarrassing
side-by-side duplicates), and protects SEO equity when we merge.

### 4. Market Alerts + Watch Engine (mig 33, 36)

Users — buyers, sellers, agents — can subscribe to market signals.

- **`market_watches`** is a polymorphic subscription table
  (watch a city, a barangay, a building, a price band, a
  saved-search payload).
- **Worker RPC** (`evaluate_market_watches`) runs every 30 min,
  checks each watch against fresh listing/verification activity,
  and fires a dispatch via the existing `notify()` infrastructure.
- **Dedup ledger** (`market_alert_dispatches`) ensures the same
  signal doesn't fire twice in the cooldown window.

**Why it matters:** retention loop. Users get pinged when a unit
they care about hits the market or moves price.

### 5. Public Market & Geo Intelligence APIs (mig 32, 34, 35)

Anonymous-callable, sparse-data-aware analytics so the website can
publish authoritative market content.

- **`public_city_market_snapshot`** / **`public_barangay_market_snapshot`**:
  median price, inventory, velocity, verified-trust score, with
  minimum-sample thresholds (≥10 listings city / ≥5 barangay) so
  thin areas don't publish misleading numbers.
- **`public_market_index`**: rolled-up index for market dashboards.
- **`public_heatmap_grid`**: configurable heatmap dispatcher with
  6 modes (inventory / trust / luxury / velocity / verified /
  hot-area), capped at 1500 cells per request.
- **`public_building_intelligence`**: per-building analytics
  (active listings, median per-sqm, broker mix).
- **`public_hot_area_summary`**: per-barangay scoring with
  within-city z-scores so we can rank "fastest-moving in Makati"
  vs. across-the-country noise.

**Why it matters:** unlocks SEO content, neighborhood guides, and
"X is up Y% this month" badges without exposing raw operator data.

### 6. Public Website UX

- **Sort dropdown** on listing pages (`/map` and category pages):
  Most recent (default), Recommended, Highest quality, Most
  trusted brokers, Fast-moving inventory, Undervalued, Luxury
  first. Server-side enforced via an allowlist (no SQL injection
  surface) and pre-resolved through the `listing_discovery_score`
  view.
- **Layout reorder** on category pages (`[...slug].vue`):
  listings grid now sits **above** breadcrumbs, filters, and SEO
  copy. Listings-first is the visitor's primary intent — filters
  remain functional below.

**Why it matters:** measurably reduces time-to-first-listing on
landing, which is the metric most strongly correlated with
inquiry conversion.

### 7. Operations Observability

- **Ops Health Dashboard remediation** (mig 31): re-applied
  pieces of mig 14 that hadn't fully landed in production —
  `system_metric_snapshots`, `ops_overview()` /
  `ops_metrics_downsampled()` RPCs, the snapshot capture cron.
  Fixed an `ops_alerts` view bug and removed a duplicate cron
  job (`refresh-listing-job`) that was triggering false stale-cron
  alerts.
- **DB Storage Growth Panel** (mig 43): new admin panel on
  `/admin/operations` showing per-table size, breakdown
  (heap / indexes / TOAST), row estimates, and **24h + 7d byte
  deltas** with severity color-coding. Daily snapshot cron at
  03:30 UTC; 90-day retention.

**Why it matters:** operators can now spot disk-pressure trends
before they become incidents.

### 8. Email Provider Removal

- Mailgun integration **removed**. `sendEmail()` is now a no-op
  stub that logs the intent. Templates and call-sites preserved
  so we can drop in a replacement provider later without
  touching upstream code.

**Why it matters:** Mailgun was fragile in dev (missing peer dep)
and we hadn't committed to keeping it. Clean stub > broken
integration. Re-enabling email is a 1-file change once a provider
is chosen.

---

## What's remaining

Tracked in `memory/project_open_threads.md`. Priority order:

### Active backlog (unblocked, can ship next)

1. **Per-domain health panels** on `/admin/operations` — explicit
   sections for Ingestion / Webhooks / Search / Cron / Rate
   Limits / Notifications, each with their own drilldowns.
   Foundation already in place via `ops_alerts` view.
2. **Threshold customization for ops alerts** — currently
   hardcoded (5 fails = critical, 25h = stale cron). Should be
   admin-tunable via a config table.
3. **Webhook deliveries panel auto-refresh** during retry chains
   (minor QoL).
4. **Saved-search digest preview admin UI** — endpoint exists,
   needs an iframe-based preview surface.

### Blocked on user action

5. **Drop `*_legacy` quarantine columns** from `public.listings` —
   ready to ship as soon as the Reconcile tab finishes processing
   the queue (visible in the system-status card under
   "data_health").

### Optional polish

6. LQIP for property gallery 2×2 thumbs (skipped during rollout —
   only worth it if we get user complaints).
7. Webhook payload-replay partner-side fingerprint confirmation.
8. Building cards LQIP regression check.

### Phase B remaining (Marketplace Completion)

- `listing_shares` UI on website + co-brokering flows.
- Public agent profiles (built on `public_profiles`).
- Agent onboarding registration / claim / verification UI
  (the **broker invitation pipeline** above is the backend half;
  the public-facing claim form is still pending).

### Phase C (Scale) — deferred until Phase B closes

- PostGIS spatial query migration.
- Search indexing (tsvector / GIN / B-tree composites).
- Server-side map clustering.
- Scraper ingestion (external listing import — distinct from the
  CSV pipeline shipped today).
- CDN optimization.

---

## Notes for management

### Operating posture today

- **All migrations are additive.** No destructive schema changes.
  No column drops, no type changes, no deletes. Rolling back is
  always a `DROP` of the new objects.
- **No auto-merge / auto-publish anywhere.** Imports stage to
  review tables. Listings created via import start `is_online =
  false`. Duplicates flagged but never auto-merged. Watches dedupe
  on dispatch. Every state change is logged via `log_activity()`.
- **Branch is clean.** Local working tree has the day's work
  applied; no uncommitted experimental code paths.

### Risks / things to watch

- **Image ingest queue is best-effort.** Sharp normalization +
  S3 upload runs as a background cron; transient failures retry
  with exponential backoff (5 attempts, max 4hr). If S3
  credentials lapse or Sharp can't decode an exotic format, that
  row is marked `failed_permanent` and the listing renders
  without the missing image. Covered by alerts on the ops dash.
- **Public market intelligence has sample-size thresholds.**
  Sparse barangays will return `null` rather than misleading
  numbers; the website should render "—" rather than "0%" in
  that case (currently the consumer code does this correctly).
- **Email is a no-op.** Saved-search digest worker still runs
  the matching logic, stamps `last_digest_sent_at`, and counts
  what *would* have shipped, but no email actually goes out
  until we wire a new provider. Operational signal preserved
  (we'll know if/when we need it back).
- **`pg_class.reltuples` is an estimate**, not exact, on the
  storage panel. The UI labels the column "Rows ≈" so operators
  don't read it as gospel. For exact counts we'd need
  `count(*)` per table, which we deliberately avoid (would lock
  on big tables during the daily cron).

### Numbers

- **13 migrations** today (`20260507000031` → `20260507000043`).
- **~1,200 lines of SQL** across new RPCs, tables, triggers, and
  governance contracts.
- **~3,500 lines of TypeScript / Vue** across new endpoints,
  components, composables, and the SEO layout.
- **Phase A** (Stabilization) — substantially complete. Remaining
  Phase A work is the per-domain ops panels and legacy column
  drop (blocked on reconciliation).
- **Phase B** (Marketplace Completion) — broker invitations,
  listing import, duplicate merge, market alerts, sort
  dropdown all shipped. Remaining: agent profile + claim UIs,
  listing-shares co-brokering surface.

### Signal sources

- `CHANGELOG.md` (repo root) — full shipped log with deploy
  gotchas and migration ordering.
- `CONTRIBUTING.md` (repo root) — operating contract,
  service-role allowlist, common traps for the next engineer.
- `docs/RLS_TESTS.md` — how to run the Row-Level Security suite.
- `/admin/operations` — live dashboard with overview cards,
  alert feed, time-series chart, **storage panel (new)**, and
  schema drift panel.

---

*Generated 2026-05-07. Next default work item per the operating
contract: per-domain health panels on the ops dashboard.*
