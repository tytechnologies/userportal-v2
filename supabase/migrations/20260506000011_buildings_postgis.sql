-- PostGIS spatial index on buildings.
--
-- Replaces the website map page's "load every active listing then
-- bounds-filter in JS" pattern with a server-side bounding-box query
-- that uses a GiST index. Eliminates the unbounded JSON payload risk
-- the original audit flagged for the map page.
--
-- Architecture:
--   - buildings.latitude / longitude already exist (numeric, since
--     20260501000011_buildings_remediation). Optional fields.
--   - Add buildings.geom (geometry(Point, 4326)) as a STORED generated
--     column. Auto-derives on every UPDATE; NULL if either coord is
--     missing. SRID 4326 = WGS84 = the lat/long the existing data is
--     already in.
--   - GiST partial index covers only buildings with coords. Tiny vs.
--     covering all rows.
--   - `listings_in_bounds()` RPC returns listing_ids inside an
--     envelope. SECURITY INVOKER — RLS on listings + buildings still
--     applies. Anon-callable.
--
-- Why partial GiST: most buildings will have coords once curated, but
-- transitional rows without coords shouldn't bloat the index.
--
-- Why GENERATED ALWAYS AS ... STORED: same trade-off as
-- listings.search_tsv from migration 20260506000010 — slightly more
-- disk for meaningfully faster reads (no recompute per query).
--
-- Conditional installation:
--   PostGIS is shipped with Supabase but must be explicitly enabled
--   per project. If it isn't, this migration emits a NOTICE and
--   exits cleanly. Re-run after enabling via Supabase Dashboard →
--   Database → Extensions.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.listings_in_bounds(double precision, double precision, double precision, double precision, integer);
--   DROP INDEX IF EXISTS public.buildings_geom_gist_idx;
--   ALTER TABLE public.buildings DROP COLUMN IF EXISTS geom;
--   -- DROP EXTENSION IF EXISTS postgis;  -- only if you want to fully remove
--
-- DEPENDS ON:
--   20260501000006_buildings_first_class.sql      (buildings as base table)
--   20260501000011_buildings_remediation.sql      (lat/long columns)
--   20260501000007_public_anon_listings_read.sql  (anon SELECT on buildings + listings)


DO $$
BEGIN
  -- Best-effort self-enable. Most Supabase projects require the
  -- extension to be enabled via Dashboard → Database → Extensions
  -- (CREATE EXTENSION needs ownership privileges). If we can't, the
  -- check below will fail loudly rather than silently letting the
  -- function-creation statements crash with confusing 42704 errors.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS postgis;
    EXCEPTION WHEN OTHERS THEN
      -- Swallow — fall through to the hard check below.
      NULL;
    END;
  END IF;

  -- Hard requirement: subsequent statements reference `geometry` types
  -- which only exist when PostGIS is loaded. A "soft NOTICE + RETURN"
  -- here would only exit this DO block; the unconditional CREATE
  -- FUNCTION later would then crash with 42704 (type does not exist).
  -- Aborting the migration here gives the operator a clear next step.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION
      'PostGIS extension is required for this migration but is not enabled. Enable it via Supabase Dashboard → Database → Extensions (or run "CREATE EXTENSION postgis;" as a privileged role), then re-run this migration.'
      USING ERRCODE = 'feature_not_supported';
  END IF;
END
$$;

-- Make PostGIS types and functions resolvable for the rest of this
-- migration. Supabase installs the postgis extension in the
-- `extensions` schema by default; bare `public` search_path can't
-- see the `geometry` type or `ST_*` functions, hence the 42704
-- "type does not exist" failure when the function body is parsed.
-- Listing both schemas is harmless on a vanilla Postgres install
-- where postgis lives in `public` (the second entry is just unused).
SET search_path = public, extensions;


-- =====================================================================
-- 1. Generated geom column
-- =====================================================================

DO $$
DECLARE
  v_t0 timestamptz := clock_timestamp();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    -- Conditional was hit above; nothing more to do.
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'buildings'
      AND column_name = 'geom'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE public.buildings
        ADD COLUMN geom geometry(Point, 4326)
        GENERATED ALWAYS AS (
          CASE
            WHEN latitude IS NULL OR longitude IS NULL THEN NULL
            ELSE ST_SetSRID(
              ST_MakePoint(longitude::double precision, latitude::double precision),
              4326
            )
          END
        ) STORED
    $sql$;

    RAISE NOTICE
      'Added buildings.geom (rewrote table; took %).',
      clock_timestamp() - v_t0;
  ELSE
    RAISE NOTICE 'buildings.geom already present; skipping ADD COLUMN.';
  END IF;
END
$$;

COMMENT ON COLUMN public.buildings.geom IS
  'Generated point geometry (SRID 4326 / WGS84) derived from latitude + longitude. NULL when either coord is NULL. Indexed by buildings_geom_gist_idx (partial WHERE geom IS NOT NULL). Auto-recomputed on UPDATE.';


-- =====================================================================
-- 2. GiST partial index
-- =====================================================================
--
-- Only built when PostGIS + the column landed. Idempotent via
-- IF NOT EXISTS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'buildings' AND column_name = 'geom'
  ) THEN RETURN; END IF;

  EXECUTE $sql$
    CREATE INDEX IF NOT EXISTS buildings_geom_gist_idx
      ON public.buildings USING gist (geom)
      WHERE geom IS NOT NULL
  $sql$;
END
$$;


-- =====================================================================
-- 3. listings_in_bounds RPC
-- =====================================================================
--
-- Returns IDs of live, non-deleted listings whose linked building
-- falls inside the bounding box. Two-step predicate:
--
--   geom && envelope    →  index-eligible bbox overlap (cheap)
--   ST_Within(geom, …)  →  precise containment (correct at edges)
--
-- The combination is the standard PostGIS pattern: && lets the planner
-- use the GiST index, ST_Within keeps results exact.
--
-- SECURITY INVOKER so RLS on listings + buildings still applies. Both
-- already have anon-readable SELECT policies (listings_select_public,
-- buildings_select_public from 20260501000007), so anon can execute
-- this and get the right rows back.
--
-- p_limit caps the result set to keep the JSON envelope bounded even
-- on very wide drag-zooms. The caller (the public listings endpoint)
-- enforces its own limit too.

CREATE OR REPLACE FUNCTION public.listings_in_bounds(
  p_north double precision,
  p_south double precision,
  p_east  double precision,
  p_west  double precision,
  p_limit integer DEFAULT 2000
)
RETURNS TABLE (listing_id bigint)
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
-- search_path includes `extensions` so geometry / ST_* resolve
-- regardless of caller's session search_path. Supabase installs
-- PostGIS in extensions; vanilla Postgres puts it in public.
-- Listing both makes this function portable.
SET search_path = public, extensions
AS $$
DECLARE
  v_envelope geometry;
BEGIN
  -- Sanity: clamp limit + reject inverted / nonsense bounds.
  IF p_limit IS NULL OR p_limit <= 0 THEN p_limit := 2000; END IF;
  IF p_limit > 5000 THEN p_limit := 5000; END IF;
  IF p_north <= p_south OR p_east <= p_west THEN
    RETURN;
  END IF;
  IF p_north > 90 OR p_south < -90 OR p_east > 180 OR p_west < -180 THEN
    RETURN;
  END IF;

  -- ST_MakeEnvelope(xmin, ymin, xmax, ymax, srid) — xmin/xmax are
  -- longitudes, ymin/ymax are latitudes.
  v_envelope := ST_MakeEnvelope(p_west, p_south, p_east, p_north, 4326);

  RETURN QUERY
    -- l.id is `integer` in the baseline schema; the ::bigint cast
    -- satisfies the function's RETURNS TABLE contract and stays
    -- correct if the column is ever widened.
    SELECT l.id::bigint
    FROM   public.listings l
    JOIN   public.buildings b ON b.id = l.building_id
    WHERE  l.is_online = true
      AND  l.deleted_at IS NULL
      AND  b.geom IS NOT NULL
      AND  b.geom && v_envelope
      AND  ST_Within(b.geom, v_envelope)
    ORDER  BY l.updated_at DESC
    LIMIT  p_limit;
END
$$;

COMMENT ON FUNCTION public.listings_in_bounds(double precision, double precision, double precision, double precision, integer) IS
  'Returns listing_ids whose building falls inside the bounding box. SECURITY INVOKER so RLS on listings + buildings applies. Anon-callable. Backs the website map page''s viewport-bounds query.';

REVOKE ALL ON FUNCTION public.listings_in_bounds(double precision, double precision, double precision, double precision, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listings_in_bounds(double precision, double precision, double precision, double precision, integer)
  TO anon, authenticated;


-- =====================================================================
-- 4. Refresh stats
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    EXECUTE 'ANALYZE public.buildings';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
