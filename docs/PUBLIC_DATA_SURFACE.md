# Public Data Surface

**Status:** authoritative contract for what the **anon** Supabase role may read.
**Owner:** Portal repo (schema source of truth).
**Consumers:** `websiteo` (public marketplace) — anon REST + server endpoints.
**Last verified:** 2026-05-06 against migrations through `20260502000018`.

---

## TL;DR

Anonymous (logged-out) traffic — including the public website's anon Supabase
client — may read **only** the relations and columns listed below. Everything
else returns either a `42501 permission denied` or a zero-row result.

If you are about to add a new public surface, **stop** and update this file
first. A field added here is a field that can never be un-published.

---

## Anon-readable relations

| Relation | Type | Anon SELECT | Defined / locked by |
|---|---|---|---|
| `public.listings` | table | ✅ where `is_online = true AND deleted_at IS NULL` | `20260501000007_public_anon_listings_read.sql` |
| `public.public_profiles` | view | ✅ all rows | `20260501000012_profiles_anon_pii_lockdown.sql` |
| `public.buildings` | table | ✅ all rows | `20260501000007_public_anon_listings_read.sql`, `20260501000006_buildings_first_class.sql` |
| `public.cities` | table | ✅ all rows | `20260501000001_cities_barangays_open_read.sql` |
| `public.barangays` | table | ✅ all rows | `20260501000001_cities_barangays_open_read.sql` |
| `public.featured_listings` | table | ✅ all rows | `20260502000011_featured_listings.sql` |
| `public.government_documents` | table | ✅ where `status = 'published'` | `20260502000016_government_documents.sql` |
| `public.public_listing_details` | view (over MV) | ✅ all rows; PII columns excluded | `20260506000001_public_listing_details_view.sql` |
| `public.listing_details` | materialized view | ⚠ Phase 1 — still anon-readable; Phase 2 will revoke. See **Status** below. | (baseline) + `20260506000001` |
| `public.search_result_pages` | table | ✅ (assumed for search) | (baseline) |
| `public.search_suggestions` | table | ✅ (assumed for typeahead) | (baseline) |

Anything not in this list is **not** anon-readable. In particular: `profiles`,
`contacts`, `inquiries`, `tasks`, `notes`, `documents`, `document_drafts`,
`tax_computations`, `activities`, `notifications`, `notification_preferences`,
`teams`, `permissions`, `role_permissions`, `listing_shares` — all
authenticated-only.

---

## `public_profiles` — the only safe profile surface

```sql
CREATE OR REPLACE VIEW public.public_profiles AS
SELECT id, full_name, avatar_url, role
FROM   public.profiles;
```

**Safe columns (✅):**

- `id` — the user's UUID (same as `auth.users.id` / `profiles.id`). Used for
  agent-card joins (`listings.created_by` → `public_profiles.id`).
- `full_name` — display name on agent cards and "uploaded by" labels.
- `avatar_url` — agent avatar.
- `role` — `'admin' | 'manager' | 'agent'`. Surfaced to support badges
  ("Listed by an admin") if needed; not sensitive on its own.

**Forbidden columns — MUST NEVER appear in a public surface:**

| Column on `profiles` | Why it's forbidden |
|---|---|
| `email` | PII; account identifier; spam target. |
| `mobile_phone` | PII; direct contact channel. |
| `home_phone` | PII; direct contact channel. |
| `fb_link` | PII; identifies the user's social presence. |
| `notes` | Free-text internal notes; high disclosure risk. |
| `designation` | Internal job title. Not strictly PII but unnecessary publicly; keep behind auth. |
| `team_id` | Reveals brokerage team structure. |
| `created_at` / `updated_at` | Reveals churn patterns; not needed publicly. |

If a new public field is genuinely required (e.g. a public bio), add it as
a **new column** to `profiles` *and* to the `public_profiles` view in the
same migration. Never broaden the view by `SELECT *`.

---

## How the public website reads agent info

There is exactly **one** code path on the website that surfaces an agent:

```ts
// websiteo/server/api/public/agent-card.get.ts
const { data: profile } = await supabase
  .from("public_profiles")
  .select("full_name, avatar_url")
  .eq("id", listing.created_by)
  .maybeSingle();
```

The endpoint:

1. Resolves `listing.created_by` (a UUID) **server-side** so the staff UUID
   never reaches the browser.
2. Returns only `{ display_name, avatar_url }` to the client.
3. Caches for 5 minutes (profile updates are rare relative to inquiry traffic).

The website's `app/components/Listings/Enquiry.vue` consumes that endpoint
post-inquiry-submission to render "we forwarded your message to <agent>".

**If you need a new public agent surface** (e.g. agent profile pages), add
a new `/api/public/*` endpoint that joins via `public_profiles`. Do **not**
expose `created_by` or any other UUID to the browser; resolve it server-side.

---

## Test cases (regression checks)

These are the four test cases the security task tracks. They should be
re-run any time `profiles`, `public_profiles`, or `listing_details` is
modified.

### 1. Anon REST cannot retrieve `profiles.email`

```bash
curl -s "https://<PROJ>.supabase.co/rest/v1/profiles?select=email&limit=1" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>"
```

**Expected:** HTTP 401/403 or `{"code":"42501","message":"permission denied for table profiles"}`.
**Pass criteria:** zero rows AND/OR a permission error. Never a row containing an email.

### 2. Anon REST cannot retrieve `profiles.mobile_phone` or `home_phone`

Same as #1 with `select=mobile_phone,home_phone`. Expected: same outcome.

### 3. Website still renders agent info

After deploying any change to `public_profiles`, verify a known property page
shows the assigned agent's name + avatar in the post-inquiry success card.

```bash
curl -s "https://<WEBSITE>/api/public/agent-card?listing_id=<ID>" | jq .
# {"agent": {"display_name": "...", "avatar_url": "..."}}
```

### 4. Portal authenticated flows still work

The portal reads `profiles` directly from authenticated contexts in:

- `app/composables/useAdmin.ts` — admin user list / role edit.
- `app/components/Navbar.vue`, `DashboardFooter.vue`, `pages/my-profile.vue` — own-profile reads.
- `app/components/crm/ShareListingModal.vue` — agent picker.
- `app/services/listing.services.js` — "uploaded by" enrichment.
- `server/utils/rbac.ts`, `server/utils/notifications.ts` — RBAC / fanout.
- `server/repositories/listings.repo.ts` — team scoping.
- `server/api/dashboard/activity.get.ts` — actor enrichment.

All of these run as **authenticated** users; `profiles_select_authenticated`
keeps them working. Smoke-test by logging into the portal as `agent`,
`manager`, and `admin`, and verifying the admin user table, share modal,
share-with picker, and "uploaded by" badges all populate.

---

## `public_listing_details` — anon-safe projection of the MV

Created by `20260506000001_public_listing_details_view.sql`. Same pattern
as `public_profiles`: the underlying object (`listing_details` MV) keeps
its full column set for authenticated callers; the website's anon path
goes through this view instead.

**Excluded columns (do NOT add to the view without a security review):**

| Column on `listing_details` | Why excluded |
|---|---|
| `contact_email` | PII; spam/scraping target. |
| `contact_home_phone` | PII; direct contact channel. |
| `contact_mobile_number` | PII; direct contact channel. |
| `contact_link` | PII; identifies the contact's web/social presence. |
| `contact_notes` | Internal CRM notes — never publicly intended. |
| `contact_owner_user_id` | Staff UUID; not for browser. |
| `created_by` / `updated_by` | Staff text identifiers. |
| `remarks` | Internal listing notes. |
| `original_sale_price` / `original_rent_price` | Internal pre-discount pricing. |

The view is built with an **explicit column list, not `SELECT *`** —
new columns added to `listing_details` in future migrations are NOT
automatically inherited. To expose a new public column you must add
it to both the MV and the view in the same PR.

## Status — `listing_details` direct anon read

**Phase 1 (shipped via `20260506000001`):** `public_listing_details` view
created and adopted across the website (sitemap, search, listings,
area-count, nearby, similar, listingEnrich). The website no longer
amplifies the leak.

**Phase 2 (deferred — separate PR):** `REVOKE SELECT ON public.listing_details FROM anon`.
Until Phase 2 ships, an external caller can still curl the raw MV
directly with the anon key and harvest contact PII. The website is
clean; the surface is not.

Reproduction (still works in Phase 1, fails in Phase 2):

```bash
curl -s "https://<PROJ>.supabase.co/rest/v1/listing_details?select=contact_email,contact_mobile_number,contact_home_phone&is_online=eq.true&limit=10" \
  -H "apikey: <ANON_KEY>"
```

**Phase 2 prerequisites:**

1. Verify in Supabase API logs that no anon caller other than the website
   has hit `/rest/v1/listing_details` recently.
2. Verify the website's listing pages still render correctly without
   `contact_email` / `contact_home_phone` / `contact_mobile_number` /
   `contact_link` (they are now `null` in the merged output; UI must
   not crash on null).
3. Ship `REVOKE SELECT ON public.listing_details FROM anon;` + `NOTIFY pgrst, 'reload schema';` in a one-line migration.

---

## Where the boundary is enforced

Three layers, in order of trust:

1. **PostgreSQL `GRANT` / `REVOKE`** at the table level. This is the
   load-bearing wall. `20260501000012` revokes `SELECT` on `profiles`
   from `anon`; `public_profiles` is granted to `anon` instead.
2. **RLS policies** on each relation. `profiles_select_authenticated`
   gates the table for logged-in users. The dropped
   `profiles_select_public` policy is not allowed back without a
   security review.
3. **Application code** in both repos. Documented in this file as the
   list of expected call sites. New direct `.from('profiles')` reads
   in `websiteo` should be **rejected at code review** — they belong
   in `public_profiles` or `/api/public/agent-card`.

Defense-in-depth: even if (3) regresses (someone writes
`websiteo/server/.../foo.get.ts` calling `.from('profiles')`), (1) and
(2) keep the data safe. The website's server runs as **anon** (see
`websiteo/server/utils/supabase.ts`), so a buggy public endpoint fails
closed.

---

## Update procedure

When you change anything in this file:

1. Update the migration list at the top of this file.
2. Re-run the four test cases above against the affected environment.
3. Note the date of the verification in the front matter.
4. If you are adding a new public surface, write or update a migration
   that explicitly grants `SELECT` on the new view to `anon`, and
   commit the migration in the same PR as the docs change.
