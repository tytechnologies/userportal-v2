-- Manual refresh hook for the listing_details materialized view.
-- Wrapped in a SECURITY DEFINER function so authenticated users can trigger
-- it via PostgREST's RPC bridge (`supabase.rpc('refresh_listing_details')`)
-- without being granted REFRESH MATERIALIZED VIEW on the view itself.
--
-- Called from:
--   - server/repositories/listings.repo.ts (after every write)
--   - server/api/admin/refresh-listing-details.post.ts (manual / from client)
--
-- =====================================================================
-- listing_details column reference (as of 2026-05-02)
-- =====================================================================
-- The MV definition itself lives outside this repo (baseline schema).
-- This list is the authoritative reference for what's safe to query
-- via from('listing_details').select(...). If a column you need is NOT
-- in this list, the MV doesn't have it — drop down to the base table
-- (e.g. buildings.vue queries `listings` directly because the MV
-- predates listings.building_id and never picked it up).
--
--   listing_id              integer   (PK)
--   title                   text
--   status                  listing_status
--   condition               listing_condition
--   description             text
--   unit_number             text
--   for_sale                boolean
--   for_rent                boolean
--   sale_price              bigint
--   rent_price              integer
--   original_sale_price     bigint
--   original_rent_price     integer
--   sale_price_per_sqm      bigint
--   rent_price_per_sqm      integer
--   bedrooms                smallint
--   bathrooms               smallint
--   floor_area              smallint
--   lot_area                integer
--   parking_spaces          smallint
--   lease_term              smallint
--   rent_advance            smallint
--   security_deposit        smallint
--   association_dues        bigint
--   availability_date       date
--   property_amenities      varchar[]
--   listing_amenities       varchar[]
--   remarks                 text
--   developer_name          varchar
--   property_id             integer    (legacy building FK)
--   property_slug           varchar(255)
--   property_name           varchar(255)
--   street_address          varchar(255)
--   property_category       property_category
--   property_type           varchar(20)
--   year_built              smallint
--   latitude                double precision
--   longitude               double precision
--   city_id                 smallint
--   city_name               varchar(255)
--   city_slug               varchar(255)
--   barangay_id             integer
--   barangay_name           varchar(255)
--   barangay_slug           varchar(255)
--   contact_id              integer
--   contact_name            text
--   contact_designation     varchar(20)
--   contact_email           text
--   contact_home_phone      text
--   contact_mobile_number   text
--   contact_link            text
--   contact_notes           text
--   contact_owner_user_id   uuid
--   image_name              text
--   image_extension         text
--   is_online               boolean
--   is_featured             boolean
--   created_by              text
--   updated_by              text
--   created_at              timestamp
--   updated_at              timestamp
--
-- NOT projected (drop down to base `listings` for these):
--   building_id   — added by 20260501000006; MV predates the FK
--   deleted_at    — soft-delete sentinel; MV filters them out implicitly
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.refresh_listing_details();

CREATE OR REPLACE FUNCTION public.refresh_listing_details()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- Pin search_path so a hostile schema on the caller's path can't shadow
-- public.listing_details with a definition that runs arbitrary SQL.
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.listing_details;
END;
$$;

COMMENT ON FUNCTION public.refresh_listing_details() IS
  'Manual refresh of the listing_details materialized view. Called after listing writes. SECURITY DEFINER — owner must have REFRESH privilege on the MV.';

-- PostgREST exposes functions in the `public` schema by default. Allow the
-- standard Supabase roles to call this; revoke from PUBLIC so anonymous
-- traffic cannot trigger refreshes.
REVOKE ALL ON FUNCTION public.refresh_listing_details() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_listing_details() TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_listing_details() TO service_role;
