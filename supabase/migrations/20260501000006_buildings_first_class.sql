-- Make `buildings` a first-class MLS entity and link listings via FK.
--
-- Why this is defensive (heavy on IF NOT EXISTS):
--   - The `buildings` table ALREADY EXISTS in the live DB at the
--     baseline (created outside this migration folder). Code in
--     app/services/buildings.services.js queries it today using the
--     legacy column shape: `building_name` (not `name`) and
--     `property_id` (not `id`).
--   - The brief calls for new columns (id/name/slug/address/city_id/
--     developer_id/zonal_value/created_by/...). Adding them WITHOUT
--     dropping the legacy ones lets existing code keep working while
--     new code uses the canonical names.
--   - `developers` may or may not exist in the baseline. The FK is
--     wrapped in a conditional so the migration is safe to run on
--     environments without that table.
--
-- The end state of this migration:
--   buildings.id / .name / .slug / .address / .city_id / .developer_id /
--   .zonal_value / .created_by / .created_at / .updated_at exist.
--   Legacy buildings.building_name / .property_id remain populated for
--   backwards compat with the existing services.
--
--   listings.building_id (bigint) → buildings(id) ON DELETE SET NULL.
--   Existing rows are linked via property_slug → buildings.slug.
--
--   listings.property_name / .property_slug stay (per the brief).
--
-- DEPENDS ON:
--   public.profiles (20260429000001), public.cities (baseline),
--   public.has_permission (20260430000003 / 000004).

-- =====================================================================
-- 0. Convert legacy materialized view → base table (if applicable)
-- =====================================================================
--
-- Some environments started with `public.buildings` as a materialized
-- view (sourced off listings — ad-hoc roll-up that became part of the
-- baseline). ALTER TABLE ADD COLUMN doesn't work on matviews, so we
-- detect that case, snapshot the rows into a side table, drop the
-- matview, and let the additive heal below operate on a real base
-- table.
--
-- CASCADE is intentional: any policies / grants attached to the matview
-- are recreated by section 4 below (RLS) and section 4 (GRANTs); a
-- public-anon read policy added by 20260501000007 is itself wrapped in
-- DROP POLICY IF EXISTS, so re-running 000007 after this migration
-- restores it cleanly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_matviews
    WHERE schemaname = 'public' AND matviewname = 'buildings'
  ) THEN
    -- Preserve the matview's contents — useful for spot-checking the
    -- backfill; safe to drop later when the new table is verified.
    EXECUTE 'CREATE TABLE IF NOT EXISTS public.buildings_legacy_snapshot AS SELECT * FROM public.buildings';
    EXECUTE 'DROP MATERIALIZED VIEW public.buildings CASCADE';
    RAISE NOTICE 'public.buildings was a materialized view; rows snapshotted to public.buildings_legacy_snapshot and matview dropped so the heal below can run.';
  END IF;
END $$;

-- =====================================================================
-- 1. Buildings table — additive heal
-- =====================================================================

-- Create-if-missing: handles greenfield envs where the legacy table
-- never existed.
CREATE TABLE IF NOT EXISTS public.buildings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
);

-- Additive columns. Each is IF NOT EXISTS so re-running is a no-op
-- and we don't fight a legacy column shape.
ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS name        text,
  ADD COLUMN IF NOT EXISTS slug        text,
  ADD COLUMN IF NOT EXISTS address     text,
  ADD COLUMN IF NOT EXISTS city_id     bigint,
  ADD COLUMN IF NOT EXISTS developer_id bigint,
  ADD COLUMN IF NOT EXISTS zonal_value numeric,
  ADD COLUMN IF NOT EXISTS created_by  uuid,
  ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now();

-- updated_at trigger (re-uses the helper Phase 4 ships).
DROP TRIGGER IF EXISTS set_buildings_updated_at ON public.buildings;
CREATE TRIGGER set_buildings_updated_at
  BEFORE UPDATE ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- Backfill `name` from the legacy `building_name` column when our new
-- column is empty. Wrapped in a guarded DO block in case the legacy
-- column doesn't exist in greenfield envs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'buildings'
      AND column_name = 'building_name'
  ) THEN
    UPDATE public.buildings
    SET name = COALESCE(NULLIF(name, ''), building_name)
    WHERE name IS NULL OR name = '';
  END IF;
END $$;

-- Backfill `slug` from `name` for rows that don't have one yet.
-- Lightweight slugifier in pure SQL: lowercase, non-alphanumeric → '-',
-- collapse repeats, trim leading/trailing dashes. Good enough for
-- legacy backfill; the API uses a smarter version on insert.
UPDATE public.buildings
SET slug = trim(BOTH '-' FROM regexp_replace(
            regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'),
            '-+', '-', 'g'))
WHERE name IS NOT NULL
  AND (slug IS NULL OR slug = '');

-- Now enforce the constraints the brief asks for. NOT NULL is added
-- after the backfill so we don't fail mid-migration on legacy rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'buildings'
      AND column_name = 'name'
      AND is_nullable = 'YES'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.buildings WHERE name IS NULL
  ) THEN
    ALTER TABLE public.buildings ALTER COLUMN name SET NOT NULL;
  END IF;
END $$;

-- UNIQUE on slug — handle the legacy NULL slug case by partial index
-- (skip rows that still don't have a slug; ALTER TABLE … ADD UNIQUE
-- would refuse if any duplicates exist).
CREATE UNIQUE INDEX IF NOT EXISTS uq_buildings_slug
  ON public.buildings(slug)
  WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_buildings_city_id     ON public.buildings(city_id);
CREATE INDEX IF NOT EXISTS idx_buildings_developer_id ON public.buildings(developer_id);
CREATE INDEX IF NOT EXISTS idx_buildings_created_by  ON public.buildings(created_by);

-- FKs (each guarded so re-running is safe; developer_id FK is
-- conditional on the developers table existing).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'buildings_city_id_fkey' AND conrelid = 'public.buildings'::regclass
  ) THEN
    ALTER TABLE public.buildings
      ADD CONSTRAINT buildings_city_id_fkey
      FOREIGN KEY (city_id) REFERENCES public.cities(id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'buildings_created_by_fkey' AND conrelid = 'public.buildings'::regclass
  ) THEN
    ALTER TABLE public.buildings
      ADD CONSTRAINT buildings_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.profiles(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Developer FK is conditional. Skipped (with a NOTICE) in environments
-- that don't have a developers table yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'developers'
  ) THEN
    RAISE NOTICE 'public.developers does not exist; skipping buildings.developer_id FK. Add the FK in a follow-up once developers ships.';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'buildings_developer_id_fkey' AND conrelid = 'public.buildings'::regclass
  ) THEN
    ALTER TABLE public.buildings
      ADD CONSTRAINT buildings_developer_id_fkey
      FOREIGN KEY (developer_id) REFERENCES public.developers(id)
      ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON TABLE  public.buildings IS
  'First-class buildings entity. Listings link via listings.building_id; legacy columns building_name / property_id retained for backwards compat with services that still query them.';
COMMENT ON COLUMN public.buildings.slug IS
  'URL-safe identifier. Unique among non-null values; nullable rows are legacy and should be backfilled.';

-- =====================================================================
-- 2. Listings.building_id FK
-- =====================================================================

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS building_id bigint;

CREATE INDEX IF NOT EXISTS idx_listings_building_id
  ON public.listings(building_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'listings_building_id_fkey' AND conrelid = 'public.listings'::regclass
  ) THEN
    ALTER TABLE public.listings
      ADD CONSTRAINT listings_building_id_fkey
      FOREIGN KEY (building_id) REFERENCES public.buildings(id)
      ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.listings.building_id IS
  'FK to buildings.id. New canonical link replacing the denormalized property_name / property_slug pair (which remain for backwards compat).';

-- =====================================================================
-- 3. Backfill — buildings rows from distinct listing property_name/slug
-- =====================================================================
--
-- Two-step:
--   a) INSERT distinct (name, slug) pairs from listings into buildings,
--      skipping rows that already exist by slug.
--   b) UPDATE listings.building_id = matching buildings.id where
--      property_slug aligns.
--
-- Only triggers on listings that have BOTH property_name and
-- property_slug set; rows without those are left with building_id NULL
-- and can be reconciled by hand later.

-- 3a. Pull from the matview snapshot first (if section 0 wrote one).
-- Defensive about which columns exist — the matview shape varies by
-- environment; we read whichever of building_name / name and the
-- slug-equivalent exist.
DO $$
DECLARE
  has_snapshot      boolean;
  has_building_name boolean;
  has_name          boolean;
  has_slug          boolean;
  sql_text          text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'buildings_legacy_snapshot'
  ) INTO has_snapshot;
  IF NOT has_snapshot THEN RETURN; END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='buildings_legacy_snapshot' AND column_name='building_name')
    INTO has_building_name;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='buildings_legacy_snapshot' AND column_name='name')
    INTO has_name;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='buildings_legacy_snapshot' AND column_name='slug')
    INTO has_slug;

  -- Build a SELECT list that picks up whichever of name/building_name
  -- the snapshot has, and synthesizes a slug if the snapshot didn't.
  sql_text :=
    'INSERT INTO public.buildings (name, slug) ' ||
    'SELECT DISTINCT '
       || CASE WHEN has_name THEN 'name'
               WHEN has_building_name THEN 'building_name'
               ELSE 'NULL::text' END
       || ', '
       || CASE WHEN has_slug THEN 'slug'
               ELSE 'trim(BOTH ''-'' FROM regexp_replace(regexp_replace(lower('
                    || CASE WHEN has_name THEN 'name' ELSE 'building_name' END
                    || '), ''[^a-z0-9]+'', ''-'', ''g''), ''-+'', ''-'', ''g''))' END
       || ' FROM public.buildings_legacy_snapshot WHERE '
       || CASE WHEN has_name THEN 'name IS NOT NULL AND name <> '''''
               WHEN has_building_name THEN 'building_name IS NOT NULL AND building_name <> '''''
               ELSE 'false' END
       || ' ON CONFLICT (slug) WHERE slug IS NOT NULL DO NOTHING';
  EXECUTE sql_text;
END $$;

-- 3b. Then pull from listings (covers any rows the matview missed).
-- Some environments don't carry property_name / property_slug on
-- listings (the denormalized pair was dropped/never added). Guard with
-- a column-exists check so this section is a no-op there; the
-- snapshot-based backfill in 3a handles those installs on its own.
DO $$
DECLARE
  has_property_name boolean;
  has_property_slug boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='listings' AND column_name='property_name'
  ) INTO has_property_name;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='listings' AND column_name='property_slug'
  ) INTO has_property_slug;

  IF has_property_name AND has_property_slug THEN
    EXECUTE $sql$
      INSERT INTO public.buildings (name, slug)
      SELECT DISTINCT property_name, property_slug
      FROM public.listings
      WHERE property_name IS NOT NULL
        AND property_name <> ''
        AND property_slug IS NOT NULL
        AND property_slug <> ''
      ON CONFLICT (slug) WHERE slug IS NOT NULL DO NOTHING
    $sql$;

    EXECUTE $sql$
      UPDATE public.listings l
      SET building_id = b.id
      FROM public.buildings b
      WHERE l.property_slug = b.slug
        AND l.building_id IS NULL
    $sql$;
  ELSE
    RAISE NOTICE 'listings.property_name / .property_slug not present; skipping listings → buildings backfill. New listings will set building_id directly.';
  END IF;
END $$;

-- =====================================================================
-- 4. Permission + RLS
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('buildings.manage', 'Create / edit / delete buildings', 'admin')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'buildings.manage'),
  ('manager', 'buildings.manage')
ON CONFLICT DO NOTHING;

ALTER TABLE public.buildings ENABLE ROW LEVEL SECURITY;

-- READ: every authenticated user can browse buildings (reference
-- data — listings, search, dropdowns all need this). To expose to
-- anon (public site), add a separate policy `TO anon USING (true)`.
DROP POLICY IF EXISTS buildings_select_authenticated ON public.buildings;
CREATE POLICY buildings_select_authenticated
  ON public.buildings FOR SELECT
  TO authenticated
  USING (true);

-- INSERT: any authenticated user can suggest a new building (the
-- listing form's "+ Create new building" affordance). Soft tracking
-- via created_by so admins can audit.
DROP POLICY IF EXISTS buildings_insert_authenticated ON public.buildings;
CREATE POLICY buildings_insert_authenticated
  ON public.buildings FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- UPDATE / DELETE: gated by buildings.manage. We don't want random
-- agents renaming buildings under other people's listings.
DROP POLICY IF EXISTS buildings_update_managed ON public.buildings;
CREATE POLICY buildings_update_managed
  ON public.buildings FOR UPDATE
  TO authenticated
  USING (public.has_permission('buildings.manage'))
  WITH CHECK (public.has_permission('buildings.manage'));

DROP POLICY IF EXISTS buildings_delete_managed ON public.buildings;
CREATE POLICY buildings_delete_managed
  ON public.buildings FOR DELETE
  TO authenticated
  USING (public.has_permission('buildings.manage'));

-- Table-level GRANTs — RLS is necessary but not sufficient. Same
-- pattern that bit us with cities/barangays: an open policy doesn't
-- help if `authenticated` lacks SELECT at the table level.
GRANT SELECT ON public.buildings TO authenticated, anon;
GRANT INSERT, UPDATE, DELETE ON public.buildings TO authenticated;

NOTIFY pgrst, 'reload schema';
