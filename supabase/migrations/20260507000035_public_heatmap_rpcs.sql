-- Public Heatmap + Geo Intelligence Wrappers.
--
-- The private heatmap RPCs (mig 28/32) require authenticated access.
-- This migration adds anon-callable SECURITY DEFINER wrappers that
-- preserve all privacy floors and return a normalized shape so the
-- website map can render any of the 6 modes from a single overlay
-- component.
--
-- Privacy: every wrapper calls the existing private RPCs, which
-- already enforce HAVING count(*) >= 3 (or ≥5 for trust/luxury).
-- No new SQL paths bypass those gates.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.public_hot_area_summary(text);
--   DROP FUNCTION IF EXISTS public.public_building_intelligence(text);
--   DROP FUNCTION IF EXISTS public.public_heatmap_grid(text, numeric, numeric, numeric, numeric, numeric);


-- =====================================================================
-- 1. public_heatmap_grid — single dispatch RPC for all 6 modes
-- =====================================================================
--
-- Returns a normalized cell shape: (cell_lat, cell_lng, value, count,
-- label). Mode-specific value semantics are documented in the `label`
-- field so the UI doesn't have to know the per-mode column names.

CREATE OR REPLACE FUNCTION public.public_heatmap_grid(
  p_mode          text,
  p_min_lat       numeric,
  p_min_lng       numeric,
  p_max_lat       numeric,
  p_max_lng       numeric,
  p_cell_size_deg numeric DEFAULT 0.01
) RETURNS TABLE (
  cell_lat   numeric,
  cell_lng   numeric,
  value      numeric,
  cnt        bigint,
  label      text
)
LANGUAGE plpgsql STABLE PARALLEL SAFE
SET search_path = public, extensions
AS $$
DECLARE
  v_max_cells constant int := 1500;
BEGIN
  -- Sanity-check the bounding box.
  IF p_min_lat IS NULL OR p_max_lat IS NULL OR p_min_lat >= p_max_lat
     OR p_min_lng IS NULL OR p_max_lng IS NULL OR p_min_lng >= p_max_lng THEN
    RETURN;
  END IF;

  -- Dispatch by mode. Each branch wraps a private RPC and projects
  -- to the normalized shape. The label tells the UI what the value
  -- means without the UI hardcoding per-mode logic.
  IF p_mode = 'pricing' THEN
    RETURN QUERY
      SELECT
        h.cell_lat,
        h.cell_lng,
        h.median_price_per_sqm AS value,
        h.listing_count        AS cnt,
        'median_price_per_sqm'::text AS label
      FROM public.market_pricing_heatmap_grid(
             p_min_lat, p_min_lng, p_max_lat, p_max_lng, p_cell_size_deg) h
      LIMIT v_max_cells;

  ELSIF p_mode = 'demand' THEN
    RETURN QUERY
      SELECT
        h.cell_lat,
        h.cell_lng,
        h.inquiry_count_30d::numeric AS value,
        h.listing_count              AS cnt,
        'inquiry_count_30d'::text    AS label
      FROM public.market_demand_heatmap_grid(
             p_min_lat, p_min_lng, p_max_lat, p_max_lng, p_cell_size_deg) h
      LIMIT v_max_cells;

  ELSIF p_mode = 'inventory' THEN
    RETURN QUERY
      SELECT
        h.cell_lat,
        h.cell_lng,
        h.available_count::numeric  AS value,
        h.total_count               AS cnt,
        'available_count'::text     AS label
      FROM public.market_inventory_heatmap_grid(
             p_min_lat, p_min_lng, p_max_lat, p_max_lng, p_cell_size_deg) h
      LIMIT v_max_cells;

  ELSIF p_mode = 'trust' THEN
    RETURN QUERY
      SELECT
        h.cell_lat,
        h.cell_lng,
        h.avg_trust_score        AS value,
        h.listing_count          AS cnt,
        'avg_trust_score'::text  AS label
      FROM public.market_trust_heatmap_grid(
             p_min_lat, p_min_lng, p_max_lat, p_max_lng, p_cell_size_deg) h
      LIMIT v_max_cells;

  ELSIF p_mode = 'luxury' THEN
    RETURN QUERY
      SELECT
        h.cell_lat,
        h.cell_lng,
        h.luxury_pct           AS value,
        h.listing_count        AS cnt,
        'luxury_pct'::text     AS label
      FROM public.market_luxury_heatmap_grid(
             p_min_lat, p_min_lng, p_max_lat, p_max_lng, p_cell_size_deg) h
      LIMIT v_max_cells;

  ELSIF p_mode = 'velocity' THEN
    RETURN QUERY
      SELECT
        h.cell_lat,
        h.cell_lng,
        h.median_dom_days       AS value,
        h.listing_count         AS cnt,
        'median_dom_days'::text AS label
      FROM public.market_velocity_heatmap_grid(
             p_min_lat, p_min_lng, p_max_lat, p_max_lng, p_cell_size_deg) h
      LIMIT v_max_cells;

  ELSE
    -- Unknown mode: return nothing rather than raising — keeps the
    -- public surface forgiving of bad query params.
    RETURN;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_heatmap_grid(text, numeric, numeric, numeric, numeric, numeric) TO anon, authenticated;

COMMENT ON FUNCTION public.public_heatmap_grid(text, numeric, numeric, numeric, numeric, numeric) IS
  'Anon-callable normalized heatmap dispatcher. Wraps the 6 private heatmap RPCs (preserves their HAVING≥3/≥5 privacy floors). Caps response at 1500 cells. Mode ∈ {pricing, demand, inventory, trust, luxury, velocity}.';


-- =====================================================================
-- 2. public_building_intelligence — building popup data
-- =====================================================================
--
-- Returns a single building's market intelligence. Sparse-data gate:
-- ≥3 listings to expose aggregates. Below threshold: returns
-- { sufficient_data: false }.

CREATE OR REPLACE FUNCTION public.public_building_intelligence(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public STABLE
AS $$
DECLARE
  v_building   record;
  v_summary    record;
  v_zonal_avg  numeric;
BEGIN
  -- Resolve building by slug.
  SELECT id, name, slug, city_id, barangay_id, developer_id
    INTO v_building
    FROM public.buildings
   WHERE slug = p_slug
   LIMIT 1;

  IF v_building.id IS NULL THEN
    RETURN jsonb_build_object('sufficient_data', false, 'reason', 'building_not_found');
  END IF;

  -- Read pre-aggregated row from building_market_summary.
  SELECT
    listing_count, available_count, sold_count,
    median_price, median_price_per_sqm,
    deals_won_90d, gmv_90d,
    trust_score, review_count, avg_rating
  INTO v_summary
  FROM public.building_market_summary
  WHERE building_id = v_building.id;

  IF v_summary.listing_count IS NULL OR v_summary.listing_count < 3 THEN
    RETURN jsonb_build_object(
      'building', jsonb_build_object('id', v_building.id, 'name', v_building.name, 'slug', v_building.slug),
      'sufficient_data', false,
      'listing_count', coalesce(v_summary.listing_count, 0),
      'reason', 'insufficient_listings'
    );
  END IF;

  -- Avg zonal premium ratio across this building's active listings.
  SELECT avg(zonal_premium_ratio)
    INTO v_zonal_avg
    FROM public.listing_zonal_comparison lzc
    JOIN public.listings l ON l.id = lzc.listing_id
   WHERE l.building_id = v_building.id
     AND lzc.zonal_premium_ratio IS NOT NULL;

  RETURN jsonb_build_object(
    'building', jsonb_build_object(
      'id',   v_building.id,
      'name', v_building.name,
      'slug', v_building.slug
    ),
    'sufficient_data', true,
    'listing_count',         v_summary.listing_count,
    'available_count',       v_summary.available_count,
    'sold_count',            v_summary.sold_count,
    'median_price',          v_summary.median_price,
    'median_price_per_sqm',  v_summary.median_price_per_sqm,
    'deals_won_90d',         coalesce(v_summary.deals_won_90d, 0),
    'gmv_90d',               coalesce(v_summary.gmv_90d, 0),
    'trust_score',           v_summary.trust_score,
    'review_count',          coalesce(v_summary.review_count, 0),
    'avg_rating',            v_summary.avg_rating,
    'zonal', jsonb_build_object(
      'avg_premium_ratio', round(v_zonal_avg, 4),
      'has_zonal_data',    v_zonal_avg IS NOT NULL
    ),
    'evaluated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_building_intelligence(text) TO anon, authenticated;


-- =====================================================================
-- 3. public_hot_area_summary — city-level hot barangays for the map
-- =====================================================================
--
-- Wraps market_hot_areas() with a city resolver. Returns top-N hot
-- barangays as marker-ready data (with center coordinates from the
-- barangay's representative building, when available).

CREATE OR REPLACE FUNCTION public.public_hot_area_summary(
  p_city_slug text,
  p_limit     int DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions STABLE
AS $$
DECLARE
  v_city  record;
  v_areas jsonb;
BEGIN
  SELECT id, name, slug INTO v_city
    FROM public.cities
   WHERE slug = p_city_slug
   LIMIT 1;

  IF v_city.id IS NULL THEN
    RETURN jsonb_build_object('city', NULL, 'areas', '[]'::jsonb, 'reason', 'city_not_found');
  END IF;

  -- Get hot areas, then enrich with barangay name + a representative
  -- coordinate (centroid of the buildings in that barangay). The
  -- centroid avoids exposing any single building's exact location.
  SELECT coalesce(jsonb_agg(a ORDER BY a.hot_score DESC), '[]'::jsonb)
    INTO v_areas
    FROM (
      SELECT
        ha.barangay_id,
        ba.name AS barangay_name,
        ba.slug AS barangay_slug,
        ha.hot_score,
        ha.inquiry_velocity_30d,
        ha.deal_velocity_30d,
        ha.median_dom_days,
        ha.listing_count,
        ha.components,
        -- Centroid of the buildings in this barangay (PostGIS).
        (SELECT ST_Y(ST_Centroid(ST_Collect(b.geom)))
           FROM public.buildings b
          WHERE b.barangay_id = ha.barangay_id AND b.geom IS NOT NULL) AS center_lat,
        (SELECT ST_X(ST_Centroid(ST_Collect(b.geom)))
           FROM public.buildings b
          WHERE b.barangay_id = ha.barangay_id AND b.geom IS NOT NULL) AS center_lng
      FROM public.market_hot_areas(v_city.id, p_limit) ha
      LEFT JOIN public.barangays ba ON ba.id = ha.barangay_id
    ) a;

  RETURN jsonb_build_object(
    'city',   jsonb_build_object('id', v_city.id, 'name', v_city.name, 'slug', v_city.slug),
    'areas',  v_areas,
    'evaluated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.public_hot_area_summary(text, int) TO anon, authenticated;


-- =====================================================================
-- 4. Governance — register the 3 new public RPCs
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.public_heatmap_grid',          'function', 'userportal', ARRAY['userportal','website'],
   'Anon-callable normalized heatmap dispatcher (6 modes). Caps at 1500 cells. Privacy floors enforced by underlying private RPCs.', true),
  ('public.public_building_intelligence', 'function', 'userportal', ARRAY['userportal','website'],
   'Anon-callable building intelligence card. Sparse-data threshold: ≥3 listings.', true),
  ('public.public_hot_area_summary',      'function', 'userportal', ARRAY['userportal','website'],
   'Anon-callable city-level hot barangays with PostGIS centroids for map markers.', true)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
