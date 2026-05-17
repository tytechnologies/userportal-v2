-- Remediation for the post-buildings-launch issues surfaced by the
-- public website integration:
--
--   (1) listings.building_id was never backfilled — the original 000006
--       backfill matched on listings.property_slug, which doesn't exist
--       in this environment, so it silently skipped. We re-run the
--       backfill keyed on property_name (which DOES exist).
--
--   (2) The new buildings table is missing content columns the website
--       was reading from the old matview (description, amenities,
--       latitude/longitude). These are content fields, not aggregates;
--       the building page renders them in the hero, so a NULL means
--       blank marketing copy. We add them as nullable columns so
--       editors can populate them; price aggregates stay computed
--       client-side from the listings array.
--
-- DEPENDS ON:
--   20260501000006 (buildings table + listings.building_id column)

-- =====================================================================
-- 1. Add the content columns the website expects
-- =====================================================================

ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS amenities   text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS latitude    numeric,
  ADD COLUMN IF NOT EXISTS longitude   numeric;

COMMENT ON COLUMN public.buildings.description IS
  'Marketing description shown on the public building page hero. Free-form rich text (plain text for v1).';
COMMENT ON COLUMN public.buildings.amenities IS
  'Bullet list of amenities for the public building page. Empty array = no amenities listed.';
COMMENT ON COLUMN public.buildings.latitude IS
  'Geocoded centroid of the building. Nullable until geocoded.';

-- =====================================================================
-- 2. Backfill listings.building_id via property_name match
-- =====================================================================
--
-- 000006's section 3b couldn't run because listings.property_slug
-- doesn't exist in this DB, so listing → building linkage was left
-- empty. property_name DOES exist; we match case-insensitively and
-- trim whitespace to absorb minor data hygiene drift.
--
-- Wrapped in a column-existence DO block so this migration is also
-- safe in greenfield environments where property_name might never
-- have existed.
DO $$
DECLARE
  has_property_name boolean;
  rows_updated      int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='listings' AND column_name='property_name'
  ) INTO has_property_name;

  IF NOT has_property_name THEN
    RAISE NOTICE 'listings.property_name not present; nothing to backfill from. Building inventory will populate as new listings set building_id directly.';
    RETURN;
  END IF;

  WITH matched AS (
    UPDATE public.listings l
    SET building_id = b.id
    FROM public.buildings b
    WHERE l.building_id IS NULL
      AND l.property_name IS NOT NULL
      AND l.property_name <> ''
      AND lower(trim(l.property_name)) = lower(trim(b.name))
    RETURNING l.id
  )
  SELECT count(*) INTO rows_updated FROM matched;

  RAISE NOTICE 'Backfilled building_id on % listings via property_name match.', rows_updated;
END $$;

-- =====================================================================
-- 3. Backfill buildings rows from listings.property_name (for buildings
--    that exist as a name on listings but don't have a buildings row
--    yet — handles the case where 000006 created zero rows because the
--    listings backfill in 3b couldn't match property_slug).
-- =====================================================================
--
-- Slug derivation matches the slugify() in the API: lowercase, non-
-- alphanumeric → '-', collapse repeats, trim leading/trailing dashes.
DO $$
DECLARE
  has_property_name boolean;
  rows_inserted     int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='listings' AND column_name='property_name'
  ) INTO has_property_name;

  IF NOT has_property_name THEN RETURN; END IF;

  WITH inserted AS (
    INSERT INTO public.buildings (name, slug)
    SELECT DISTINCT
      trim(property_name),
      trim(BOTH '-' FROM regexp_replace(
        regexp_replace(lower(trim(property_name)), '[^a-z0-9]+', '-', 'g'),
        '-+', '-', 'g'))
    FROM public.listings
    WHERE property_name IS NOT NULL
      AND property_name <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.buildings b
        WHERE lower(trim(b.name)) = lower(trim(public.listings.property_name))
      )
    ON CONFLICT (slug) WHERE slug IS NOT NULL DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO rows_inserted FROM inserted;

  RAISE NOTICE 'Created % buildings from distinct listing property_names.', rows_inserted;
END $$;

-- Final pass: re-run the backfill in case step 3 created new rows that
-- step 2 hadn't seen yet.
DO $$
DECLARE
  has_property_name boolean;
  rows_updated      int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='listings' AND column_name='property_name'
  ) INTO has_property_name;
  IF NOT has_property_name THEN RETURN; END IF;

  WITH matched AS (
    UPDATE public.listings l
    SET building_id = b.id
    FROM public.buildings b
    WHERE l.building_id IS NULL
      AND l.property_name IS NOT NULL
      AND l.property_name <> ''
      AND lower(trim(l.property_name)) = lower(trim(b.name))
    RETURNING l.id
  )
  SELECT count(*) INTO rows_updated FROM matched;
  RAISE NOTICE 'Second-pass backfilled building_id on % additional listings.', rows_updated;
END $$;

NOTIFY pgrst, 'reload schema';
