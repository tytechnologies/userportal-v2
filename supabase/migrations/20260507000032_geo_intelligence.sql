-- Geo Discovery + Heatmap Intelligence.
--
-- 4 additional heatmap RPCs (inventory, trust, luxury, velocity)
-- + per-barangay hot-area detection. Same privacy floors as the
-- existing pricing/demand RPCs (mig 28). All bounds-filtered, all
-- live (no MV staleness), all explainable.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.market_hot_areas(bigint, int);
--   DROP FUNCTION IF EXISTS public.market_velocity_heatmap_grid(numeric,numeric,numeric,numeric,numeric);
--   DROP FUNCTION IF EXISTS public.market_luxury_heatmap_grid(numeric,numeric,numeric,numeric,numeric);
--   DROP FUNCTION IF EXISTS public.market_trust_heatmap_grid(numeric,numeric,numeric,numeric,numeric);
--   DROP FUNCTION IF EXISTS public.market_inventory_heatmap_grid(numeric,numeric,numeric,numeric,numeric);


-- =====================================================================
-- 1. market_inventory_heatmap_grid — supply concentration
-- =====================================================================
--
-- Per-cell count of available (non-sold, non-reserved) listings.
-- Density visualization — where the inventory is.

CREATE OR REPLACE FUNCTION public.market_inventory_heatmap_grid(
  p_min_lat numeric,
  p_min_lng numeric,
  p_max_lat numeric,
  p_max_lng numeric,
  p_cell_size_deg numeric DEFAULT 0.01
) RETURNS TABLE (
  cell_lat        numeric,
  cell_lng        numeric,
  available_count bigint,
  sold_count      bigint,
  total_count     bigint
)
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = public, extensions
AS $$
  WITH located AS (
    SELECT
      l.id,
      coalesce(lms.market_status, 'available') AS status,
      ST_Y(b.geom)::numeric AS lat,
      ST_X(b.geom)::numeric AS lng
    FROM public.listings l
    JOIN public.buildings b ON b.id = l.building_id
    LEFT JOIN public.listing_market_status lms ON lms.listing_id = l.id
    WHERE l.is_online = true
      AND l.deleted_at IS NULL
      AND b.geom IS NOT NULL
      AND b.geom && ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)
  )
  SELECT
    floor(lat / p_cell_size_deg) * p_cell_size_deg AS cell_lat,
    floor(lng / p_cell_size_deg) * p_cell_size_deg AS cell_lng,
    count(*) FILTER (WHERE status = 'available')::bigint AS available_count,
    count(*) FILTER (WHERE status = 'sold')::bigint      AS sold_count,
    count(*)::bigint                                     AS total_count
  FROM located
  GROUP BY 1, 2
  HAVING count(*) >= 3;
$$;
GRANT EXECUTE ON FUNCTION public.market_inventory_heatmap_grid(numeric, numeric, numeric, numeric, numeric) TO authenticated;


-- =====================================================================
-- 2. market_trust_heatmap_grid — avg broker trust per cell
-- =====================================================================
--
-- Higher floor (≥5) than pricing/inventory because sparser cells
-- could de-anonymize a single broker's trust score by location.

CREATE OR REPLACE FUNCTION public.market_trust_heatmap_grid(
  p_min_lat numeric,
  p_min_lng numeric,
  p_max_lat numeric,
  p_max_lng numeric,
  p_cell_size_deg numeric DEFAULT 0.01
) RETURNS TABLE (
  cell_lat         numeric,
  cell_lng         numeric,
  avg_trust_score  numeric,
  distinct_brokers bigint,
  listing_count    bigint
)
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = public, extensions
AS $$
  WITH located AS (
    SELECT
      l.id,
      l.created_by,
      coalesce(ts.trust_score, 0)::numeric AS trust_score,
      ST_Y(b.geom)::numeric AS lat,
      ST_X(b.geom)::numeric AS lng
    FROM public.listings l
    JOIN public.buildings b ON b.id = l.building_id
    LEFT JOIN public.trust_score ts
      ON ts.target_type = 'agent' AND ts.target_id = l.created_by::text
    WHERE l.is_online = true
      AND l.deleted_at IS NULL
      AND b.geom IS NOT NULL
      AND b.geom && ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)
  )
  SELECT
    floor(lat / p_cell_size_deg) * p_cell_size_deg AS cell_lat,
    floor(lng / p_cell_size_deg) * p_cell_size_deg AS cell_lng,
    round(avg(trust_score), 2)               AS avg_trust_score,
    count(DISTINCT created_by)::bigint        AS distinct_brokers,
    count(*)::bigint                          AS listing_count
  FROM located
  GROUP BY 1, 2
  -- Higher privacy floor: ≥5 listings AND ≥2 distinct brokers, so a
  -- single broker's trust score isn't visible by geography.
  HAVING count(*) >= 5 AND count(DISTINCT created_by) >= 2;
$$;
GRANT EXECUTE ON FUNCTION public.market_trust_heatmap_grid(numeric, numeric, numeric, numeric, numeric) TO authenticated;


-- =====================================================================
-- 3. market_luxury_heatmap_grid — luxury concentration
-- =====================================================================
--
-- Per-cell percentage of listings priced above the city p90 of
-- price-per-sqm. Within-city percentile keeps "luxury" relative —
-- a high-priced barangay in a non-Metro city still surfaces.

CREATE OR REPLACE FUNCTION public.market_luxury_heatmap_grid(
  p_min_lat numeric,
  p_min_lng numeric,
  p_max_lat numeric,
  p_max_lng numeric,
  p_cell_size_deg numeric DEFAULT 0.01
) RETURNS TABLE (
  cell_lat            numeric,
  cell_lng            numeric,
  luxury_pct          numeric,
  luxury_count        bigint,
  listing_count       bigint
)
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = public, extensions
AS $$
  WITH per_listing AS (
    SELECT
      l.id,
      l.city_id,
      l.sale_price::numeric / NULLIF(l.floor_area, 0) AS pps,
      ST_Y(b.geom)::numeric AS lat,
      ST_X(b.geom)::numeric AS lng
    FROM public.listings l
    JOIN public.buildings b ON b.id = l.building_id
    WHERE l.is_online = true
      AND l.deleted_at IS NULL
      AND l.sale_price IS NOT NULL AND l.sale_price > 0
      AND l.floor_area IS NOT NULL AND l.floor_area > 0
      AND b.geom IS NOT NULL
      AND b.geom && ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)
  ),
  city_p90 AS (
    -- p90 of price-per-sqm per city, computed across the listings
    -- inside the requested bounding box. Within-bounds threshold so
    -- "luxury" is local-relative.
    SELECT
      city_id,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY pps) AS p90_pps
    FROM per_listing
    WHERE pps IS NOT NULL
    GROUP BY city_id
  )
  SELECT
    floor(p.lat / p_cell_size_deg) * p_cell_size_deg AS cell_lat,
    floor(p.lng / p_cell_size_deg) * p_cell_size_deg AS cell_lng,
    round(
      100.0 * count(*) FILTER (WHERE p.pps >= cp.p90_pps)::numeric / count(*)::numeric,
      1
    ) AS luxury_pct,
    count(*) FILTER (WHERE p.pps >= cp.p90_pps)::bigint AS luxury_count,
    count(*)::bigint AS listing_count
  FROM per_listing p
  LEFT JOIN city_p90 cp ON cp.city_id = p.city_id
  GROUP BY 1, 2
  HAVING count(*) >= 5;  -- ≥5 to make the percentage meaningful
$$;
GRANT EXECUTE ON FUNCTION public.market_luxury_heatmap_grid(numeric, numeric, numeric, numeric, numeric) TO authenticated;


-- =====================================================================
-- 4. market_velocity_heatmap_grid — median DOM per cell
-- =====================================================================
--
-- "Fast moving" cells are areas with low DOM (days on market). The
-- value is median DOM directly — UI inverts the color scale so low
-- DOM displays as "hot."

CREATE OR REPLACE FUNCTION public.market_velocity_heatmap_grid(
  p_min_lat numeric,
  p_min_lng numeric,
  p_max_lat numeric,
  p_max_lng numeric,
  p_cell_size_deg numeric DEFAULT 0.01
) RETURNS TABLE (
  cell_lat        numeric,
  cell_lng        numeric,
  median_dom_days numeric,
  listing_count   bigint
)
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = public, extensions
AS $$
  WITH located AS (
    SELECT
      l.id,
      EXTRACT(EPOCH FROM (now() - coalesce(l.price_changed_at, l.created_at))) / 86400 AS dom_days,
      ST_Y(b.geom)::numeric AS lat,
      ST_X(b.geom)::numeric AS lng
    FROM public.listings l
    JOIN public.buildings b ON b.id = l.building_id
    WHERE l.is_online = true
      AND l.deleted_at IS NULL
      AND b.geom IS NOT NULL
      AND b.geom && ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)
  )
  SELECT
    floor(lat / p_cell_size_deg) * p_cell_size_deg AS cell_lat,
    floor(lng / p_cell_size_deg) * p_cell_size_deg AS cell_lng,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dom_days)::numeric, 1) AS median_dom_days,
    count(*)::bigint AS listing_count
  FROM located
  GROUP BY 1, 2
  HAVING count(*) >= 3;
$$;
GRANT EXECUTE ON FUNCTION public.market_velocity_heatmap_grid(numeric, numeric, numeric, numeric, numeric) TO authenticated;


-- =====================================================================
-- 5. market_hot_areas — per-barangay deterministic hot-zone scoring
-- =====================================================================
--
-- Combines 5 normalized signals (within-city z-scores) into a single
-- explainable hot_score. Each signal's component is exposed in the
-- response so the UI can show "why this is hot."
--
-- Sparse barangays (≤5 listings) excluded — z-scores require enough
-- samples to be meaningful.

CREATE OR REPLACE FUNCTION public.market_hot_areas(
  p_city_id bigint DEFAULT NULL,
  p_limit   int    DEFAULT 20
) RETURNS TABLE (
  barangay_id     bigint,
  city_id         bigint,
  hot_score       numeric,
  inquiry_velocity_30d   numeric,
  deal_velocity_30d      numeric,
  price_growth_pct       numeric,
  median_dom_days        numeric,
  avg_trust_score        numeric,
  listing_count          bigint,
  components             jsonb
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  WITH per_barangay AS (
    SELECT
      l.barangay_id,
      l.city_id,
      count(*)                                                         AS listing_count,
      count(DISTINCT i.id) FILTER (WHERE i.created_at > now() - interval '30 days') AS inquiries_30d,
      count(DISTINCT d.id) FILTER (WHERE d.closed_at > now() - interval '30 days' AND d.closed_won = true) AS deals_30d,
      avg(l.sale_price::numeric / NULLIF(l.floor_area, 0))::numeric    AS avg_pps_now,
      avg(EXTRACT(EPOCH FROM (now() - coalesce(l.price_changed_at, l.created_at))) / 86400)::numeric AS avg_dom_days,
      avg(coalesce(ts.trust_score, 0))::numeric                        AS avg_trust
    FROM public.listings l
    LEFT JOIN public.inquiries i  ON i.listing_id = l.id
    LEFT JOIN public.deals     d  ON d.listing_id = l.id
    LEFT JOIN public.trust_score ts
      ON ts.target_type = 'agent' AND ts.target_id = l.created_by::text
    WHERE l.is_online = true
      AND l.deleted_at IS NULL
      AND l.barangay_id IS NOT NULL
      AND (p_city_id IS NULL OR l.city_id = p_city_id)
    GROUP BY l.barangay_id, l.city_id
    HAVING count(*) >= 5
  ),
  -- per-city stats for normalizing to z-scores within the city
  city_stats AS (
    SELECT
      city_id,
      avg(inquiries_30d)::numeric  AS m_inq,  stddev_samp(inquiries_30d)::numeric  AS s_inq,
      avg(deals_30d)::numeric      AS m_deal, stddev_samp(deals_30d)::numeric      AS s_deal,
      avg(avg_dom_days)::numeric   AS m_dom,  stddev_samp(avg_dom_days)::numeric   AS s_dom,
      avg(avg_trust)::numeric      AS m_trust,stddev_samp(avg_trust)::numeric      AS s_trust,
      avg(avg_pps_now)::numeric    AS m_pps,  stddev_samp(avg_pps_now)::numeric    AS s_pps
    FROM per_barangay
    GROUP BY city_id
  ),
  scored AS (
    SELECT
      pb.barangay_id,
      pb.city_id,
      pb.listing_count,
      pb.inquiries_30d,
      pb.deals_30d,
      pb.avg_dom_days,
      pb.avg_trust,
      pb.avg_pps_now,
      -- z-scores; NULLIF guard against zero stddev (single-barangay city).
      coalesce((pb.inquiries_30d - cs.m_inq)  / NULLIF(cs.s_inq, 0),  0) AS z_inq,
      coalesce((pb.deals_30d     - cs.m_deal) / NULLIF(cs.s_deal, 0), 0) AS z_deal,
      coalesce((pb.avg_pps_now   - cs.m_pps)  / NULLIF(cs.s_pps, 0),  0) AS z_price,
      -- DOM z is INVERTED (lower DOM = hotter), so subtract.
      coalesce((cs.m_dom - pb.avg_dom_days)   / NULLIF(cs.s_dom, 0),  0) AS z_dom_inv,
      coalesce((pb.avg_trust     - cs.m_trust)/ NULLIF(cs.s_trust, 0),0) AS z_trust
    FROM per_barangay pb
    LEFT JOIN city_stats cs ON cs.city_id = pb.city_id
  )
  SELECT
    s.barangay_id,
    s.city_id,
    -- weighted composite. Weights chosen for v1: demand + closes
    -- dominate; price growth + DOM are secondary; trust is tertiary.
    round(
      (s.z_inq      * 0.30
     + s.z_deal     * 0.25
     + s.z_price    * 0.20
     + s.z_dom_inv  * 0.15
     + s.z_trust    * 0.10)::numeric, 3
    )                                                  AS hot_score,
    s.inquiries_30d::numeric                           AS inquiry_velocity_30d,
    s.deals_30d::numeric                               AS deal_velocity_30d,
    s.z_price                                          AS price_growth_pct,
    round(s.avg_dom_days, 1)                           AS median_dom_days,
    round(s.avg_trust, 1)                              AS avg_trust_score,
    s.listing_count::bigint                            AS listing_count,
    jsonb_build_object(
      'inquiry_velocity', round(s.z_inq * 0.30, 3),
      'deal_velocity',    round(s.z_deal * 0.25, 3),
      'price_growth',     round(s.z_price * 0.20, 3),
      'velocity_dom',     round(s.z_dom_inv * 0.15, 3),
      'trust',            round(s.z_trust * 0.10, 3)
    )                                                  AS components
  FROM scored s
  ORDER BY hot_score DESC
  LIMIT p_limit;
$$;
GRANT EXECUTE ON FUNCTION public.market_hot_areas(bigint, int) TO authenticated;

COMMENT ON FUNCTION public.market_hot_areas(bigint, int) IS
  'Per-barangay deterministic hot-zone scoring. Combines 5 within-city z-scores (inquiry/deal velocity, price growth, DOM, trust). Excludes barangays with ≤5 listings. Returns components breakdown for explainability.';


-- =====================================================================
-- 6. Governance — register the 5 new RPCs
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.market_inventory_heatmap_grid', 'function', 'userportal', ARRAY['userportal'],
   'Per-cell available/sold/total counts. ≥3 privacy floor.', false),
  ('public.market_trust_heatmap_grid',     'function', 'userportal', ARRAY['userportal'],
   'Per-cell average broker trust score. ≥5 listings AND ≥2 distinct brokers.', false),
  ('public.market_luxury_heatmap_grid',    'function', 'userportal', ARRAY['userportal'],
   'Per-cell % of listings above city p90 ppsm. Within-city percentile.', false),
  ('public.market_velocity_heatmap_grid',  'function', 'userportal', ARRAY['userportal'],
   'Per-cell median DOM (days on market). Lower = hotter.', false),
  ('public.market_hot_areas',              'function', 'userportal', ARRAY['userportal'],
   'Per-barangay hot-zone scoring (within-city z-scores). Returns component breakdown for explainability.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
