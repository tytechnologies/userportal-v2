# Changelog

Notable changes to the userportal + website (`websiteo/`) repos shipped
together against the shared Supabase project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); dates are
the migration / commit dates, not necessarily the deploy date.

Apply migrations in numeric order. Cron jobs registered by these
migrations only fire on the project they were applied to (no manual
scheduler needed); pg_net + pg_cron must be available on the project.

---

## 2026-05-14 — Stabilization + hybrid-search architecture

Multi-week stabilization pass that finished the Zillow-style hybrid
search architecture, closed a P0 silent-data-loss on contacts,
locked down `/api/admin/*` with a structural RBAC guard, and added
audit columns to the primary CRM tables.

### Added — Hybrid live-search architecture

- **Migration `20260514000002_hybrid_live_search.sql`** —
  `source_connectors` (provider registry with trust score + budget +
  domain allowlist), `live_search_cache` (`(provider, query_hash)`
  keyed normalized cache), `external_listing_candidates` (durable
  discovery corpus with dedup + operator state), `search_events`
  (telemetry). SECURITY DEFINER RPCs `record_search_event()` and
  `expire_live_search_cache(days)`.
- **Migration `20260514000003`** — GIN FTS index on
  `listing_details.title` for the PG-FTS fallback path.
- **Migration `20260514000004`** — pg_cron schedules:
  normalize_raw_batch (5min), index_search_queue (2min),
  expire_live_search_cache (daily 03:00 UTC). Reads
  portal_base_url + digest_cron_secret from `internal_config`.
- **Migration `20260514000006`** — user-scoped variants of trend +
  inquiry-funnel RPCs.
- **Portal**: external provider adapter (`server/utils/externalProviderAdapter.ts`),
  runtime dedup engine (`runtimeDedup.ts`), hybrid ranking
  (`hybridRanking.ts`), `/api/internal/live-search` (cache-first
  fan-out, per-provider deadline + budget), `/api/internal/search-event`
  (telemetry sink), admin observability under
  `/api/admin/live-search/*` + `/admin/live-search` page.
- **Website**: `/api/public/search-hybrid` orchestrator with
  internal+external parallel fetch + dedup + rank. `degraded_reason`
  taxonomy on every soft-fail. Circuit breaker on the portal call
  (3 fails → 60s cooldown). SSE stream at `/api/public/search-stream`
  + canonical page wiring behind `?engine=hybrid&stream=1`.
- **Admin**: `/admin/external-candidates` review queue with
  blacklist / promote / pin-dedup actions.

### Added — Marketing ticker

- **Migration `20260514000001_marketing_ticker.sql`** —
  `marketing_ticker_messages` table with 5-value kind enum
  (static / new_listings_recent / active_agents /
  total_listings_online / city_pulse). RLS allows anon SELECT of
  enabled rows.
- **Portal**: `/admin/ticker` CRUD + 5-kind resolver utility.
- **Website**: `TickerBanner.vue` SSR marquee below the top nav,
  60s client refresh, hover-pause, `prefers-reduced-motion` fallback.

### Added — First-sign-in onboarding tour

- **Migration `20260514000005_user_onboarding.sql`** —
  `profiles.onboarding_completed_at` + `onboarding_skipped`.
  `complete_onboarding_tour(skipped)` RPC (SECURITY DEFINER, pinned
  to `auth.uid()`).
- Pinia store + spotlight overlay component + 8-step tour config
  covering dashboard → sidebar → Create → inquiries → tasks →
  shortcuts.
- Auto-fires once per user; "Restart onboarding tour" via Cmd-K.

### Added — Audit columns

- **Migration `20260514000007_contacts_audit_fields.sql`** —
  `created_by` (DEFAULT auth.uid()) + `updated_by` (trigger) on
  `contacts`.
- **Migration `20260514000008_tasks_deals_audit_fields.sql`** —
  same pattern on `tasks` (both columns new) + `deals` (just
  `updated_by`; `created_by` predated).

### Changed — RBAC structural hardening

- **`server/middleware/admin-api-guard.ts`** — Nitro middleware
  default-denies `/api/admin/*` for non-admins. Empty allowlist;
  per-endpoint `requireRole` calls remain as double-gates.
- **`app/middleware/admin.global.ts`** — client-side route guard
  for the same `/admin/*` paths.
- **P0 contacts** — `contactCreateSchema` no longer accepts
  `ownerUserId`. `.strict()` on contact + task schemas. Routed
  `useContacts.fetchContacts` through the new `GET /api/contacts`.
  `DELETE /api/contacts/[id]` endpoint added.

### Changed — write schemas

- `.strict()` sweep across 11 user-facing write endpoints:
  contacts, tasks, clauses, watches, reviews, document-drafts
  versions / approvals / esign / export. Unknown keys now 422 with
  `data.issues` instead of silently dropping.

### Fixed

- Image-pipeline tech debt (4 catalogued bugs): update-thumbnail
  selector mismatch + 422 with structured body,
  `dbImagesEngine.uploadImageToDB` `.single()` landmine on empty
  table, DB file_name vs S3 extension divergence (`.jpg` vs
  `.jpeg`), opaque 404 → 422.
- `/admin/live-search` connector toggle button visibility.
- `/my-profile` PRC/HLURB/DTI fields now behind an explicit
  agent-toggle.
- `/crm` Recently-added-contacts panel: three-state load model
  (idle/loading/ready/error).
- `/ai-tools` admin-link cards hidden for non-admins.
- Navbar global-search button label honest about commands-only
  scope.
- Listing-detail verification button emoji UTF-8 (was double-
  encoded `ðŸ›¡ï¸`).
- Profile fetch storm: 4 identical `/profiles?email=eq.X` queries
  collapsed to 1 via `useCurrentProfile()` composable.
- Inflight dedup on `useContacts.fetchContacts`.

### Tests

- `tests/` gained 9 env-gated integration suites covering hybrid
  search, ticker, lead routing, contacts (P0 regression armor),
  dashboard scope, admin RBAC, cron pipelines (late-fee + tenant +
  owner statements), saved-search digest, inspections. README in
  the same dir documents the env-var matrix.

### Docs

- `docs/pipelines/` — 13 operational reference cards for every
  async / cron / cross-service flow, plus an index README.
- `ONBOARDING.md` at the repo root — developer / operator
  onboarding primer.

---

## 2026-05-08

### Added — Tenant Portal Invitation pipeline (userportal-only slice)

- **Migration `20260508000002_tenant_portal_invitations.sql`**: additive
  `tenant_portal_invitations` table storing only sha256-hashed tokens
  (cleartext is emailed and discarded). Three SECURITY DEFINER RPCs:
  - `issue_tenant_portal_invitation(lease_party_id, invite_email,
    token, expires_in_days)` — admin/manager. Auto-revokes any prior
    active invite on the same party (partial UNIQUE) and stamps
    `created_by` from `auth.uid()`.
  - `accept_tenant_portal_invitation(token)` — called by the eventual
    public website. Atomically validates (hash match + not expired +
    not accepted/revoked) and binds `lease_parties.user_id := auth.uid()`.
    Idempotent on same-user re-acceptance; opaque error message for
    every "invalid" branch (no token-shape oracle).
  - `revoke_tenant_portal_invitation(invitation_id, reason)` —
    admin/manager. Idempotent on already-revoked; refuses on
    already-accepted (clear `lease_parties.user_id` separately).
  - Permission gate accepts `leases.manage`, `property.manage`, or
    `admin.access`. RLS on the table: tenants see only invitations they
    accepted; admin/manager see all.
  - Schema governance: registered the table + the two cross-repo RPCs
    in `governance_schema_contracts`; `accept_tenant_portal_invitation`
    is marked `consumers={userportal,website}` so the website becomes a
    first-class consumer the moment its portal pages ship.
- **Admin endpoints** under `/api/admin/tenant-portal-invitations/`:
  - `POST /` — issue. Generates a 48-byte (base64url) token server-
    side, calls the RPC, sends the invite email via Resend (the
    existing `sendEmail()` wrapper; falls back to log-only when
    `RESEND_API_KEY` is unset). Response includes the cleartext token
    once so the admin UI can offer a "copy invite link" fallback.
    Token is never logged.
  - `GET /` — list / filter (by `lease_party_id` and/or status:
    active/accepted/revoked/expired). Token hash explicitly excluded
    from the projection.
  - `POST /[id]/revoke` — calls the revoke RPC, audits with a reason.
- **Email**: added a dedicated `tenant_portal.invitation` template to
  `renderEmail()` — branded subject + clear single-use + expiration
  copy + branded "Open your tenant portal" button.

### Added — Admin UI hook for owner invitations

- `app/pages/admin/owners.vue` table now has a **Portal** column +
  per-row Invite / Re-invite / Revoke actions matching the lease
  detail tenant pattern. Status states: `linked` (user_id bound),
  `active` / `accepted` / `revoked` / `expired` (most recent
  invitation), or `—` (none). Background fetch (single GET, indexed
  client-side by property_owner_id) so first paint is unblocked.
  Issue and revoke modals mirror the tenant ones — same Copy-link
  fallback when Resend isn't delivering.

### Added — Lead routing rules (auto-assign incoming inquiries)

- **Migration `20260508000009_lead_routing_rules.sql`**: closes the
  CRM + OPERATIONS "lead routing" gap from the directive. Single
  additive table + BEFORE INSERT trigger on `inquiries`.
  - `lead_routing_rules` table — priority-ordered (0-10000, lower
    runs first), enabled flag, criteria jsonb, action_kind (`assign_user`
    or `round_robin_pool`), pool_state.last_index for round-robin
    advancement, denorm `match_count` + `last_matched_at` for
    observability. CHECK enforces action coherence.
  - Criteria jsonb keys (all optional; empty {} = catch-all):
    `property_type`, `listing_kind` (sale|rent|sale_or_rent),
    `city_id`, `barangay_id`, `min_price`, `max_price`, `source`,
    `has_listing`. Each accepts a single value or an array.
  - `lead_routing_assign_fn()` BEFORE INSERT trigger walks rules
    priority-ASC, lazy-loads listing context only when criteria
    require it, evaluates each criterion, first match wins. Sets
    `NEW.assigned_user_id` (overrides any pre-set value). Pool
    rotation uses `(last_index + 1) % pool_length`. Counter bumps
    + pool-state writes are best-effort wrapped — a transient error
    never blocks the inquiry insert.
  - **Additive on top of legacy routing**: when no rule matches the
    inquiry's `assigned_user_id` is left as the caller set it
    (typically the public endpoint's `listing.created_by` snapshot).
    No flag-day, no behavior loss — operators ship one rule at a
    time and grow coverage incrementally.
  - `evaluate_lead_routing(p_listing_id, p_source)` SECURITY DEFINER
    RPC — preview which rule would match a hypothetical inquiry
    without writing.
  - New permission `lead_routing.manage` granted to admin + manager.
  - RLS, schema governance, drift-safe precondition.

- **5 admin endpoints** under `/api/admin/lead-routing-rules/`:
  - GET list (filter by enabled)
  - POST create (zod-validated criteria + action coherence refine)
  - PATCH update (partial)
  - DELETE hard-delete (operators flip `enabled=false` for soft-disable)
  - POST `/evaluate` (preview wrapper around the RPC)

- **`/admin/lead-routing` page**:
  - Summary strip (rule count / enabled / lifetime matches)
  - Sortable table by priority with per-row enable/disable toggle,
    edit, delete actions, last-match timestamp, criteria preview.
  - Create/Edit modal with priority + criteria JSON editor + action
    selector (assign_user vs round_robin_pool) + UUID input(s).
  - **Preview** modal — operator types a listing_id + source, gets
    back which rule would match (or "no match — falls through").

### Fixed — Buildings legacy column drift (production runtime)

- `app/services/listing.services.js` — `_getBuildingNames()` and
  `_selectBuilding()` rewritten to query the canonical `id`/`name`
  columns and alias the response back to the legacy
  `building_name`/`property_id` keys for backwards compat. Fixes
  `42703 column buildings.building_name does not exist` runtime
  error reported from the listing-create form. Memory note saved
  for future sessions: `feedback_buildings_legacy_columns.md`.

### Added — PH real-estate calculator suite

- **`server/utils/realEstateCalculators.ts`** — pure functions for
  the directive's TAX + FINANCIAL TOOLS list. Operates on major units
  (PHP, not centavos) since these are advisory, not ledger entries.
  Default rates match BIR / LGU practice as of 2026-05-08; every calc
  accepts overrides for transitional periods.
  - **`dst()`** — DST = 1.5% × max(selling_price, zonal/fair value)
  - **`cgt()`** — CGT = 6% × max(selling_price, zonal/fair value)
  - **`transferTax()`** — LGU transfer tax (default 0.75%, range 0.5–0.75%)
  - **`mortgage()`** — monthly P&I + total paid + total interest, with
    r=0 short-circuit for no-interest loans
  - **`amortization()`** — full schedule with `max_rows` cap;
    final-row rounding lands the balance at exactly 0
  - **`roi()`** — NOI + cap rate + gross yield from rental income
  - **`commissionTax()`** — VAT (12%) + creditable WHT (5% if VAT-reg,
    10% non-VAT) → net received by broker
  - **`allInTransactionEstimate()`** — DST + CGT + transfer + commission
    aggregated for "all-in transaction cost" view
- **`POST /api/admin/calculators`** — single discriminated-union
  dispatcher. zod-validated per-kind. `requireRole(event, 'agent')` —
  any active broker can use the tools.
- **`/admin/tools/calculators`** — tabbed admin page (8 tabs). Each
  tab has its own input form pre-loaded with sensible defaults
  (₱5M sale price, 7.5% mortgage rate, etc.) and a result panel with
  a headline metric + breakdown table. Amortization tab shows the
  full schedule in a scrollable table.

- **Why this matters**: every PH real estate transaction needs DST/CGT
  numbers in the listing agreement. Brokers calculating in spreadsheets
  before now had no shared source of truth for the rates; this slice
  makes it impossible to use a stale 2018 DST rate by accident.

### Added — Final gap-closure pass (5 slices)

#### Per-finding photo editing on inline edit row

- Inspection detail inline edit mode now exposes existing photos as
  removable chips + a file picker for new uploads. Save orchestrates
  upload → PATCH with merged photos. `editForm.retainedPhotos` /
  `editForm.editPendingFiles` state tracks the operator's draft.

#### S3 cascade-delete on finding delete

- `DELETE /api/inspections/[id]/findings/[fid]` now reads the photos
  jsonb before deleting, then batches delete on each `key` via the
  existing `deleteObjectsByKeys` helper. Best-effort: S3 errors are
  logged but don't block the DB delete (orphans collected by a
  future cleanup cron). Response includes `s3_objects_deleted`.

#### Multi-page PDF support

- `server/utils/statementPdf.ts` now uses a `FlowState` pattern with
  `newFlow()` + `flowToNewPage(state, requiredHeight)` helpers.
  `drawLineItemTableFlowed()` repeats the column header on each new
  page so spilled tables stay readable. `drawFootersAll(state)`
  stamps "Page N of M" on every page. Both tenant + owner renderers
  refactored to the new pattern. Long statements (∞ line items) now
  paginate cleanly instead of truncating at the bottom margin.

#### Move-in/move-out comparison viewer

- `GET /api/inspections/[id]` now resolves `baseline_finding_id`
  pointers in a single batch query and inlines the baseline finding
  (with enriched signed photos) on each move-out finding.
- Inspection detail page (`move_out` kind only) renders a new
  "Move-in baseline comparison" section with side-by-side cards per
  pair (baseline condition + photos vs current condition + photos),
  plus a tone-coded "improved / same / worse" badge derived from the
  condition rank.

#### Push-mode cron + secret wiring

- **`server/utils/syndicationPush.ts`**: new push runner.
  - Resolves the partner secret via env-var convention:
    `process.env[target.push_secret_vault_key]`. Avoids depending
    on Supabase Vault (paid feature). Operator stores the actual
    secret as an env var; DB only carries the var *name*.
  - Auth shapes wired: `none`, `bearer`
    (`Authorization: Bearer <secret>`), `hmac`
    (`X-HHI-Timestamp` + `X-HHI-Signature` = sha256 hex of
    `<ts>.<body>` keyed on the secret), `basic` (base64 of
    secret as `user:pass`).
  - 30-second `AbortController` timeout. `redirect: 'manual'` so the
    auth header doesn't leak to a redirected host. Captures response
    status + 2 KB body excerpt for the run audit.
- **`POST /api/admin/listing-syndication/targets/[id]/push-now`**:
  manual push trigger. Builds the feed (same dispatcher as pull),
  POSTs via `pushFeedToTarget()`, stamps
  `push_response_status` + `push_response_body_excerpt` on the run
  audit. Refuses on pull-mode targets (422), archived targets (409),
  or missing endpoint (422).
- **Admin UI** (`/admin/listing-syndication`):
  - Per-row **Push** action (only for push-mode targets) shows
    `Pushing…` while in flight, toasts the partner response code +
    duration on success.
  - Edit modal exposes `Push auth` selector + `Secret env var name`
    field (with copy explaining the secret-stays-in-env convention).

- **Phase D deferred**: cron-driven push (pg_cron + pg_net or AWS
  EventBridge calling `/push-now`). Schema's `refresh_cron` column is
  ready for it; just needs a wiring slice when an operator goes live
  with their first push partner.

### Added — Multi-slice gap-closure pass

#### CSV serializer (Phase B addendum)

- **`server/utils/syndicationFeed.ts`** — `serializeCsv()` produces
  RFC 4180-compliant output with CRLF line endings, double-quote
  escape for fields containing `,` `"` `\r` `\n`. Header row matches
  JSON field names so partner ETL pipelines map cleanly.
- `serializeFeed()` dispatcher + `contentTypeFor()` extended to
  return `text/csv; charset=utf-8`. RSS still throws (needs per-listing
  canonical website URLs).
- POST/PATCH zod refines + the admin UI selector now accept `csv`.

#### Per-listing override management

- **`GET /api/admin/listing-syndication/targets/[id]/overrides`**
  with optional `override_kind` + limit filter.
- **`POST /api/admin/listing-syndication/overrides`** — verifies
  target + listing exist before insert. UNIQUE conflict on
  (target_id, listing_id) returns 409 with a clear "delete first"
  message.
- **`DELETE /api/admin/listing-syndication/overrides/[id]`**.
- **Detail drawer in `/admin/listing-syndication`** now shows the
  current overrides as a list (force_include / force_exclude
  badges, reason, Remove button) plus an inline add form
  (listing-id input + kind select + reason field).

#### Late-fee cross-lease browse view

- **`GET /api/admin/late-fee/assessments`** — paginated list with
  optional lease_id + date range filters. Joins to property_charges
  twice (the late_fee charge it created + the source charge that
  triggered it) so the UI can render both charge_no values without
  follow-up calls.
- **`/admin/late-fees`** new page: filter bar (lease id / from / to),
  summary strip (assessments shown, total fees on page, paid count),
  table with status badges + recurrence chips + drill-through to
  the lease detail page. Pagination at 50/page.

#### Cross-lease inspection browse

- **`GET /api/admin/inspections`** — paginated list with status, kind,
  unit_id, lease_id filters. Estimated count for fast pagination.
- **`/admin/inspections` (index page)** — filter bar (status / kind /
  unit / lease), summary strip (shown / awaiting signature / in
  progress / damage estimate sum), clickable rows → inspection
  detail page. Schedule new inspections still flows through the
  per-lease detail page.

### Added — Listing syndication Phase B: XML serializer

- **`server/utils/syndicationFeed.ts`**:
  - New `serializeXml(target, listings)` produces a clean
    `<feed><metadata/><listings><listing/></listings></feed>` shape
    in the `https://www.housinginteractive.com.ph/syndication/v1`
    namespace. Description goes in CDATA so HTML / punctuation
    survives; everything else is XML-escaped via a local helper.
  - New `serializeFeed(target, listings)` dispatcher routes to the
    correct serializer based on `target.feed_format`.
  - `contentTypeFor()` now returns `application/xml; charset=utf-8`
    for `xml`. CSV / RSS still throw with a clear "coming" message.
- **Public `/syndication/<slug>` route + admin run-now endpoint**
  switched from calling `serializeJson` directly to the dispatcher.
  An XML-format target now gets XML automatically when polled.
- **Admin endpoints**:
  - `POST /api/admin/listing-syndication/targets`: zod refine
    relaxed to accept `feed_format ∈ {json, xml}`.
  - `PATCH /api/admin/listing-syndication/targets/[id]`: same
    relaxation; CSV / RSS still rejected at patch time.
- **`/admin/listing-syndication.vue`**: feed_format selector now
  appears in both the create and edit modals (JSON / XML radio
  buttons inline with delivery_mode). Subtitle updated:
  "JSON + XML feeds served at /syndication/<slug>. CSV / RSS + push
  delivery land in phase B+."
- **Phase C deferred**: CSV / RSS serializers, push-mode cron, vault
  helper for `push_secret_vault_key`, format-suffixed URLs
  (`/syndication/<slug>.json`, `.xml`).

### Added — Inspection photo upload via presigned S3 PUT

- **`server/utils/s3.ts`** — added `getSignedUploadUrl(key, contentType, expiresIn=600)`
  helper. Uses `PutObjectCommand` presigner with the same credentials/region/bucket
  as the existing download flow. 10-minute TTL keeps leaked URLs short-lived.
- **`POST /api/inspections/[id]/findings/[fid]/photo-upload-url`**:
  - Body: `{content_type, byte_length?, filename?}`. Validates MIME against
    `image/{jpeg,png,webp,heic,heif}` (returns 422 otherwise) and 20 MB cap.
  - Verifies parent inspection is in `scheduled`/`in_progress` and the
    finding belongs to it; returns 409 if locked.
  - Generates a per-finding S3 key: `inspections/inspection-<id>/findings/<fid>/<uuid>.<ext>`.
    Per-finding sub-folder makes batch deletion easy on row delete.
  - Returns `{key, upload_url, expires_at, content_type, filename, public_path}`.
- **`GET /api/inspections/[id]`** now enriches each finding's photos:
  any photo with a `key` field gets a `display_url` (signed download URL,
  1-hour TTL) so the UI can render private photos without exposing the bucket.
  Hand-pasted `url`-only photos pass through unchanged.
- **POST findings + PATCH finding schemas** relaxed: `photos[]` accepts
  `{url? | key? | name?}` with a refine that requires at least one of
  url/key. Backwards compatible with operators who paste public URLs.
- **`/admin/inspections/[id].vue`** Add-finding modal:
  - File picker (multi-select, image MIME filter, 20 MB cap, 12-photo cap).
  - Picked files render as removable chips with byte-count.
  - On submit: creates the finding row first, uploads each pending file
    via the presigned URL, then PATCHes the finding with the union of
    pasted URLs + uploaded keys. Per-photo upload errors toast individually
    so a single bad file doesn't lose the whole finding.
  - Upload progress message ("Uploading photo 2 of 5…") next to the action
    buttons during the sequence.
- **Photo display in finding read mode**: prefers `display_url` (signed),
  falls back to `url`, with `name` as the link label when present so chips
  read like `📷 kitchen-leak.jpg` instead of opaque key paths.
- **Phase B deferred**: per-finding photo editing on the inline row edit
  (existing photos render in read mode but no add/remove during edit yet);
  cascade-delete of S3 keys when a finding is deleted (DB row deletes today
  but S3 objects orphan — small cleanup cron lands when needed).

### Added — Owner detail page + units endpoint

- **`/admin/owners/[id]` detail page**:
  - Identity card with name / email / TIN / portal-binding badge.
  - Lifetime totals strip (rent collected, dues collected, expenses,
    net disbursed) computed across non-void statements.
  - Active units section (read from new `/api/property-owners/[id]/units`
    endpoint — share_pct + is_primary + source).
  - Statements table with status badge, period range, rent / dues /
    expenses / net columns, and **PDF download per row** wired to
    `/api/admin/owner-statements/[id]/pdf` (shipped in the prior
    slice).
  - "Manage schedule" link routes back to the owners list page where
    the schedule editor modal lives.

- **`GET /api/property-owners/[id]/units`** — RLS-respecting list of
  the owner's active unit ownerships (no `ended_at`). Drives the
  detail page's Active units section.

- **`/admin/owners` list**: owner display name in the table is now a
  NuxtLink into the detail page.

### Added — Statement PDF rendering (tenant + owner)

- **`server/utils/statementPdf.ts`** — pdf-lib renderer. Two
  exports: `renderTenantStatementPdf()` and `renderOwnerStatementPdf()`.
  Shared layout primitives (header with brand mark + title; two-column
  KV identity block; line-item table with character-bounded
  truncation; totals rows with tone coloring; bottom footer with
  generation timestamp + statement_no). Status text uses the same
  semantic palette as the admin UI (success / warning / destructive /
  primary / muted).
- **`GET /api/admin/tenant-statements/[id]/pdf`** — fetches statement
  + lease + unit + primary tenant party, renders, returns
  `application/pdf` with `Content-Disposition: inline; filename="<no>.pdf"`.
- **`GET /api/admin/owner-statements/[id]/pdf`** — mirror of the
  tenant endpoint but pulls owner identity + tax_id from
  `property_owners`. Same response shape.
- **Lease detail UI** (`/admin/leases/[id].vue`): added a per-row
  PDF link to the Recent statements table that opens in a new tab.
  Owner-side download deferred to the next slice (no owner statement
  viewer surface yet — endpoint is callable via API today).

### Added — Listing syndication admin UI (Phase A: complete)

- **3 supporting endpoints**:
  - `PATCH /api/admin/listing-syndication/targets/[id]` — partial
    edit (display_name, mode, filters, cap, cron, status, notes).
    Slug is intentionally NOT patchable (it's the public URL contract).
  - `DELETE /api/admin/listing-syndication/targets/[id]` — soft-archive
    (status='archived'). Public route returns 404 for archived; past
    runs preserved.
  - `GET /api/admin/listing-syndication/targets/[id]/runs` — run
    history with optional run_kind / status filter.

- **`/admin/listing-syndication` page**:
  - Status-filtered targets table (active / paused / archived / all)
    with per-row Run / Edit / Copy URL / Archive actions and a
    Last-run summary column.
  - **Detail drawer** (click a row) — filters preview, mode summary,
    cap, recent runs list with status badges + bytes + pull origin
    (IP/UA for pull runs, errors for failed runs). Body preview from
    the most recent manual Run-now appears inline.
  - **Create modal** — slug regex-validated, JSON filters editor,
    delivery mode toggle (push endpoint URL appears conditionally),
    cap input.
  - **Edit modal** — same shape minus slug (read-only). Status
    selector includes archived for re-activation.
  - **Copy URL** action puts the absolute `/syndication/<slug>` URL
    on the clipboard for sharing with partner integrations.

- **Phase A vertical: complete**. Operators can now stand up an
  outbound feed end-to-end without touching SQL or curl. Phase B
  (XML / CSV / RSS serializers, push-mode cron, override management
  UI, vault-managed push secrets) remains scoped but unstarted.

### Added — Listing syndication outbound (Phase A: foundation)

- **Migration `20260508000008_listing_syndication.sql`**: closes the
  audit's only remaining MISSING entry in MLS infrastructure.
  Three additive tables:
  - `listing_syndication_targets` — per-portal config. `slug` is
    URL-safe + UNIQUE (drives `/syndication/<slug>`). `feed_format`
    enum supports json/xml/csv/rss (phase A serializes JSON only;
    others throw a clean 501 + 422). `delivery_mode` is `pull`
    (anonymous external poll) or `push` (we POST/PUT to a partner
    URL on a cron — push wiring deferred). `include_filters` jsonb
    drives the eligibility query (status, property_type, city_id,
    price ranges). `max_listings_per_run` cap. Denormalised
    `last_run_at` / `last_run_listings` / `last_run_status` for
    fast list-view rendering.
  - `listing_syndication_overrides` — per-listing force_include /
    force_exclude. UNIQUE on (target_id, listing_id) so each row is
    a single decision per pair.
  - `listing_syndication_runs` — append-only audit. `run_kind`:
    `cron` / `manual` / `pull`. Records bytes emitted, errors jsonb,
    push response status (for push-mode), pull origin (IP/UA/referer
    for the public route).
  - New permission `syndication.manage` granted to admin + manager.
  - RLS: targets/overrides/runs all admin/manager only (writes via
    service-role from the feed generator).

- **Server util `syndicationFeed.ts`**: single source of truth for
  selection + serialization.
  - `selectListingsForTarget()` — applies `include_filters`, then
    subtracts `force_exclude` overrides, then unions in
    `force_include` overrides (capped by max_listings_per_run).
    Returns `{listings, forced_in, forced_out}`.
  - `serializeJson()` — clean schema: `{feed: {slug, display_name,
    generated_at}, count, listings: [...]}`.
  - `contentTypeFor()` — JSON content-type today; throws explicitly
    for non-JSON formats so misconfigured targets fail loudly.

- **Endpoints**:
  - `GET  /api/admin/listing-syndication/targets` — list with
    optional status filter.
  - `POST /api/admin/listing-syndication/targets` — create. Slug
    regex-validated; uniqueness violation surfaced as 409. Phase-A
    only accepts `feed_format=json` (zod refine — XML/CSV/RSS land
    in phase B).
  - `POST /api/admin/listing-syndication/targets/[id]/run-now` —
    manual trigger. Builds the feed in-memory, writes a `runs` row
    (status='manual'), updates target denorms, returns
    `{run_id, listings_included, forced_in, forced_out, bytes_emitted,
    body_preview}` (body truncated at 256 KB).

- **Public route** `GET /syndication/[slug]` (mounted via
  `server/routes/`, NOT `/api/`):
  - Anonymous, rate-limited 60/hour per IP via the existing
    `enforceRateLimit` helper.
  - Reads target by slug + status='active'; 404 otherwise.
  - Writes a `runs` row with `run_kind='pull'` and pull_origin =
    `{ip, user_agent, referer}` so operators can audit who's pulling.
  - Sets `cache-control: public, s-maxage=300, stale-while-revalidate=60`
    — Cloudflare absorbs the bulk of partner polling traffic.
  - Phase A: returns JSON. Other formats → 501 with clear message.

- **Deferred to Phase B**: full admin UI page (`/admin/listing-syndication`),
  XML / CSV / RSS serializers, cron-driven push runs to
  `push_endpoint_url`, per-listing override management UI, secret-vault
  helper for `push_secret_vault_key`. Endpoints + DB ready for all of it.

### Added — AI suggestions: manual seed + run-now + accurate banner

- **`POST /api/admin/ai-suggestions`** — manual seed for testing or
  hand-crafted suggestions. Sets `model_provider='manual'`,
  `model_name=<operator email>`. Validates kind / target_kind /
  target_id / payload shape via zod.
- **`POST /api/admin/ai-worker/run-now`** — admin-only proxy that
  forwards to the internal worker tick using `AI_WORKER_SECRET`.
  Returns aggregate `total_written` + per-kind stats. 503 if the
  secret is unset; 502 if the upstream call fails.
- **`/admin/ai-suggestions.vue` polish**:
  - Replaced the misleading "Phase D foundation — schema + queue UI
    shipped" banner. Reality: provider abstraction (Anthropic +
    OpenAI + noop), candidate finders for two kinds, dispatcher,
    queue, verdict-with-dispatch are all live. To enable real
    generations: set `AI_SUGGESTION_PROVIDER`, the matching API
    key, and `AI_WORKER_SECRET`.
  - **Run worker now** button — fires the candidate-finder + LLM
    completion pipeline on demand; shows last-run stats.
  - **+ Add suggestion** button → modal with kind selector,
    target_kind autocomplete (`<datalist>`), JSON payload editor,
    confidence + prompt-version inputs. Validates payload is a
    JSON object before POSTing.

### Added — Inspection detail page (closes the inspections vertical)

- **Three new endpoints**:
  - `PATCH /api/inspections/[id]` — operator metadata (scheduled_at,
    conducted_at, inspector_external_name, summary_notes).
  - `PATCH /api/inspections/[id]/findings/[fid]` — finding edit. Re-
    validates `is_damage` ↔ `estimated_cost_minor` server-side.
    Refuses on parent in `completed`/`tenant_signed`/`cancelled`.
  - `DELETE /api/inspections/[id]/findings/[fid]` — finding delete.
    Refuses if a `damage_charge_id` is already set (operator must
    void the charge first).
  - `POST /api/inspections/[id]/cancel` — terminal cancel. Refuses
    on `tenant_signed` (use the void-charge path instead).
    Idempotent on already-cancelled.

- **`/admin/inspections/[id]` detail page**:
  - Header card with `inspection_no`, kind, status badge, overall
    condition, scheduled / conducted / signed dates, total damage
    estimate, inspector identity.
  - Findings section grouped by area (kitchen → exterior).
    Inline-editable per row (area / item / condition / description /
    is_damage toggle / estimated cost). Photo URLs render as
    monospace preview links.
  - **Add finding** modal with `<datalist>` autocomplete suggestions
    for area + item, photo-URL textarea (newline / comma separated).
  - **Footer actions** (status-aware visibility):
    - **Edit details** — opens metadata modal
    - **Complete** — only when `scheduled`/`in_progress` AND
      ≥1 finding exists
    - **Charge damages** — only when `completed`/`tenant_signed`
      AND lease_id present AND ≥1 unflagged-but-charged-pending
      damage finding remains
    - **Cancel** — only when not terminal
  - **Tenant attestation panel** — displays after sign-in event with
    signature kind + truncated value.
  - Linked from `/admin/leases/[id].vue` Inspections section
    (rows are now NuxtLinks with hover affordance + arrow).

### Added — Inspection workflows (new PM domain)

- **Migration `20260508000007_inspections.sql`**: closes the audit's
  "ad-hoc milestones today, no dedicated table" gap. First-class
  structured inspections with per-finding evidence and a path from
  damaged findings → `property_charges`.
  - `inspections` table — state machine (`scheduled` → `in_progress`
    → `completed` → `tenant_signed`; `cancelled` is terminal). Fields:
    `inspection_no` (auto INS-YYYY-NNNNNN), `inspection_kind`
    (move_in / move_out / mid_tenancy / maintenance / annual),
    inspector identity, optional FK to `lease_id` and
    `unit_occupancy_id`, tenant attestation jsonb (typed / click /
    png_data), `overall_condition`, `total_damage_estimate_minor`
    rollup.
  - `inspection_findings` table — per-area, per-item observations.
    Free-form `area`/`item` strings keep schema flexible. `condition`
    enum from `excellent` to `missing`. `is_damage` flag (with CHECK
    requiring `estimated_cost_minor > 0`). `photos` jsonb. Optional
    `baseline_finding_id` FK back to a move-in finding for move-out
    comparisons. `damage_charge_id` FK to property_charges (set by
    the charge RPC; idempotency key).
  - `inspection_complete()` RPC — locks findings, computes
    overall_condition (worst rating wins) + total_damage_estimate_minor
    rollup. Requires ≥1 finding.
  - `inspection_tenant_sign()` RPC — tenant attestation. Validates
    caller is a tenant on the lease (RLS + explicit check), accepts
    signature jsonb (typed / click / png_data), stamps signed_at.
  - `inspection_charge_damages()` RPC — for completed/tenant_signed
    inspections, walks `is_damage` findings without a
    `damage_charge_id` and creates `property_charges` (kind='damage',
    billing_target='tenant', status='open', due_at = now + 7d) one
    per finding. Idempotent via the FK back to the charge.
  - New permission `inspections.manage` granted to admin + manager.
  - RLS: tenants on the lease can read inspections + findings (so
    the future portal can show "you have a move-out inspection
    scheduled"); inspector themselves can read + edit while
    `scheduled`/`in_progress`; admin/manager full control.

- **Endpoints** (mostly RLS-respecting via the user's session client
  for reads; service-role for the SECURITY DEFINER RPCs):
  - `GET /api/leases/[id]/inspections` — list (RLS-respecting).
  - `POST /api/leases/[id]/inspections` — schedule new (admin/manager).
    Resolves `unit_id` from the lease so it can't be spoofed.
    Defaults inspector to caller.
  - `GET /api/inspections/[id]` — read inspection + all findings.
  - `POST /api/inspections/[id]/findings` — add finding. Auto-flips
    parent inspection from `scheduled` → `in_progress` on first
    finding for fluent UX. Validates `is_damage` ↔ `estimated_cost_minor`.
  - `POST /api/inspections/[id]/complete` — wraps the lock RPC.
  - `POST /api/inspections/[id]/charge-damages` — wraps the charge
    RPC. Returns `{charges_created, total_amount_minor}`.

- **Lease detail UI** (`/admin/leases/[id].vue`) — new "Inspections"
  section between Statement schedule and Maintenance feed:
  - Shows `inspection_no`, kind, status badge, overall condition,
    scheduled/conducted/signed dates, total damage estimate.
  - "+ Schedule inspection" → modal (kind selector with full
    descriptions, datetime-local picker, optional external
    inspector, summary notes).
  - Per-finding editor + damage-charging UI deferred to a dedicated
    `/admin/inspections/[id]` detail page (next slice). Operators can
    schedule + see status now; full editing flows through API today.

### Added — Auto owner-statement aggregation (symmetric to tenant)

- **Migration `20260508000006_owner_statement_aggregation.sql`**:
  closes the symmetric loop. Mirror of the tenant statement work but
  rolls up at the *owner* level across all units they hold.
  - `owner_statement_policies` — per-owner, opt-in. Same shape as
    `tenant_statement_policies` (cadence, fire_day_of_period,
    auto_issue, next_run_at bookkeeping). Partial UNIQUE for one
    active policy per owner.
  - `generate_owner_statements(today)` RPC: walks active policies,
    snapshots the owner's active `unit_owners` set + their leases,
    aggregates over the prior calendar period:
    - rent_collected = paid 'rent' charges on owner's leases
    - dues_collected = paid 'dues' charges (billing_target='owner')
      on owner's units
    - expenses = completed `work_orders.cost_actual_minor` with
      `billing_target='owner'`
    - management_fee + tax_withheld stay 0 (deferred — would read
      from a future commission_rules.owner_share + BIR 2307 layer)
    - net_disbursement = rent + dues - expenses - mgmt - withheld
    Inserts `owner_statements` row (draft or auto-issued per policy).
    Idempotent via SELECT-before-INSERT against (owner_id, period).
    `line_items` carries the source `charge_no` / `work_order_no`
    for traceability.
  - Daily cron at **05:30 UTC** — after tenant statements (05:00)
    so payment posting from the tenant side is settled.
  - `payment_runs.run_kind` CHECK widened additively to allow
    `'owner_statement'` (drift-safe pattern).
  - New permission `owner_statements.manage` granted to admin + manager.
  - RLS: owner sees their own policy via property_owners.user_id.

- **Admin endpoints**:
  - `GET / PUT / DELETE /api/admin/property-owners/[id]/statement-policy`
  - `POST /api/admin/owner-statements/generate` — manual cron trigger
    (processes ALL active policies, not just one owner).

- **Owners list UI** (`/admin/owners.vue`):
  - New **Statements** column with badge (`auto · monthly`,
    `draft · monthly`, or `off`). Tooltip shows next run date.
  - Per-row **Schedule** / **Edit schedule** action opens the editor
    modal. **Stop** action soft-ends the policy.
  - Page-level **Generate statements now** button in the toolbar
    runs the cron once across all policies (idempotent; confirmed
    via `confirm()` since it touches all owners).
  - Editor modal mirrors the tenant-side shape: cadence selector,
    fire-day input, auto-issue toggle, audited notes.

### Added — Auto tenant-statement issuance (PM billing-loop close)

- **Migration `20260508000005_tenant_statement_aggregation.sql`**:
  closes the second half of the PM billing loop. `tenant_statements`
  was manual-only; now it auto-aggregates.
  - `tenant_statement_policies` — per-lease, opt-in. `cadence` is
    `monthly` or `quarterly`; `fire_day_of_period` (1-28) controls
    when in the new period the statement gets generated; `auto_issue`
    flips draft → issued automatically (otherwise statements wait
    for operator review). Partial UNIQUE for one active policy per
    lease. Bookkeeping fields `next_run_at` +
    `last_generated_period_start` make the cron re-run safe.
  - `generate_tenant_statements(today)` RPC. For each active policy
    where `next_run_at <= today`: computes the prior calendar period
    (anchored on the calendar, not on `lease.effective_at`),
    aggregates `property_charges` filtered by `period_start` (with
    `created_at::date` fallback for ad-hoc charges), inserts a
    tenant_statements row with full `line_items` carrying source
    `charge_no` for traceability. SELECT-before-INSERT against
    (lease_id, period_start, period_end) keeps it idempotent. If
    `auto_issue`, calls the existing `statement_mark_issued()` helper.
  - Daily cron at **05:00 UTC** — after late fees (04:00) so
    same-day late_fee charges are included in the statement.
  - `payment_runs.run_kind` CHECK widened additively to
    include `'statement'`.
  - New permission `statements.manage` granted to admin + manager.
  - RLS: tenants on the lease can read their schedule; admin/manager
    modify.

- **Admin endpoints**:
  - `GET / PUT / DELETE /api/admin/leases/[id]/tenant-statement-policy`
    — CRUD with cross-field validation, soft-end on DELETE.
  - `POST /api/admin/tenant-statements/generate` — manual cron
    trigger. Idempotent thanks to the RPC's lookup.

- **Lease detail UI** — new "Statement schedule" section under
  Late-fee policy on `/admin/leases/[id].vue`:
  - Status badge (`active` / `off`) + human-readable summary
    ("monthly on first day of period · auto-issued · next run …").
  - Set up / Edit modal with cadence, fire-day, auto-issue toggle,
    notes.
  - **Generate now** button manually triggers the cron.
  - **Opt out** soft-ends the schedule.
  - Recent statements table (statement_no, period range, billed,
    paid, balance, status badge) — pulls from the existing
    `/api/leases/[id]/statements` endpoint.

### Added — Late-fee policy editor on lease detail

- `app/pages/admin/leases/[id].vue` Late-fee section now renders below
  Charges with status badge (`active` / `off`), human-readable summary
  ("Flat ₱500 capped at ₱2,000 after 5d grace, recurring every 7d"),
  and three actions:
  - **Set up / Edit** — opens the editor modal with full form (fee
    shape selector, amount/percent input, optional cap, grace days,
    recurrence kind + cadence, audited notes). PUT atomically pauses
    prior policy and inserts the new shape.
  - **Apply now** — manually triggers `assess_past_due_charges()` so
    operators don't have to wait for the 04:00 UTC cron after
    attaching a policy. Reports created / flipped / errors via toast,
    then refreshes the charges feed so new `late_fee` rows are
    visible.
  - **Opt out** — confirms then DELETEs (soft-end). Past assessments
    preserved in the ledger.

### Added — Late-fee auto-assessment (PM operational maturity)

- **Migration `20260508000004_late_fee_assessment.sql`**: closes the
  loop between `property_charges.past_due` and the existing `late_fee`
  charge kind. Two new tables + one cron RPC:
  - `late_fee_policies` — per-lease, opt-in. `fee_kind` is `flat`,
    `percent_of_balance`, or `escalating`. `recurrence_kind` is
    `once` or `recurring` (with `recurrence_days`). `cap_minor`
    ceiling. Partial UNIQUE enforces one active policy per lease.
    No global default — leases without a policy never accrue.
  - `late_fee_assessments` — append-only ledger keyed by
    UNIQUE(`source_charge_id`, `recurrence_index`) so the cron is
    fully re-run-safe; double-charging is impossible.
  - `assess_past_due_charges(today)` RPC: phase 1 flips overdue
    `open` rent/dues/maintenance_pass_through charges to `past_due`;
    phase 2 walks `past_due` charges with active policies, computes
    the fee, and inserts both the `late_fee` `property_charges` row
    and the `late_fee_assessments` row in the same transaction.
    `unique_violation` is caught and counted as `skipped` (not
    failed) so concurrent runs are benign.
  - Daily cron at **04:00 UTC** — after rent (03:30) and dues (03:35).
  - `payment_runs.run_kind` CHECK widened additively to allow
    `'late_fee'` (existing rows still satisfy the new constraint).
  - New permission `late_fees.manage` granted to admin + manager.
  - RLS: tenants on the lease can read their policy + assessments
    tied to their charges; writes are admin/manager only.
  - Schema governance contracts registered for both tables + the RPC.

- **Admin endpoints**:
  - `GET /api/admin/leases/[id]/late-fee-policy` — read active policy.
  - `PUT /api/admin/leases/[id]/late-fee-policy` — atomically pause
    the prior active policy + insert the new shape. Validates
    cross-field consistency (fee_kind ↔ amount column,
    recurrence_kind ↔ recurrence_days) and surfaces `23514` CHECK
    violations as `422`.
  - `DELETE /api/admin/leases/[id]/late-fee-policy` — opt-out.
    Soft-ends the active policy; ledger is preserved.
  - `POST /api/admin/late-fee/assess` — manual cron trigger
    (operator just attached a policy and wants fees applied today).
    Idempotent thanks to the assessment ledger.

### Added — Owner Portal Invitation pipeline (symmetric to tenant)

- **Migration `20260508000003_owner_portal_invitations.sql`**: mirror
  of the tenant pipeline but binds `property_owners.user_id := auth.uid()`
  on accept. Same hash-stored single-use tokens, partial UNIQUE for one
  active invitation per property owner, three SECURITY DEFINER RPCs
  (`issue_owner_portal_invitation` / `accept_owner_portal_invitation`
  / `revoke_owner_portal_invitation`). Reuses `hash_portal_token()`
  from the tenant migration. Permission gate:
  `property.manage` OR `admin.access`. Same governance contracts
  pattern: table + 2 cross-repo RPCs registered.
- **Admin endpoints** under `/api/admin/owner-portal-invitations/`:
  same shape as tenant — POST issue (returns single-use accept_url),
  GET list with status filter, POST `[id]/revoke`. Token hash never
  returned; cleartext token never logged.
- **Email template** `owner_portal.invitation` added to
  `renderEmail()` — branded subject + portfolio-focused copy.

### Added — Admin UI hook for tenant invitations

- `app/pages/admin/leases/[id].vue` Parties section now renders, per
  tenant party:
  - **Status badge** — `portal · linked` (lease_parties.user_id set),
    `portal · active|accepted|revoked|expired` (most recent
    invitation), or `portal · not invited`. Backed by a per-party
    parallel fetch against `GET /api/admin/tenant-portal-invitations`.
  - **Invite to portal** / **Re-invite** action button — opens a modal
    that pre-fills the recorded email + 14-day default, calls
    `POST /api/admin/tenant-portal-invitations`, and on success shows
    the cleartext accept_url with a Copy button. The result panel
    distinguishes "Email sent" vs "Email NOT sent" so operators
    immediately know whether they need to deliver the link manually.
  - **Revoke** action — opens a modal requiring an audited reason and
    POSTs to `/api/admin/tenant-portal-invitations/[id]/revoke`. The
    badge refreshes in the background after issue/revoke.

### Fixed — pgcrypto search_path on Supabase

- Migration `20260508000002` originally placed `digest()` calls inside
  a `SET search_path = public` function and failed with
  `42883 function digest(text, unknown) does not exist` on Supabase
  (pgcrypto installs into `extensions`, not `public`). Edited the
  migration in place — the failed run rolls back atomically, so
  re-running the same file from the top recreates everything cleanly.
  Saved a feedback memory so future migrations follow the pattern:
  `CREATE EXTENSION ... WITH SCHEMA extensions`,
  `SET search_path = public, extensions`, and schema-qualify the call
  as `extensions.digest(p_token::bytea, 'sha256'::text)`.

### Notes

- **Email provider is wired**: contrary to a prior memory snapshot,
  `server/utils/email.ts` already calls Resend (with kill switch
  `EMAIL_DELIVERY_DISABLED=1` and graceful no-op when keys are unset).
  Launch-blocker #3 from `LAUNCH_STATUS.md` is misclassified —
  it's "decide on Resend / set keys", not "wire a provider".
- **Public website portal pages are NOT shipped this slice.** Two
  scaffolding files were created in `websiteo/` before the
  userportal-only redirect:
    - `websiteo/app/plugins/1.supabase.client.ts` — browser Supabase
      client with persisted session.
    - `websiteo/app/composables/usePortal.ts` — session + RLS-scoped
      data helpers (leases / charges / maintenance / acceptInvitation).
  Both are inert: no `/portal/*` routes, no middleware, no consumers.
  They can be safely removed or kept as a head-start for the next
  website slice.

---

## 2026-05-07

### Added — Phase B / Marketplace completion

- **Per-source ingestion run history.** Migration `20260507000001` adds
  `listing_source_ingest_runs` (processed / inserted / updated / errors
  per ingest cycle). Surfaced in the admin Sources tab via a new
  `GET /api/admin/listing-sources/:id/runs` endpoint and the inline
  "View runs" expander in `SourcesTable.vue`.
- **Outbound webhooks.** Migration `20260507000002` adds
  `webhook_subscriptions` + `webhook_deliveries`, gated by a new
  `webhooks.manage` permission (admin-only). New
  `server/utils/webhooks.ts` dispatcher signs each delivery with
  HMAC-SHA256, hard 5s timeout via AbortController, auto-disables a
  subscription after 10 consecutive failures. Replay protection via
  `webhook-timestamp` + `webhook-signature` headers (Slack-style).
  Currently fired from the public inquiries endpoint
  (`inquiry.received`); admin CRUD endpoints under
  `/api/admin/webhook-subscriptions/*` enforce an SSRF guard rejecting
  RFC1918 / loopback URLs.
- **"Just listed" / "Price changed" badges on listing cards.** Migration
  `20260507000003` adds `listings.price_changed_at` + a BEFORE UPDATE
  trigger that stamps it on `sale_price` / `rent_price` change.
  `websiteo/server/utils/listingsApi.ts` now surfaces it in the public
  column allowlist; `websiteo/app/components/Listings/Listing.vue`
  renders 🆕 "Just listed" when `created_at` is within 7 days, 💸
  "Price changed" when `price_changed_at` is within 7 days
  (mutually exclusive — fresh listings show "Just listed").
- **Legacy creator reconciliation utility.** Migrations
  `20260507000004` / `20260507000005` / `20260507000006` add the
  `legacy_creators_summary` + `legacy_creators_apply` RPCs, gated by a
  new `legacy.reconcile` admin permission. The flow: admin opens the
  new Reconcile tab in `/admin`, sees per-column counts of unreconciled
  rows + suggested profile matches (exact-name first, fuzzy via
  `pg_trgm` if installed), clicks Apply to atomically write the
  canonical FK and NULL the matching `*_legacy` column. Audited via
  `log_activity('listing.legacy_reconciled', ...)`. The follow-up
  migrations widen the gate to allow `session_user IN (postgres,
  supabase_admin, service_role)` (so SQL editor smoke tests work) and
  add a column-existence guard so the UI surfaces a friendly empty
  state on databases that never had the legacy columns.
- **Listing change history drawer.** Migration `20260507000007` adds
  the `listings_audit_diff` AFTER UPDATE trigger that captures
  field-level diffs into `activities.metadata.changes` for ~22
  whitelisted business columns (title, prices, beds, status,
  contact_id, etc.). New `ListingHistoryDrawer.vue` slide-over,
  triggered from the per-row ⋮ menu in the listings table, renders
  the full timeline + expandable before→after diff blocks. Existing
  inline timeline on the listing-detail page also benefits from the
  new diff data.
- **RLS policy test harness.** New `tests/rls/` directory with an
  opt-in harness that signs into a real Supabase project as synthetic
  users at each role (admin / manager / agent_a / agent_b) and
  asserts each table's policies. Three concrete suites:
  `webhook-subscriptions.test.ts`, `legacy-reconcile.test.ts`,
  `inquiries.test.ts`. See `docs/RLS_TESTS.md`. Default `pnpm test`
  skips the suite unless `SUPABASE_TEST_PROJECT=1` is set, so CI
  without DB secrets stays green.

### Fixed

- **Dashboard activity feed regression.** `server/api/dashboard/activity.get.ts`
  was selecting `actor_user_id` from `public.activities`. The
  activities table uses `user_id` (per migration `20260429000006`) —
  `actor_user_id` is on `public.notifications`. The widget was
  silently empty in production. Fixed + added a comment block calling
  out the column-name trap so the next reader doesn't repeat it.
- **Public inquiries unhandled rejection.** `void dispatchWebhook(...)`
  in `server/api/public/inquiries/index.post.ts` and
  `void sendEmail(...)` in `server/api/public/saved-searches/index.post.ts`
  were producing `[request error] [unhandled]` log noise (and
  occasionally cutting connections so the visitor saw the mailto
  fallback). Replaced both with `.catch()` patterns that log a
  bounded, searchable warn line. Doc-comment in `server/utils/webhooks.ts`
  updated so future callers don't repeat the pattern.
- **Public inquiries 500 on orphan `created_by`.** Listings whose
  `created_by` UUID doesn't have a matching `profiles` row (legacy
  data, deleted users, ingested feed rows) caused
  `inquiries.assigned_user_id` FK violations → 500 → website mailto
  fallback. The endpoint now profile-preflights `created_by` and
  falls back to `assigned_user_id = NULL` (with a
  `public_inquiries_orphan_assignment` warn log) when the profile
  isn't there. Inquiry lands in the queue as unassigned;
  manager / admin routes it manually.

### Added — Backend feature build-out (migrations 31-45)

- **Ops health dashboard remediation.** Migration `20260507000031`
  re-applies the `system_metric_snapshots` table + `ops_overview()`
  / `ops_metrics_downsampled()` RPCs that mig 14 partially landed.
  Also fixes the `ops_alerts` cron severity ladder (critical = last
  run failed, warning = had prior success but overdue >25h, info =
  never run on a fresh deploy).
- **Geo Discovery + Heatmap Intelligence.** Migration `20260507000032`
  adds 4 heatmap RPCs (inventory / trust / luxury / velocity) +
  `market_hot_areas()` per-barangay scoring with within-city
  z-scores. Powers the public website's neighborhood heat surface.
- **Market Alerts + Watch Engine.** Migration `20260507000033` adds
  `market_watches` (polymorphic subscription), `market_alert_dispatches`
  (dedup ledger), and a 30-min `evaluate_market_watches()` worker.
  Mig 36 fixes a `lv.updated_at` / `verified` column-name drift in
  the worker.
- **Public Market & Geo Intelligence APIs.** Migrations `20260507000034`
  and `20260507000035` add anon-callable `public_*_market_snapshot`,
  `public_market_index`, `public_heatmap_grid`, `public_building_intelligence`,
  and `public_hot_area_summary` RPCs. Sample-size thresholds
  (≥10 city / ≥5 barangay) prevent thin-data misinformation.
- **MLS duplicate detection + merge.** Migration `20260507000037`
  creates `listing_duplicate_candidates` (pair-keyed, weighted
  signals: same broker +20, floor area +30, price +25, bedrooms
  +10, title trigram +10, geom +5, threshold 50) with two crons
  (nightly + 30-min). Migration `20260507000042` adds
  `listings.duplicate_of_id` self-FK + `merge_listing_duplicate`
  RPC. Public website redirects merged-loser URLs to the canonical
  via real HTTP 301 (`websiteo/server/api/public/listings/[id].get.ts`).
- **Broker import pipeline.** Migration `20260507000038` adds
  `broker_import_batches`, `broker_import_rows`, `broker_invitations`
  (UNIQUE on email+org), `process_broker_import_batch` RPC. Match
  existing profile or create invitation per row. Migration
  `20260507000041` adds `link_shared_at` / `email_sent_at` /
  `email_send_error` lifecycle columns.
- **Listing import pipeline.** Migration `20260507000039` adds the
  same staged import for listings — resolution chain
  `org_slug → broker_email → broker-in-org → city_slug → barangay_slug
  → building_name (exact + pg_trgm fuzzy ≥0.7 within city)`. Created
  listings ship `is_online=false` for moderation. Migration
  `20260507000040` adds the image-ingest queue + 2-min cron drainer
  that downloads → Sharp normalizes (1600px JPEG main + 635×423
  thumbnail) → uploads to S3 → attaches `listing_images`.
- **Public website sort modes.** `websiteo/server/api/public/listings.get.ts`
  gets a `sort_mode` query param backed by a hardcoded
  `SORT_COLUMNS` allowlist (recommended / highest_quality / trusted /
  fastest_moving / undervalued / luxury_priority / newest). Pre-resolves
  top-N from `listing_discovery_score` + `<SortDropdown />` in
  `pages/map.vue`.
- **Mailgun removal.** Mailgun integration retired. `server/utils/email.ts`
  becomes a logging no-op stub; templates + call-sites preserved
  provider-agnostic for the next provider drop-in. Saved-search
  digest worker still runs the matching logic and stamps
  `last_digest_sent_at`, just doesn't actually send.
- **DB Growth Metrics.** Migration `20260507000043` adds
  `system_table_size_snapshots` (daily per-table size) +
  `ops_db_growth()` RPC (latest sizes + 24h/7d byte deltas) +
  daily 03:30 UTC cron + 90-day prune. Visible as the Storage
  panel on `/admin/operations`. (Hit a `42P17` IMMUTABLE
  expression error on first apply with `date_trunc('day',
  timestamptz)`; fixed with a STORED generated column
  `(captured_at AT TIME ZONE 'UTC')::date` to pin timezone — see
  `feedback_immutable_index_expressions.md` memory.)
- **Per-domain operations health.** Migration `20260507000044`
  adds `ops_domain_health()` RPC returning a single jsonb with 6
  domain sections (webhooks, ingest, cron, rate_limits,
  notifications, search) + KPI counts + top-5 problem-item arrays.
  Backs the new `OpsDomainPanels.vue` block on
  `/admin/operations`.
- **Admin-tunable alert thresholds.** Migration `20260507000045`
  moves the 4 hardcoded `ops_alerts` view thresholds (5 webhook
  failures, 10 disabled, 5min retry-stuck, 26h cron overdue) into
  `ops_alert_thresholds(key, value_int)` with a STABLE helper
  `ops_alert_threshold(key)` (hardcoded fallbacks if a row is
  missing). Editable from `/admin/operations` via the new
  `OpsAlertThresholds.vue` panel.
- **Webhook deliveries auto-refresh.** `WebhookSubscriptions.vue`
  gains 30s polling that activates only when there are active
  retry chains (any `consecutive_failures > 0` enabled subscription
  OR open retry-queue panel with rows). Pulses an "Auto-refreshing"
  pill in the header while active.
- **Saved-search digest preview admin UI.** New
  `SavedSearchPreviewTab.vue` admin tab (Infrastructure group)
  with two-mode form (ad-hoc filters JSON + recipient name /
  since N days, OR existing subscription UUID). POSTs to the
  side-effect-free `/api/admin/saved-searches/preview` endpoint
  and renders the resulting email HTML in a sandboxed iframe
  (`srcdoc` + `sandbox="allow-same-origin"`).
- **Phase 2B users table enrichment.** New endpoint
  `server/api/admin/users/list-enriched.get.ts` joins profiles +
  `organization_memberships` (status='active') +
  `profile_verifications` (approved) + recent `activities` rows
  server-side. `UsersTable.vue` adds Organization (name + role),
  Verified (decagram pill), and Last active columns; falls back
  to `listProfiles()` if the enriched endpoint 404s.

### Added — UI redesign (premium SaaS aesthetic)

- **Design language.** Codebase-wide migration from legacy
  `text-black-80` / `bg-blue-20` / `bg-blue-30` / `border-gray-100`
  / `border-gray-200` / `bg-gray-50` to theme tokens
  (`text-foreground`, `text-muted-foreground`, `bg-card`,
  `border-border`, `bg-accent`, `bg-muted-foreground/{5,10,15}`).
  Card chrome shifted from `rounded-xl border-gray-100 bg-white
  shadow-sm` to flat `rounded-2xl border-border bg-card`. Status
  pill family softened from saturated `100/800` to the standard
  `50/700 ring-100` treatment. Affects ~40+ files across the
  userportal admin shell, dashboard widgets, detail pages, and
  pages still on legacy chrome (featured-listings, deck, archives,
  outdated, my-profile, notifications).
- **Shared primitives.** New `app/components/EmptyState.vue` with
  3 semantic variants (success / neutral / error), icon override
  via slot, optional CTA slot. New `app/components/Skeleton.vue`
  primitive (block / circle shape). Adopted across the dashboard,
  needs-attention panel, tasks/inquiries/contacts/deals pages,
  webhook subscriptions, all admin tabs, verifications cluster,
  saved-search preview, Phase 2B users table.
- **Dashboard redesign (Phase 1).** New
  `/api/dashboard/attention.get.ts` aggregator (7 operational
  signals in one round-trip with per-section error isolation).
  `DashboardHero.vue` (greeting + contextual operational summary
  + 3 primary CTAs). `NeedsAttentionPanel.vue` (Linear-style
  severity-coded row list with drilldown). Refreshed `KpiStrip.vue`
  (gradient bars + rainbow chips dropped). Rewritten `dashboard.vue`
  layout (Hero → KPIs → NeedsAttention 2/3 + Activity 1/3 →
  TrendChart 2/3 + Listings split 1/3 → Funnel + MyTasks +
  MyInquiries → portfolio cards + DeckCTA → CrmWidgets → footer).
- **Sidebar regrouping (Phase 2).** Collapsed the 9-color icon
  chip rainbow to a single neutral palette + one accent bar (blue)
  for active rows. Regrouped the 5-section nav into 4 groups
  (Workspace / Documents / Analytics / Admin) per the brief.
- **Navbar redesign (Phase 2).** Stripped the dead horizontal nav
  list + duplicate brand logo on lg+. Added sticky
  `bg-card/80 backdrop-blur-md` header, lg+ global search trigger,
  mobile icon-only search button, **Create** dropdown (New listing /
  contact / task / inquiry), refreshed avatar pill.
- **Charts + skeleton loaders (Phase 3).** `TrendChart.vue` and
  `InquiryFunnel.vue` chrome refreshed; loading states use the
  shared `<Skeleton />`; empty states delegate to `<EmptyState />`.
- **Admin shell redesign.** Replaced 17 horizontal pills with a
  240px secondary nav grouped 4-way (Identity & Access / Data
  Operations / Moderation & Review / Infrastructure). New
  `AdminHero.vue` ("Operations Control Center" title + dynamic
  subtitle + 5-card KPI strip). New `/api/admin/summary.get.ts`
  endpoint. Mobile fallback: select dropdown.
- **Users table data table.** Sticky header, real `<table>`,
  avatar with `<img>` + initial fallback, role-as-colored-badge
  (admin=red / manager=blue / agent=muted) clickable to enter
  inline edit, `…` actions menu, joined date with relative
  formatting. Self-lockout guard preserved.
- **Detail page refreshes.** Tasks, inquiries, contacts, deals
  pages all migrated to the new design system: `rounded-2xl`
  cards, theme tokens, sticky table headers where applicable,
  selected-row accent left-bar pattern, status-badge softening,
  bulk action bars where relevant.
- **Command palette wiring.** `AdminSecondaryNav.vue` registers
  all 17 admin tabs as palette commands grouped under
  "Admin · *" labels. `Navbar.vue` registers the 4 quick-create
  items under a "Create" group. ⌘K now surfaces ~33 commands
  spanning Navigate (sidebar) + Create (Navbar) + Admin · *
  (admin secondary nav). Auto-unregister on unmount keeps the
  palette clean across route changes.

---

## 2026-05-06

### Added — Phase A / Stabilization

- **Anon-safe public listing read surface.** Migration `20260506000001`
  introduces `public_listing_details` view excluding contact PII.
  Migration `20260506000002` schedules a 5-min `pg_cron` MV refresh.
  The full F-5 Phase 2 (REVOKE on the original MV) is intentionally
  deferred pending an API-log audit.
- **Profile slugs + public collaborators view.** Migrations
  `20260506000003` (slug column + backfill + trigger), `20260506000004`
  (`public_listing_collaborators` view joining `listing_shares` ×
  `public_profiles`), `20260506000008` (`profile_verifications` table
  + verified flag on the view), `20260506000009` (collaborators view
  recreation with `verified` at the correct column position — fixed
  a `42P16` view-column-rename error from 000008).
- **Saved-search subscriptions + digest.** Migrations `20260506000005`
  through `20260506000007` add the subscription table, due-for-digest
  RPC, and a daily 22:00 UTC `pg_cron` + `pg_net` digest job.
  Wiring on the website is intentionally deferred pending the proxy
  endpoint design.
- **Listings search indexes + clustering.** Migrations `20260506000010`
  (B-tree partial + tsvector + GIN), `20260506000011` (PostGIS for
  buildings — fixed `RAISE EXCEPTION` guard, `search_path` to include
  `extensions` schema, bigint cast for `listings.id`), `20260506000012`
  (`listings_clusters` RPC — renamed CTE aliases to dodge the
  `42702` ambiguity between OUT-param and same-named CTE column).
- **Listing sources registry + ingestion.** Migrations `20260506000013`
  through `20260506000015`: `listing_sources` table with
  admin-only RLS, secret rotation RPC, daily 23:00 UTC sweep that
  archives listings whose source hasn't reported them in N days.
- **Atomic rate limiting.** Migration `20260506000016` adds the
  `check_rate_limit` RPC (atomic UPSERT on `rate_limit_buckets`)
  + cleanup cron. Mirrored in `server/utils/rate-limit.ts` and the
  website. Used by the public inquiry endpoint (10/hour/IP).

### Added — Phase B / Marketplace completion

- **Public verifications queue.** New admin tab `Verifications` driven
  by `VerificationsQueue.vue` + `PATCH /api/profile-verifications/[id]`.
  Approved badges surface on agent profile pages and inquiry-success
  cards.
- **Agent public profile pages.** New website route
  `/agent/[slug]` with JSON-LD `Person` schema; sitemap entry under
  `/sitemap-agents.xml`. `PropertySidebar.vue` rewrites to render
  primary agent + co-broker chips + Ask Agent button. Inquiry
  success card surfaces verified badge on primary + chips on
  co-brokers.
- **Notifications inbox + dashboard widgets.** New `/notifications`
  full-inbox page; new dashboard widgets `MyOpenTasks` and
  `MyRecentInquiries`. `notify()` helper centralizes service-role
  fan-out so callers don't lock themselves out of the recipient's
  preferences (default opt-in for email; explicit `false` opts out).

### Added — Cross-cutting

- **Admin shell.** `/admin` page with six tabs (Users, Roles &
  Permissions, Verifications, Sources, Activity, Broadcast) — each
  lazy-mounted via `KeepAlive` so the first switch is the only fetch.
  `SystemStatusCard.vue` reads `/api/admin/system-status` for
  one-line health.
- **Audit / activity coverage.** Extended `AuditEntity` and
  `AuditAction` unions in `server/utils/audit.ts` with `task` /
  `note` / `inquiry` / `verification` / `webhook.*` /
  `broadcast.sent` / `listing.ingested` / `listing.legacy_reconciled`.
  Repository pattern in `server/repositories/*.repo.ts` co-locates
  CRUD + audit + notify so individual handlers stay short.

---

## Migration order

Deploy migrations in numeric order. Many depend on earlier ones; the
ones that need explicit callouts:

| Migration | Depends on |
|---|---|
| `20260506000004_public_listing_collaborators` | `000003` (profiles.slug) |
| `20260506000009_collaborators_view_verified` | `000008` (profile_verifications), recreates the view at column position 7 — must be applied as a follow-up to `000008` |
| `20260506000011_buildings_postgis` | PostGIS extension installed in the `extensions` schema (Supabase default) |
| `20260507000005` / `20260507000006` | `20260507000004` (re-CREATE OR REPLACE with the same signatures) |
| `20260507000007_listings_audit_diff_trigger` | `20260429000006` (`activities` table + `log_activity`) |
| `20260507000031_ops_health_dashboard_remediation` | `20260507000014` (re-applies pieces that hadn't fully landed) |
| `20260507000036_evaluate_market_watches_verifications_fix` | `20260507000033` (column-name fix for the worker) |
| `20260507000037_mls_duplicate_detection` | `pg_trgm` extension |
| `20260507000040_listing_image_ingest_queue` | `20260507000039` (trigger fires on `listing_import_rows.outcome`) |
| `20260507000042_listing_duplicate_merge` | `20260507000037` (candidate row + audit columns) |
| `20260507000043_db_growth_metrics` | uses `(captured_at AT TIME ZONE 'UTC')::date` STORED column to satisfy IMMUTABLE-in-index requirement (42P17) |
| `20260507000044_ops_domain_health` | uses `cron.job_run_details` — wraps in `pg_extension` check so projects without `pg_cron` still resolve |
| `20260507000045_ops_alert_thresholds` | recreates the `ops_alerts` view; thresholds are read via the new `ops_alert_threshold(key)` STABLE helper |

## Operational notes

- **Cron jobs registered:** 5-min `listing_details` MV refresh (000002),
  daily 22:00 UTC saved-search digest (000007), daily 23:00 UTC stale
  source listings archive (000015), `check_rate_limit` cleanup (000016),
  5-min ops metrics snapshot (000031), 30-min `evaluate_market_watches`
  (000033), nightly + 30-min duplicate-candidate detection (000037),
  2-min listing image queue drain + daily prune (000040), daily
  03:30 UTC table-size snapshot + 04:40 prune (000043). All require
  `pg_cron` + `pg_net` extensions.
- **Service-role usage** is now sanctioned in 5–6 places only: public
  inquiries, saved-searches confirmation, ingest, broadcasts, webhooks
  dispatcher, saved-search create. Direct service-role use elsewhere
  in the client is a smell — route through a server endpoint instead.
- **Deferred (need user input):** F-5 Phase 2 (`REVOKE` on the original
  `listing_details` MV), DROP of legacy `*_legacy` quarantine columns
  after reconciliation, CDN/image optimization, saved-search wiring
  with the proxy endpoint, real `srcset` for listing cards.
