-- Audit Phase F: listings stores city_name (text), city_slug (text), and
-- barangay_name (text). Replace with FKs to public.cities / public.barangays.
-- Assumes those parent tables already exist (per the Nuxt-2-era schema and
-- the references in services/buildings.services.js + AdvanceFilters.vue).
--
-- ⚠ DO NOT APPLY UNTIL:
--   1. The cities + barangays tables are tracked in this folder
--      (Phase A baseline migration captures them).
--   2. The form that creates/edits listings writes city_id + barangay_id
--      instead of the text columns.
--   3. The audit query at the top of this migration reports zero
--      unmatched rows (every listing's city_name resolves to a real city).
--
-- ROLLBACK:
--   ALTER TABLE public.listings
--     ADD COLUMN city_name     text,
--     ADD COLUMN city_slug     text,
--     ADD COLUMN barangay_name text;
--   UPDATE public.listings l
--   SET city_name = c.name, city_slug = c.slug
--   FROM public.cities c WHERE l.city_id = c.id;
--   UPDATE public.listings l
--   SET barangay_name = b.name
--   FROM public.barangays b WHERE l.barangay_id = b.id;
--   ALTER TABLE public.listings
--     DROP CONSTRAINT IF EXISTS listings_city_id_fk,
--     DROP CONSTRAINT IF EXISTS listings_barangay_id_fk,
--     DROP COLUMN city_id, DROP COLUMN barangay_id;

-- Pre-flight audit: list any listings whose denormalized city/barangay text
-- doesn't match a row in the parent tables. Aborts if any exist.
DO $$
DECLARE
  unmatched_cities    int;
  unmatched_barangays int;
BEGIN
  SELECT count(*) INTO unmatched_cities
  FROM public.listings l
  WHERE l.city_name IS NOT NULL
    AND l.city_name <> ''
    AND NOT EXISTS (
      SELECT 1 FROM public.cities c
      WHERE lower(c.name) = lower(l.city_name)
    );

  SELECT count(*) INTO unmatched_barangays
  FROM public.listings l
  WHERE l.barangay_name IS NOT NULL
    AND l.barangay_name <> ''
    AND NOT EXISTS (
      SELECT 1 FROM public.barangays b
      WHERE lower(b.name) = lower(l.barangay_name)
    );

  IF unmatched_cities > 0 OR unmatched_barangays > 0 THEN
    RAISE EXCEPTION
      '% listings have city_name not in cities; % have barangay_name not in barangays. Reconcile manually before applying this migration.',
      unmatched_cities, unmatched_barangays;
  END IF;
END $$;

-- 1. Add the FK columns.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS city_id     bigint,
  ADD COLUMN IF NOT EXISTS barangay_id bigint;

COMMENT ON COLUMN public.listings.city_id IS
  'FK to cities.id. Replaces denormalized city_name / city_slug.';
COMMENT ON COLUMN public.listings.barangay_id IS
  'FK to barangays.id. Replaces denormalized barangay_name.';

-- 2. Backfill from text columns via case-insensitive match.
UPDATE public.listings l
SET city_id = c.id
FROM public.cities c
WHERE l.city_id IS NULL
  AND l.city_name IS NOT NULL
  AND lower(c.name) = lower(l.city_name);

UPDATE public.listings l
SET barangay_id = b.id
FROM public.barangays b
WHERE l.barangay_id IS NULL
  AND l.barangay_name IS NOT NULL
  AND lower(b.name) = lower(l.barangay_name);

-- 3. FK constraints (after backfill so existing rows pass validation).
ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_city_id_fk;
ALTER TABLE public.listings
  ADD CONSTRAINT listings_city_id_fk
  FOREIGN KEY (city_id) REFERENCES public.cities(id) ON DELETE SET NULL;

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_barangay_id_fk;
ALTER TABLE public.listings
  ADD CONSTRAINT listings_barangay_id_fk
  FOREIGN KEY (barangay_id) REFERENCES public.barangays(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_listings_city_id     ON public.listings(city_id);
CREATE INDEX IF NOT EXISTS idx_listings_barangay_id ON public.listings(barangay_id);

-- 4. Drop the text columns. Same safety check as the contact-denorm migration:
-- refuse if recent rows still have non-empty values, suggesting writes are
-- still landing here.
DO $$
DECLARE
  recent_writes int;
BEGIN
  SELECT count(*) INTO recent_writes
  FROM public.listings
  WHERE updated_at > now() - interval '1 day'
    AND (
         (city_name IS NOT NULL AND city_name <> '')
      OR (barangay_name IS NOT NULL AND barangay_name <> '')
    )
    AND (city_id IS NULL OR barangay_id IS NULL);

  IF recent_writes > 0 THEN
    RAISE EXCEPTION
      'Found % listings updated in the last 24h with denormalized city/barangay text and missing FKs. Confirm the server-side change has shipped before applying.',
      recent_writes;
  END IF;
END $$;

ALTER TABLE public.listings
  DROP COLUMN IF EXISTS city_name,
  DROP COLUMN IF EXISTS city_slug,
  DROP COLUMN IF EXISTS barangay_name;
