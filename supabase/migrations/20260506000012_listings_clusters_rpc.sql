-- Server-side map clustering RPC.
--
-- At zoomed-out levels (zoom 5-9: city / region scale), the website's
-- map page renders clusters of listings rather than individual pins.
-- Round 3 (listings_in_bounds) caps results at 2,000 per viewport,
-- which is fine at neighborhood zoom but loses fidelity at city zoom
-- when the underlying set is 50k+ listings.
--
-- This RPC produces grid-aligned cluster cells inside a bounding box.
-- Each cell carries a count and a representative listing_id (most
-- recent in the cell). Tiny payload, accurate count, sub-millisecond
-- on a typical viewport thanks to the GiST index on buildings.geom.
--
-- Algorithm:
--   1. Filter listings to live + non-deleted with a non-null
--      buildings.geom inside the envelope (same predicate as
--      listings_in_bounds — the GiST index handles it).
--   2. Snap each geom to a grid cell whose size is viewport-width / 16.
--      ST_SnapToGrid produces deterministic cell origins for the same
--      grid_size — re-running with the same bounds yields the same
--      clustering.
--   3. GROUP BY the snapped cell. Centroid + count + representative.
--
-- Why 16x16 cells in the viewport:
--   - Density independent of zoom: at any zoom level the user sees
--     roughly the same number of cluster bubbles.
--   - Below 256 total cells (well within typical map renderer budget).
--   - Tunable from the caller via custom envelope size.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.listings_clusters(
--     double precision, double precision, double precision, double precision, integer
--   );
--
-- DEPENDS ON:
--   20260506000011_buildings_postgis.sql  (postgis + buildings.geom + GiST)


DO $$
BEGIN
  -- Hard requirement: this migration's CREATE FUNCTION uses geometry
  -- types from PostGIS. A soft NOTICE + RETURN would only exit this
  -- DO block; the function below would then 42704 with a confusing
  -- "type 'geometry' does not exist" message. Abort here instead.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION
      'PostGIS not installed. Apply migration 20260506000011_buildings_postgis.sql first (it installs PostGIS or instructs you how), then re-run this migration.'
      USING ERRCODE = 'feature_not_supported';
  END IF;
END
$$;

-- Resolve PostGIS types/functions for the function body. Supabase
-- installs postgis in `extensions`; vanilla Postgres in `public`.
-- Listing both is harmless either way.
SET search_path = public, extensions;


CREATE OR REPLACE FUNCTION public.listings_clusters(
  p_north double precision,
  p_south double precision,
  p_east  double precision,
  p_west  double precision,
  p_zoom  integer DEFAULT 12
)
RETURNS TABLE (
  cluster_lat               double precision,
  cluster_lng               double precision,
  listing_count             integer,
  representative_listing_id bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
-- See migration 11 for rationale: extensions schema for PostGIS types.
SET search_path = public, extensions
AS $$
DECLARE
  v_envelope  geometry;
  v_grid_size double precision;
  v_width     double precision;
BEGIN
  -- Bounds sanity. Returns empty rather than raising — the website
  -- map page can drift bounds during init / drag, and we'd rather
  -- degrade silently than 500.
  IF p_north <= p_south OR p_east <= p_west THEN RETURN; END IF;
  IF p_north > 90 OR p_south < -90 OR p_east > 180 OR p_west < -180 THEN
    RETURN;
  END IF;

  -- Clamp zoom for telemetry / future zoom-aware tuning. Currently
  -- the cell size is derived from viewport width, not zoom — but we
  -- accept the param so future rounds can layer on zoom-aware logic
  -- without a signature change.
  p_zoom := GREATEST(1, LEAST(22, COALESCE(p_zoom, 12)));

  v_envelope := ST_MakeEnvelope(p_west, p_south, p_east, p_north, 4326);
  v_width    := p_east - p_west;
  v_grid_size := v_width / 16.0;

  -- Guard against pathologically tiny viewports producing zero-size
  -- cells (which would make ST_SnapToGrid return the same point
  -- everywhere, collapsing all listings into a single cluster).
  IF v_grid_size <= 0 THEN v_grid_size := 0.0001; END IF;

  RETURN QUERY
  WITH eligible AS (
    -- l.id is `integer` in the baseline; cast to bigint here so the
    -- representative_listing_id column matches the RETURNS TABLE
    -- contract (and stays correct if the column is ever widened).
    SELECT l.id::bigint AS id, b.geom, l.updated_at
    FROM   public.listings  l
    JOIN   public.buildings b ON b.id = l.building_id
    WHERE  l.is_online = true
      AND  l.deleted_at IS NULL
      AND  b.geom IS NOT NULL
      AND  b.geom && v_envelope
      AND  ST_Within(b.geom, v_envelope)
  ),
  snapped AS (
    SELECT
      e.id,
      e.geom,
      ST_SnapToGrid(e.geom, v_grid_size) AS grid_cell,
      e.updated_at
    FROM eligible e
  ),
  grouped AS (
    -- Aliases here must NOT match the function's RETURNS TABLE OUT
    -- parameter names (listing_count, representative_listing_id) —
    -- bare references in the final SELECT would be ambiguous between
    -- the OUT variable and the column. Position-based mapping at
    -- RETURN QUERY routes the columns to the right OUT params
    -- regardless of inner alias name.
    SELECT
      grid_cell,
      ST_Centroid(ST_Collect(geom)) AS centroid,
      count(*)::int                  AS lc,
      -- Representative: most recently updated listing in the cell.
      -- Ties broken implicitly by array_agg ordering — visually
      -- stable enough for cluster popups.
      (array_agg(id ORDER BY updated_at DESC))[1] AS rep_id
    FROM snapped
    GROUP BY grid_cell
  )
  SELECT
    ST_Y(centroid)::double precision,
    ST_X(centroid)::double precision,
    lc,
    rep_id
  FROM grouped
  ORDER BY lc DESC
  LIMIT 500;
END
$$;

COMMENT ON FUNCTION public.listings_clusters(double precision, double precision, double precision, double precision, integer) IS
  'Returns grid-clustered listing centroids inside a bounding box. SECURITY INVOKER (RLS applies); anon-callable. Cell size = viewport_width / 16, capped to 500 cells per call.';

REVOKE ALL ON FUNCTION public.listings_clusters(double precision, double precision, double precision, double precision, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listings_clusters(double precision, double precision, double precision, double precision, integer) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
