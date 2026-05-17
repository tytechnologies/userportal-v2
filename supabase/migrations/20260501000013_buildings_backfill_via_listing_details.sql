-- Backfill listings.building_id by joining through listing_details.
--
-- 000011 tried to read property_name directly off `listings`, but that
-- column doesn't exist there — `property_name` lives on the
-- `listing_details` materialized view (which carries dozens of
-- denormalized fields keyed by listing_id). The earlier migration's
-- column-existence guard saw `listings.property_name` was missing and
-- correctly skipped, leaving every listings.building_id NULL.
--
-- Fix: source property_name from listing_details, join to listings
-- via listing_id, and update listings.building_id from the matching
-- buildings row.
--
-- DEPENDS ON:
--   public.listings, public.buildings (000006),
--   public.listing_details (materialized view from baseline / phase 3)

-- =====================================================================
-- 1. Sanity check listing_details exists and has the columns we need
-- =====================================================================
--
-- Wrapped so this migration is safe in greenfield environments where
-- listing_details might not have been created yet. We don't fail the
-- migration; we just NOTICE and exit.

DO $$
DECLARE
  has_view             boolean;
  has_property_name    boolean;
  has_listing_id       boolean;
  rows_inserted        int := 0;
  rows_updated         int := 0;
  rows_updated_2       int := 0;
BEGIN
  -- listing_details could be a regular view, a materialized view, or
  -- a table — check pg_class instead of information_schema (which
  -- excludes matviews from .views and .tables in older PG versions).
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'listing_details'
      AND c.relkind IN ('v', 'm', 'r')
  ) INTO has_view;

  IF NOT has_view THEN
    RAISE NOTICE 'public.listing_details not found; skipping backfill. Re-run when the MV is in place.';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='listing_details' AND column_name='property_name'
  ) INTO has_property_name;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='listing_details' AND column_name='listing_id'
  ) INTO has_listing_id;

  IF NOT has_property_name OR NOT has_listing_id THEN
    RAISE NOTICE 'public.listing_details missing property_name or listing_id; skipping backfill.';
    RETURN;
  END IF;

  -- =====================================================================
  -- 2. Insert missing buildings rows from distinct property_names on
  --    listing_details. Slug is derived the same way the API does
  --    (lowercase, non-alphanumeric → '-', collapse, trim).
  -- =====================================================================
  WITH inserted AS (
    INSERT INTO public.buildings (name, slug)
    SELECT DISTINCT
      trim(ld.property_name),
      trim(BOTH '-' FROM regexp_replace(
        regexp_replace(lower(trim(ld.property_name)), '[^a-z0-9]+', '-', 'g'),
        '-+', '-', 'g'))
    FROM public.listing_details ld
    WHERE ld.property_name IS NOT NULL
      AND ld.property_name <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.buildings b
        WHERE lower(trim(b.name)) = lower(trim(ld.property_name))
      )
    ON CONFLICT (slug) WHERE slug IS NOT NULL DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO rows_inserted FROM inserted;
  RAISE NOTICE 'Inserted % buildings from distinct listing_details.property_name.', rows_inserted;

  -- =====================================================================
  -- 3. Set listings.building_id from the join: listings.id =
  --    listing_details.listing_id, listing_details.property_name =
  --    buildings.name (case-insensitive, trimmed).
  -- =====================================================================
  WITH matched AS (
    UPDATE public.listings l
    SET building_id = b.id
    FROM public.listing_details ld
    JOIN public.buildings b
      ON lower(trim(ld.property_name)) = lower(trim(b.name))
    WHERE l.id = ld.listing_id
      AND l.building_id IS NULL
      AND ld.property_name IS NOT NULL
      AND ld.property_name <> ''
    RETURNING l.id
  )
  SELECT count(*) INTO rows_updated FROM matched;
  RAISE NOTICE 'Backfilled building_id on % listings via listing_details.property_name match.', rows_updated;

  -- =====================================================================
  -- 4. Second pass — picks up listings whose matching building was
  --    just created in step 2 (the first UPDATE may have skipped them
  --    because the building didn't exist yet at evaluation time).
  -- =====================================================================
  WITH matched AS (
    UPDATE public.listings l
    SET building_id = b.id
    FROM public.listing_details ld
    JOIN public.buildings b
      ON lower(trim(ld.property_name)) = lower(trim(b.name))
    WHERE l.id = ld.listing_id
      AND l.building_id IS NULL
      AND ld.property_name IS NOT NULL
      AND ld.property_name <> ''
    RETURNING l.id
  )
  SELECT count(*) INTO rows_updated_2 FROM matched;
  IF rows_updated_2 > 0 THEN
    RAISE NOTICE 'Second-pass backfilled % additional listings.', rows_updated_2;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
