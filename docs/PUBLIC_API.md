# Public API

**Status:** authoritative contract for HTTP endpoints exposed to anonymous and partner traffic.
**Owner:** Portal repo (most write endpoints) + Website repo (most read endpoints).
**Last verified:** 2026-05-07 (rate-limit coverage extended to search GETs).

This document covers **HTTP endpoints**. For the data-layer contract
(anon-readable Supabase tables/views), see
[`PUBLIC_DATA_SURFACE.md`](./PUBLIC_DATA_SURFACE.md).

---

## Versioning + stability

There is no URL version prefix. Treat the current shape as **v1**. Any
breaking change ships as a parallel endpoint (e.g., `/api/public/listings/v2`)
with the v1 surface kept available for at least one quarter.

**Stability tiers:**

| Tier | Means |
|---|---|
| **Stable** | Shape changes only via parallel endpoint. Partners can pin against it. |
| **Best-effort** | Shape changes possible with a release-note heads-up; consumers should be defensive. |
| **Internal** | Used by the website only. May change without notice. Don't integrate. |

Each endpoint below is tagged with its tier.

---

## Auth model

| Auth | Where | Header |
|---|---|---|
| **Anonymous** | Public reads, public form submits | (none — Supabase anon key on the server side, not exposed to partners) |
| **Source secret** | Partner ingestion | `x-source-secret: <listing_sources.ingest_secret>` (constant-time compared) |
| **Admin JWT** | Manual triggers, admin endpoints | Standard Supabase auth bearer for an `admin`-role user |
| **Cron secret** | Internal scheduled triggers | `x-internal-secret: <INTERNAL_CRON_SECRET>` (env var, constant-time compared) |

Partners only need **source secret**. The other auths are internal.

---

## Error envelopes

All endpoints return JSON. Errors follow these shapes:

**Validation (422):**
```json
{
  "statusCode": 422,
  "statusMessage": "Validation failed",
  "data": {
    "issues": [
      { "path": ["sender_email"], "message": "Invalid email" }
    ],
    "step": "validate"
  }
}
```

**Domain failure (4xx other):**
```json
{
  "statusCode": 404,
  "statusMessage": "Listing not accepting inquiries",
  "data": { "step": "listing_not_found" }
}
```

The `step` field is a stable identifier the server logs at the same
log line. When you see `data.step` in a response, you can ask portal
operators to grep logs for the matching step in the same time window —
no body content traded, single source of truth.

**Rate limit (429):**
```json
{
  "statusCode": 429,
  "statusMessage": "Too many requests",
  "data": {
    "retry_after_seconds": 1234,
    "limit": 10,
    "window_started_at": "2026-05-07T08:00:00Z"
  }
}
```

Plus `Retry-After` and `X-RateLimit-*` response headers (see next section).

**Service unavailable (503):**
- Database unavailable, kill-switch tripped, or required extension/RPC missing.
- `data.step` may include `feature_flag_disabled`.

---

## Rate-limit headers

Set on every protected endpoint, success or 429:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | Max requests per window |
| `X-RateLimit-Remaining` | How many you have left in this window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |
| `Retry-After` | Seconds to wait — only on 429 |

Polite clients should back off when `X-RateLimit-Remaining` approaches 0.

**Rate-limited endpoints today:**

| Endpoint | Limit | Window |
|---|---|---|
| `POST /api/public/inquiries` | 10 | 1 hour |
| `POST /api/public/saved-searches` | 5 | 1 hour |
| `GET /api/public/search-suggestions` (cache misses only) | 60 | 1 minute |
| `GET /api/public/search-preview` (cache misses only) | 60 | 1 minute |

Cached responses on the GET endpoints don't count — Nitro's cache wrapper serves them before the handler runs. Only origin-hitting (cache-miss) requests are bucketed. A real user's debounce-typed search bar comfortably fits within 60/min while an attacker cycling through every prefix gets blocked quickly.

The shared counter store is the Postgres `rate_limit_buckets` table (migration `20260506000016`), so multi-instance Nuxt deploys agree on counts.

Failure mode: the limiter **fails open** if the underlying RPC errors. Better to over-serve briefly than to DOS legitimate users with our own flaky limiter.

---

## Read endpoints (Tier: Stable unless flagged)

All cached on the Nitro server with `Cache-Control: public, s-maxage=N, stale-while-revalidate=M`. Cloudflare / CloudFront caches honor these.

### Listings

| Route | Cache | Notes |
|---|---|---|
| `GET /api/public/listings` | 5 min / 10 min SWR | Filter via `category`, `for=buy\|rent`, `minPrice`, `maxPrice`, `bedroomsMin/Max`, `cityId`, `barangayId`, `propertyId`, `north/south/east/west`, `limit`. |
| `GET /api/public/listings/[id]` | 10 min / 30 min SWR | Single listing detail. |
| `GET /api/public/listings/[id]/nearby` | 10 min / 30 min SWR | Same barangay/city, newest 6. |
| `GET /api/public/listings/[id]/similar` | 10 min / 30 min SWR | ±20% price band, same category. |
| `GET /api/public/listings/by-ids?ids=…` | 5 min / 10 min SWR | Bulk lookup. Used by Favorites / Portfolio. |
| `GET /api/public/listings/clusters?north&south&east&west&zoom` | 5 min / 10 min SWR | PostGIS grid-aligned clusters. Returns up to 500 cells. |
| `GET /api/public/listings/[id]/collaborators` | 5 min / 30 min SWR | Primary agent + accepted co-brokers (with `verified` flag). |

### Search

| Route | Cache | Notes |
|---|---|---|
| `GET /api/public/search?path=&query=` | 5 min / 10 min SWR | URL-slug-driven results. |
| `GET /api/public/search-suggestions?term=` | 5 min / 10 min SWR | Cities/areas/buildings (location suggestions). **Rate-limited: 60 cache-miss/min/IP.** |
| `GET /api/public/search-preview?term=&category=` | 5 min / 10 min SWR | Top-3 listings via tsvector match. **Rate-limited: 60 cache-miss/min/IP.** |
| `GET /api/public/search-result-path?…` | cached | URL slug resolution for filter combinations. |

### Buildings + reference data

| Route | Cache | Notes |
|---|---|---|
| `GET /api/public/buildings` | 5 min / 10 min SWR | All curated buildings. |
| `GET /api/public/buildings/[slug]` | 5 min / 10 min SWR | Single building + units. |
| `GET /api/public/cities` | 1 hour | City list for filter dropdowns. |
| `GET /api/public/area-count` | 5 min / 10 min SWR | Listing count per area. |
| `GET /api/public/featured-deck` | 5 min / 10 min SWR | Curated homepage carousel. |

### Agents

| Route | Cache | Notes |
|---|---|---|
| `GET /api/public/agents/[slug]` | 5 min / 30 min SWR | Public agent profile + their listings. |
| `GET /api/public/agent-card?listing_id=` | 5 min / 10 min SWR | Compact agent card for a listing's primary agent. |

### Market data

| Route | Cache | Notes |
|---|---|---|
| `GET /api/public/market-benchmark?…` | 30 min | Pre-aggregated market data. **Tier: best-effort** (data sources may evolve). |

---

## Write endpoints

### `POST /api/public/inquiries`  · Tier: Stable

Public visitors submit inquiries on a listing. Anonymous; honeypot trap; rate-limited.

**Request body:**
```json
{
  "listing_id": 123,
  "sender_name": "Jane Doe",
  "sender_email": "jane@example.com",
  "sender_phone": "+63 9XX XXX XXXX",
  "message": "Is this still available?",
  "source": "website",
  "website": ""
}
```

- `listing_id`: integer, must reference an `is_online=true AND deleted_at IS NULL` row.
- Either `sender_email` OR `sender_phone` must be present.
- `message`: 1–5000 characters.
- `website`: honeypot — must be empty string. Bots filling it get a silent 201.

**Rate limit:** 10 requests / hour / client IP.

**Responses:**
- `201 Created` — `{ "id": "<uuid>" }` (or `{ "id": "honeypot" }` silently if the trap fired).
- `404` — listing not found / not online.
- `422` — validation failed; see issues array.
- `429` — rate limited.
- `503` — `PUBLIC_INQUIRIES_DISABLED=1` env kill-switch is on, or service-role not configured.

**Side effects on success:**
- Row inserted in `public.inquiries`.
- In-app notification + email fan-out to the listing's `created_by` agent.

---

### `POST /api/public/saved-searches`  · Tier: Stable

Anonymous email subscription to listing-search digests. Double-opt-in via a confirmation email.

**Request body:**
```json
{
  "email": "you@example.com",
  "name": "Makati 2BR rentals",
  "filters": {
    "category": "residential",
    "for": "rent",
    "minPrice": 50000,
    "maxPrice": 100000,
    "bedroomsMin": 2,
    "cityId": 1
  },
  "digest_frequency": "weekly",
  "website": ""
}
```

- `email`: required, RFC-shaped, lowercased server-side.
- `name`: optional, ≤80 chars.
- `filters`: object; only whitelisted top-level keys retained (others silently dropped). Whitelist: `category, for, minPrice, maxPrice, bedroomsMin, bedroomsMax, cityId, barangayId, propertyId, path`.
- `digest_frequency`: `"daily"` or `"weekly"` (default `"weekly"`).
- `website`: honeypot — must be empty.

**Rate limit:** 5 requests / hour / client IP.

**Responses:**
- `201 Created` — `{ "id": "<uuid>" }`. **Confirmation email sent to `email`.** Tokens are NOT returned in the response — they reach the user only via the email.
- `422` — validation failed.
- `429` — rate limited.
- `503` — `SAVED_SEARCHES_DISABLED=1`.

**Side effects:** subscription row created with `confirmed_at = NULL`. Cron worker only digests confirmed rows.

---

### `GET /api/public/saved-searches/confirm/[token]`  · Tier: Stable

User clicks the link in the confirmation email. Idempotent.

**Path param:** `token` — 64-hex-char string from email.

**Response:** HTML page (`text/html`). 200 on success or already-confirmed; 404 on unknown / malformed.

---

### `GET /api/public/saved-searches/unsubscribe/[token]`  · Tier: Stable

User clicks the unsubscribe link in any digest email. Hard-deletes the subscription. Idempotent.

**Path param:** `token` — 64-hex-char string.

**Response:** HTML page. 200 on success or already-removed.

---

### `POST /api/admin/listings/ingest`  · Tier: Stable (partner contract)

**This is the partner-facing ingestion endpoint.** Bulk upsert listings from a registered source.

**Auth (either):**
- Header `x-source-secret: <listing_sources.ingest_secret>` for the source named in `source_slug`. Constant-time compared.
- OR an admin-role JWT (manual ops trigger).

**Request body:**
```json
{
  "source_slug": "mls_xyz",
  "listings": [
    {
      "foreign_id": "P-12345",
      "title": "Penthouse with City View",
      "description": "...",
      "building_id": 42,
      "contact_id": 100,
      "city_id": 1,
      "barangay_id": 7,
      "property_category": "residential",
      "property_type": "condo",
      "for_sale": true,
      "for_rent": false,
      "sale_price": 50000000,
      "bedrooms": 3,
      "bathrooms": 2,
      "floor_area": 120,
      "lot_area": null,
      "parking_spaces": 1,
      "is_online": true,
      "availability_date": "2026-06-01"
    }
  ]
}
```

**Constraints:**
- `source_slug`: must match an existing `enabled = true` row in `listing_sources`.
- `listings`: 1–500 rows per call. Chunk and retry for larger payloads.
- `foreign_id`: required, your own stable ID for the listing within your system. Forms the upsert key with `source_slug`.
- All other listings columns optional and validated. Unknown extra fields silently dropped (passthrough Zod).
- `building_id` should reference an existing `public.buildings.id`. If you don't have one, contact admin to seed buildings first; the importer can't auto-create them in v1.

**Idempotency:** keyed on `(source_id, foreign_id)`. Sending the same payload twice updates the row in place; `source_observed_at` is restamped to `now()`.

**Responses:**
- `200 OK`:
  ```json
  {
    "processed": 100,
    "inserted": 23,
    "updated": 75,
    "errors": [
      { "foreign_id": "P-99999", "reason": "building_id 9999 not found" }
    ],
    "source": { "slug": "mls_xyz", "last_ingested_at": "2026-05-07T08:00:00Z" },
    "triggered_by": "source"
  }
  ```
  Per-row failures are surfaced in `errors[]` and don't abort the batch. The successfully-processed rows are committed.
- `404` — source not found or disabled.
- `413` — batch over 500 rows.
- `422` — body shape invalid.
- `401` — neither admin JWT nor matching source secret.

**Lifecycle hook:** rows whose `source_observed_at` is older than the source's `staleness_ttl_hours` (default 168 = 7 days) are auto-flipped to `is_online=false` by a daily cron at 23:00 UTC. Re-sending the listing in a subsequent ingest run flips it back online.

**Audit:** one summary `listing.ingested` activity event per ingest call, with counts in `metadata`.

**Side effects:**
- Listing rows inserted/updated.
- `listing_sources.last_ingested_at` stamped.
- Materialized view `listing_details` refreshed inline so public reads see the change within seconds.

---

### `POST /api/public/building-thumbnails`  · Tier: Stable

Batch sign URLs for building thumbnails. Used by the buildings grid.

**Request body:** `{ "building_ids": [1, 2, 3] }` (1–100 ids).

**Response:** `{ "thumbnails": { "1": "https://…signed", "2": null, "3": "https://…signed" } }`. 7-day signed URL TTL.

---

## Endpoints to NOT integrate (Tier: Internal)

These exist for the website's own use. Integrating against them will break:

- `GET /api/public/search-result-path` — internal slug resolver.
- `POST /api/listing-thumbnails` — website-internal batch.
- `GET /api/proxy/*` — reverse-proxy scaffold.

---

## Breaking-change policy

A change is **breaking** if any of these become true:

- An existing field is removed from a response.
- An existing field's type changes (e.g., string → number).
- An existing required request field becomes invalid.
- A previously-2xx response shape moves to 4xx.

Breaking changes ship as a parallel endpoint (e.g., `/v2/...`) and the
v1 surface stays available for at least one quarter, longer if a
contracted partner depends on it.

**Non-breaking** (no notice required):
- Adding new fields to a response.
- Accepting new optional request fields.
- Tightening a Zod regex on an already-validated field as long as
  legitimate inputs still pass.
- Adding new endpoints.
- Changing cache TTLs, rate limits.

---

## Update procedure

When you change any endpoint:

1. Update the relevant section here.
2. Update the `Last verified` date in the front matter.
3. If the change is breaking, add a section explaining the parallel-endpoint plan + sunset window.
4. If a new endpoint is added, also add it to `PUBLIC_DATA_SURFACE.md` if it exposes a new anon-readable relation.
