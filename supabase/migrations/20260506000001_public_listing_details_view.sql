-- Anon-safe projection of public.listing_details.
--
-- Background:
--   `listing_details` is the authoritative denormalized read source for the
--   public website. Granted SELECT to anon since baseline so the website's
--   anon Supabase client can hit it directly (sitemap, search, area-count,
--   nearby/similar, listing enrichment).
--
--   The MV carries denormalized contact fields (contact_email,
--   contact_home_phone, contact_mobile_number, contact_link, contact_notes,
--   contact_owner_user_id) that ORIGINATE from public.contacts -- which is
--   authenticated-only via 20260430000002_contacts_rls.sql. Materialized
--   views do NOT inherit RLS from their sources; the denormalized PII is
--   anon-readable today by anyone with the public anon key.
--
--   This is the same class of leak that 20260501000012_profiles_anon_pii_lockdown
--   closed for `profiles`. Pattern is identical: keep the underlying object
--   for authenticated callers, expose a column-restricted view to anon.
--
-- Scope of this migration (Phase 1 — additive only):
--   1. Add `public.public_listing_details` view that projects 41 of the 53
--      MV columns. Excludes contact PII (5 cols), staff identifier UUIDs
--      (contact_owner_user_id), legacy text identifiers (created_by,
--      updated_by), and internal-only fields (remarks, original_sale_price,
--      original_rent_price).
--   2. GRANT SELECT to anon + authenticated.
--   3. DOES NOT revoke anon from `listing_details`. The MV grant stays
--      intact. Both surfaces work; existing website queries continue to
--      function. This is fully backward-compatible.
--
-- Phase 2 (separate, deferred migration — DO NOT BUNDLE):
--   REVOKE SELECT ON public.listing_details FROM anon;
--   That actually closes the leak against direct REST callers. The view
--   keeps anon working through it because views default to
--   security_invoker = false (the view runs as its definer / table owner,
--   so the underlying MV access is checked against the view owner's grants,
--   not the caller's). Phase 2 must be preceded by curl-verification that
--   no production anon caller other than the website hits `listing_details`
--   directly.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.public_listing_details;
--   NOTIFY pgrst, 'reload schema';
--
-- DEPENDS ON:
--   20260429000005_refresh_listing_details.sql (MV column reference)
--   20260501000012_profiles_anon_pii_lockdown.sql (precedent + pattern)


-- =====================================================================
-- 1. The anon-safe view
-- =====================================================================
--
-- Explicit column list — NOT `SELECT *`. A future migration that adds a
-- new column to listing_details will not auto-leak it through this view;
-- the new column has to be deliberately added here. That is the security
-- contract.
--
-- If you are adding a new public-safe column to the MV, ALSO add it here
-- in a follow-up migration and run `NOTIFY pgrst, 'reload schema'`.

CREATE OR REPLACE VIEW public.public_listing_details AS
SELECT
  -- Identity
  listing_id,

  -- Listing core
  title,
  status,
  condition,
  description,
  unit_number,

  -- Transaction + pricing (current; not original/internal)
  for_sale,
  for_rent,
  sale_price,
  rent_price,
  sale_price_per_sqm,
  rent_price_per_sqm,

  -- Specs
  bedrooms,
  bathrooms,
  floor_area,
  lot_area,
  parking_spaces,
  lease_term,
  rent_advance,
  security_deposit,
  association_dues,
  availability_date,

  -- Amenities
  property_amenities,
  listing_amenities,

  -- Building / location
  developer_name,
  property_id,
  property_slug,
  property_name,
  street_address,
  property_category,
  property_type,
  year_built,
  latitude,
  longitude,
  city_id,
  city_name,
  city_slug,
  barangay_id,
  barangay_name,
  barangay_slug,

  -- Contact (DISPLAY-SAFE ONLY: name + designation, like public_profiles).
  -- contact_email, contact_home_phone, contact_mobile_number, contact_link,
  -- contact_notes, contact_owner_user_id are intentionally EXCLUDED.
  contact_id,
  contact_name,
  contact_designation,

  -- Media
  image_name,
  image_extension,

  -- Flags + timestamps
  is_online,
  is_featured,
  created_at,
  updated_at
FROM public.listing_details;

COMMENT ON VIEW public.public_listing_details IS
  'Anon-safe column projection of listing_details. PII columns (contact_email, contact_home_phone, contact_mobile_number, contact_link, contact_notes, contact_owner_user_id), staff identifiers (created_by, updated_by), and internal-only fields (remarks, original_sale_price, original_rent_price) are EXCLUDED. Public website reads MUST go through this view; reads of listing_details directly are reserved for authenticated portal traffic. Adding a new column requires a deliberate migration here -- this view is intentionally NOT SELECT *.';


-- =====================================================================
-- 2. Grants
-- =====================================================================
--
-- Both anon and authenticated. Authenticated users can use either surface;
-- anon can only use the view (in Phase 2; in Phase 1 anon still has access
-- to the MV directly until that grant is revoked separately).

GRANT SELECT ON public.public_listing_details TO anon, authenticated;


-- =====================================================================
-- 3. Refresh PostgREST schema cache so the view is queryable immediately
-- =====================================================================

NOTIFY pgrst, 'reload schema';
