# `listing_details` Refresh Strategy

**Status:** authoritative contract for keeping the cross-repo MV fresh.
**Owner:** Portal repo (schema source of truth).
**Last updated:** 2026-05-06 (periodic safety net added in `20260506000002`).

---

## The MV is the cross-repo contract

`public.listing_details` is the denormalized read source for the public
website (via `public.public_listing_details`) and most of the portal's
listing-display surfaces. Every consumer reads what was true at the
last refresh. There are no incremental updates — refresh re-reads the
underlying tables in full.

**Freshness affects:**
- Public listing pages (price, bedrooms, status, denormalized contact
  display name, city/barangay names).
- Portal dashboards, lists, document templates that read
  `listing_details` directly.
- The website's sitemap (online status, slugs).

---

## Refresh paths today (in order of trust)

### 1. Inline refresh from server-side writes

`server/repositories/listings.repo.ts` calls `refreshListingDetails()`
after every successful mutation:

| Repo method | Refresh call |
|---|---|
| `create` | `refreshListingDetails(client, 'listings.create')` |
| `archive` | `refreshListingDetails(client, 'listings.archive')` |
| `unarchive` | `refreshListingDetails(client, 'listings.unarchive')` |
| `updateRemarks` | `refreshListingDetails(client, 'listings.updateRemarks')` |
| `softDelete` | `refreshListingDetails(client, 'listings.softDelete')` |
| `clone` | `refreshListingDetails(client, 'listings.clone')` |

These are the only places server code mutates `listings` (verified by
grep across `server/`). The MV is fresh within milliseconds of every
server-side write.

### 2. Inline refresh from client-side writes

`app/services/listing.services.js` calls
`refreshListingDetailsFromClient()` after every successful mutation:

| Client function | Refresh call |
|---|---|
| `_createListingOnly` | `refreshListingDetailsFromClient('_createListingOnly')` |
| `_updateListing` | `refreshListingDetailsFromClient('_updateListing')` |

These cover the portal's full-edit-form path — the only client code
that mutates `listings` directly. The refresh is dispatched via
`POST /api/admin/refresh-listing-details`, which then calls the same
RPC as the repo path.

### 3. Manual admin trigger

`POST /api/admin/refresh-listing-details` (handler at
`server/api/admin/refresh-listing-details.post.ts`) — call this if you
suspect the MV is stale. Authenticated; no body required.

### 4. Periodic safety net (new — `20260506000002`)

A `pg_cron` job named `refresh_listing_details_periodic` runs
`SELECT public.refresh_listing_details()` every 5 minutes. This bounds
worst-case staleness to 5 minutes regardless of which path performed
the write.

**Conditional on `pg_cron` being enabled.** The migration emits a
`NOTICE` and exits cleanly if the extension is absent. Verify
installation with:

```sql
SELECT jobname, schedule, command FROM cron.job
WHERE jobname = 'refresh_listing_details_periodic';
```

If the row is missing and pg_cron is enabled, re-run the migration.

---

## What the safety net catches

The 5-minute periodic refresh covers staleness vectors the inline
refreshes do not:

| Vector | Example | Without safety net | With safety net |
|---|---|---|---|
| **Out-of-band writes** to `listings` | Supabase Studio edit, manual SQL, ad-hoc script | Indefinite staleness | ≤ 5 min staleness |
| **Lookup-table mutations** | Agent renames in `contacts`, city renamed in `cities`, building renamed in `buildings` | Stale until next listing write referencing that row | ≤ 5 min staleness |
| **Future write paths** added by a new developer who doesn't know the rule | New endpoint that bypasses `listings.repo.ts` and forgets to call `refreshListingDetails()` | Indefinite staleness | ≤ 5 min staleness |

---

## Rules for adding new write paths

If you add a new code path that mutates the `listings` table, follow
**one** of these patterns:

1. **Use `listings.repo.ts`** — the existing methods refresh the MV
   automatically. Prefer this; it's the convention.
2. **Call `refreshListingDetails(client, '<call-site-name>')`** at the
   end of your handler — server-side, after the write succeeds.
3. **Call `POST /api/admin/refresh-listing-details`** — client-side,
   if you can't easily route through `listings.repo.ts`.

If you mutate a **lookup table** (`contacts`, `cities`, `barangays`,
`buildings`) and the change affects denormalized columns the MV
exposes (`contact_name`, `city_name`, `barangay_name`,
`developer_name`, etc.), you don't need to call refresh — the
periodic safety net catches it within 5 minutes. Only call refresh
inline if your UX requires sub-5-minute freshness for that change.

---

## Performance notes

The current refresh function uses non-CONCURRENT
`REFRESH MATERIALIZED VIEW`, which holds an `ACCESS EXCLUSIVE` lock
for the duration of the rebuild. Behavior:

- **Today** (~thousands of listings): sub-second refresh. Reads pause
  briefly; not user-visible.
- **At ~50k listings**: refresh time will climb into multi-second
  territory. Reads visibly stall during refresh.
- **Mitigation when needed**: switch the function to
  `REFRESH MATERIALIZED VIEW CONCURRENTLY public.listing_details`.
  Requires a unique index on the MV (`listing_id` PK should suffice;
  verify with `\d+ listing_details` before flipping). Concurrent
  refresh takes longer in absolute terms but doesn't block reads.

This is a future improvement, not a current blocker. Track it on the
Phase C list.

---

## Verifying freshness in production

```sql
-- 1. When did the safety-net job last run?
SELECT jobname, last_run_started_at, last_run_finished_at, status
FROM cron.job_run_details
WHERE jobname = 'refresh_listing_details_periodic'
ORDER BY last_run_started_at DESC
LIMIT 5;

-- 2. Does the MV row count match the underlying listings count?
SELECT
  (SELECT count(*) FROM public.listings WHERE is_online = true AND deleted_at IS NULL) AS listings_online,
  (SELECT count(*) FROM public.listing_details WHERE is_online = true)                  AS mv_online;
-- A delta > 0 sustained for more than 5 minutes means the safety net
-- isn't running — check pg_cron status.

-- 3. Most recent updated_at in the MV vs. the base table.
SELECT
  (SELECT max(updated_at) FROM public.listings)        AS latest_write,
  (SELECT max(updated_at) FROM public.listing_details) AS latest_in_mv;
-- Drift > 5 min means refresh is failing or pg_cron is paused.
```

---

## Update procedure

When you change anything that affects refresh behavior:

1. Update this doc.
2. If you add a new write path, document it in the table above
   (sections 1 / 2) — even if it correctly routes through the repo,
   future readers should be able to see the full coverage.
3. If you change `refresh_listing_details()` (e.g., switch to
   CONCURRENTLY), update the **Performance notes** section.
4. If you change the cron schedule, update the **Periodic safety
   net** section and the staleness-bound numbers in **What the
   safety net catches**.
