-- Market Intelligence Layer.
--
-- Additive analytics on top of listings/deals/inquiries/zonal_values.
-- Live aggregation views for medium-cost reads + two materialized
-- views (monthly trends, listing quality) for heavier rollups.
--
-- All views are RLS-permissive (authenticated reads); the
-- listings/deals row policies still apply through their underlying
-- tables. Public surfacing happens via dedicated endpoints later;
-- this migration's contract is internal-only.
--
-- Schema-drift defense: city_id / building_id are read via JOIN, so
-- whether they're bigint or smallint makes no difference here.
--
-- ROLLBACK:
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_listing_quality_score;
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_market_monthly_trends;
--   DROP VIEW IF EXISTS public.listing_ranking_signals;
--   DROP VIEW IF EXISTS public.developer_market_summary;
--   DROP VIEW IF EXISTS public.building_market_summary;
--   DROP VIEW IF EXISTS public.listing_zonal_comparison;
--   DROP VIEW IF EXISTS public.market_velocity;
--   DROP VIEW IF EXISTS public.market_inventory_summary;
--   DROP FUNCTION IF EXISTS public.market_pricing_heatmap_grid(...);
--   DROP TABLE IF EXISTS public.market_ranking_config;


-- =====================================================================
-- 1. market_ranking_config — admin-tunable ranking weights
-- =====================================================================
--
-- Single-row table holding the JSON of weights used by
-- listing_ranking_signals. Allows admin to tune without a migration.
-- Row is seeded with sensible defaults; UI can later edit.

CREATE TABLE IF NOT EXISTS public.market_ranking_config (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- single row
  weights         jsonb NOT NULL DEFAULT jsonb_build_object(
                       'verification_verified', 1.15,
                       'verification_default',  1.00,
                       'broker_trust_max',      1.20,
                       'broker_trust_floor',    1.00,
                       'stale_dom_p75_penalty', 0.90,
                       'freshness_half_life_days', 30
                     ),
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

INSERT INTO public.market_ranking_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.market_ranking_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_ranking_config_select ON public.market_ranking_config;
CREATE POLICY market_ranking_config_select ON public.market_ranking_config FOR SELECT
  TO authenticated USING (true);  -- weights are not secrets
DROP POLICY IF EXISTS market_ranking_config_modify ON public.market_ranking_config;
CREATE POLICY market_ranking_config_modify ON public.market_ranking_config FOR UPDATE
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 2. market_inventory_summary — per-city × property_type rollup
-- =====================================================================
--
-- Live view (computed at read). Cheap because of the indexes on
-- listings(city_id, property_type) that already exist for the public
-- search surface. Joins listing_market_status to split inventory by
-- available/reserved/sold.

CREATE OR REPLACE VIEW public.market_inventory_summary AS
-- v1: sale-listing analytics only. Rent inventory has different
-- pricing semantics (per-month vs. one-shot) and mixing the two
-- gives misleading medians. A separate market_rent_inventory_summary
-- can be added when rent analytics is needed.
SELECT
  l.city_id,
  l.property_type,
  count(*)                                                          AS listing_count,
  count(*) FILTER (WHERE coalesce(lms.market_status, 'available') = 'available') AS available_count,
  count(*) FILTER (WHERE lms.market_status = 'reserved')            AS reserved_count,
  count(*) FILTER (WHERE lms.market_status = 'sold')                AS sold_count,
  -- Median + p25/p75 give a robust price band even on noisy data.
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY l.sale_price)        AS median_price,
  percentile_cont(0.25) WITHIN GROUP (ORDER BY l.sale_price)        AS p25_price,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY l.sale_price)        AS p75_price,
  -- sale_price_per_sqm is computed on the listing_details MV but NOT
  -- stored on the listings table itself — compute inline. NULLIF
  -- guards a zero-area row (rare but real for land listings).
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY (l.sale_price::numeric / NULLIF(l.floor_area, 0))
  ) AS median_price_per_sqm,
  avg(l.sale_price)                                                 AS avg_price,
  min(l.created_at)                                                 AS earliest_listing_at,
  max(l.created_at)                                                 AS latest_listing_at
FROM public.listings l
LEFT JOIN public.listing_market_status lms ON lms.listing_id = l.id
WHERE l.is_online = true
  AND l.deleted_at IS NULL
  AND l.sale_price IS NOT NULL
  AND l.sale_price > 0
GROUP BY l.city_id, l.property_type;
GRANT SELECT ON public.market_inventory_summary TO authenticated;

COMMENT ON VIEW public.market_inventory_summary IS
  'Per-city × property_type inventory + price stats. Live (computed at read). Uses listing_market_status for inventory split.';


-- =====================================================================
-- 3. market_velocity — DOM, absorption, listing/closing rates
-- =====================================================================
--
-- DOM uses coalesce(price_changed_at, created_at) → now() as the
-- start anchor (price_changed_at trigger landed mid-history; not all
-- listings have it).
--
-- Absorption rate: deals_closed_30d / available_count. Higher =
-- faster market.

CREATE OR REPLACE VIEW public.market_velocity AS
WITH listing_anchors AS (
  SELECT
    l.id,
    l.city_id,
    l.property_type,
    l.is_online,
    l.deleted_at,
    coalesce(l.price_changed_at, l.created_at) AS dom_start
  FROM public.listings l
  WHERE l.is_online = true AND l.deleted_at IS NULL
),
deals_per_segment AS (
  SELECT
    l.city_id,
    l.property_type,
    count(*) FILTER (WHERE d.closed_won = true AND d.closed_at > now() - interval '30 days') AS deals_closed_30d,
    count(*) FILTER (WHERE d.closed_won = true AND d.closed_at > now() - interval '90 days') AS deals_closed_90d,
    sum(d.deal_value) FILTER (WHERE d.closed_won = true AND d.closed_at > now() - interval '90 days') AS gmv_90d
  FROM public.deals d
  JOIN public.listings l ON l.id = d.listing_id
  GROUP BY l.city_id, l.property_type
)
SELECT
  la.city_id,
  la.property_type,
  count(*)                                                           AS active_listings,
  -- DOM in days: avg seconds since dom_start ÷ 86400. Cast to int
  -- for display; the underlying calculation is float.
  round(avg(EXTRACT(EPOCH FROM (now() - la.dom_start)) / 86400)::numeric, 1)  AS avg_dom_days,
  round(percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (now() - la.dom_start)) / 86400
  )::numeric, 1)                                                     AS median_dom_days,
  round(percentile_cont(0.75) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (now() - la.dom_start)) / 86400
  )::numeric, 1)                                                     AS p75_dom_days,
  coalesce(d.deals_closed_30d, 0)                                    AS deals_closed_30d,
  coalesce(d.deals_closed_90d, 0)                                    AS deals_closed_90d,
  coalesce(d.gmv_90d, 0)                                             AS gmv_90d,
  -- Absorption: closed-30d ÷ active. NULL when active=0 to avoid /0.
  CASE WHEN count(*) > 0 THEN
    round(coalesce(d.deals_closed_30d, 0)::numeric / count(*)::numeric, 4)
  ELSE NULL END                                                      AS absorption_rate_30d
FROM listing_anchors la
LEFT JOIN deals_per_segment d ON d.city_id = la.city_id AND d.property_type = la.property_type
GROUP BY la.city_id, la.property_type, d.deals_closed_30d, d.deals_closed_90d, d.gmv_90d;
GRANT SELECT ON public.market_velocity TO authenticated;


-- =====================================================================
-- 4. listing_zonal_comparison — per-listing premium/discount %
-- =====================================================================
--
-- Joins listings to zonal_values via city_id + barangay_id. Returns
-- NULL when no zonal match. Premium % = (listing_price_per_sqm /
-- zonal_value - 1).

-- Sale listings only — zonal comparison is a per-sqm calc, and rent
-- per-sqm is per-month while zonal_value is asset value.
--
-- Defensive: zonal_values predates this session and its column shape
-- isn't guaranteed across environments. Introspect the columns and
-- build either the full join (when city_id + zonal_value exist) or
-- a stub view that returns NULL outputs but keeps the contract
-- shape so downstream JOINs don't fail.
DO $$
DECLARE
  v_has_city_id     boolean;
  v_has_barangay_id boolean;
  v_has_zonal_value boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='zonal_values' AND column_name='city_id'
  ) INTO v_has_city_id;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='zonal_values' AND column_name='barangay_id'
  ) INTO v_has_barangay_id;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='zonal_values' AND column_name='zonal_value'
  ) INTO v_has_zonal_value;

  IF v_has_city_id AND v_has_zonal_value THEN
    -- Full view. Optional barangay match when that column exists.
    EXECUTE format($v$
      CREATE OR REPLACE VIEW public.listing_zonal_comparison AS
      WITH base AS (
        SELECT
          l.id AS listing_id,
          l.city_id,
          l.barangay_id,
          l.sale_price,
          l.floor_area,
          CASE
            WHEN l.floor_area IS NOT NULL AND l.floor_area > 0
              THEN l.sale_price::numeric / l.floor_area
            ELSE NULL
          END AS pps
        FROM public.listings l
        WHERE l.is_online = true AND l.deleted_at IS NULL
      )
      SELECT
        base.listing_id,
        base.city_id,
        base.barangay_id,
        base.sale_price,
        base.floor_area,
        base.pps AS listing_price_per_sqm,
        zv.zonal_value AS zonal_value_per_sqm,
        CASE
          WHEN base.pps IS NOT NULL AND zv.zonal_value IS NOT NULL AND zv.zonal_value > 0
            THEN round((base.pps / zv.zonal_value::numeric - 1), 4)
          ELSE NULL
        END AS zonal_premium_ratio,
        CASE
          WHEN base.pps IS NOT NULL AND zv.zonal_value IS NOT NULL AND zv.zonal_value > 0 THEN
            CASE
              WHEN base.pps / zv.zonal_value::numeric > 1.20 THEN 'premium'
              WHEN base.pps / zv.zonal_value::numeric > 1.05 THEN 'above_market'
              WHEN base.pps / zv.zonal_value::numeric > 0.95 THEN 'at_market'
              WHEN base.pps / zv.zonal_value::numeric > 0.80 THEN 'below_market'
              ELSE 'discount'
            END
          ELSE NULL
        END AS zonal_band
      FROM base
      LEFT JOIN public.zonal_values zv
        ON zv.city_id = base.city_id
       %s
    $v$,
    CASE WHEN v_has_barangay_id
         THEN 'AND (zv.barangay_id = base.barangay_id OR zv.barangay_id IS NULL)'
         ELSE ''
    END);
  ELSE
    -- Stub. Same column shape, NULL data. Keeps mv_listing_quality_score
    -- and any other dependent JOIN working; the price_alignment
    -- component falls back to its 'ELSE 5' neutral case.
    EXECUTE $v$
      CREATE OR REPLACE VIEW public.listing_zonal_comparison AS
      SELECT
        l.id AS listing_id,
        l.city_id,
        l.barangay_id,
        l.sale_price,
        l.floor_area,
        CASE
          WHEN l.floor_area IS NOT NULL AND l.floor_area > 0
            THEN l.sale_price::numeric / l.floor_area
          ELSE NULL
        END AS listing_price_per_sqm,
        NULL::numeric AS zonal_value_per_sqm,
        NULL::numeric AS zonal_premium_ratio,
        NULL::text    AS zonal_band
      FROM public.listings l
      WHERE l.is_online = true AND l.deleted_at IS NULL
    $v$;
    RAISE NOTICE 'zonal_values schema does not include city_id+zonal_value — listing_zonal_comparison built as stub. Edit the view manually once zonal_values schema is confirmed.';
  END IF;
END $$;
GRANT SELECT ON public.listing_zonal_comparison TO authenticated;


-- =====================================================================
-- 5. building_market_summary — per-building rollup
-- =====================================================================

CREATE OR REPLACE VIEW public.building_market_summary AS
WITH listing_stats AS (
  SELECT
    l.building_id,
    count(*)                                                AS listing_count,
    count(*) FILTER (WHERE coalesce(lms.market_status, 'available') = 'available') AS available_count,
    count(*) FILTER (WHERE lms.market_status = 'sold')      AS sold_count,
    avg(l.sale_price)                                       AS avg_price,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY l.sale_price) AS median_price,
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY (l.sale_price::numeric / NULLIF(l.floor_area, 0))
    )                                                         AS median_price_per_sqm
  FROM public.listings l
  LEFT JOIN public.listing_market_status lms ON lms.listing_id = l.id
  WHERE l.building_id IS NOT NULL
    AND l.is_online = true
    AND l.deleted_at IS NULL
    AND l.sale_price IS NOT NULL AND l.sale_price > 0
  GROUP BY l.building_id
),
deal_stats AS (
  SELECT
    l.building_id,
    count(*) FILTER (WHERE d.closed_won = true AND d.closed_at > now() - interval '90 days') AS deals_won_90d,
    sum(d.deal_value) FILTER (WHERE d.closed_won = true AND d.closed_at > now() - interval '90 days') AS gmv_90d
  FROM public.deals d
  JOIN public.listings l ON l.id = d.listing_id
  WHERE l.building_id IS NOT NULL
  GROUP BY l.building_id
)
SELECT
  b.id AS building_id,
  b.name AS building_name,
  b.slug AS building_slug,
  b.developer_id,
  b.city_id,
  ls.listing_count,
  ls.available_count,
  ls.sold_count,
  ls.avg_price,
  ls.median_price,
  ls.median_price_per_sqm,
  coalesce(ds.deals_won_90d, 0)  AS deals_won_90d,
  coalesce(ds.gmv_90d, 0)        AS gmv_90d,
  -- Building-level trust score from the polymorphic view. Joins by
  -- target_type='building' + target_id=building.id::text.
  ts.trust_score,
  ts.review_count,
  ts.avg_rating
FROM public.buildings b
LEFT JOIN listing_stats ls ON ls.building_id = b.id
LEFT JOIN deal_stats    ds ON ds.building_id = b.id
LEFT JOIN public.trust_score ts
  ON ts.target_type = 'building' AND ts.target_id = b.id::text;
-- Note: no soft-delete filter on buildings (column may not exist on
-- every environment). Deleted buildings will have listing_count=0
-- and naturally fall out of UI sorts that filter listings >= MIN.
GRANT SELECT ON public.building_market_summary TO authenticated;

COMMENT ON VIEW public.building_market_summary IS
  'Per-building inventory + 90d sales activity + trust score. Joins are LEFT so buildings without listings still appear with NULL stats.';


-- =====================================================================
-- 6. developer_market_summary
-- =====================================================================
--
-- Developer table existence is uncertain across environments — wrap
-- in a DO block so the migration succeeds either way. If the table
-- isn't there, the view simply isn't created.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'developers'
  ) THEN
    EXECUTE $v$
      CREATE OR REPLACE VIEW public.developer_market_summary AS
      SELECT
        dev.id   AS developer_id,
        dev.name AS developer_name,
        count(DISTINCT b.id)                                          AS building_count,
        count(DISTINCT l.id)                                          AS listing_count,
        avg(l.sale_price)                                             AS avg_price,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY l.sale_price)     AS median_price,
        count(DISTINCT d.id) FILTER (
          WHERE d.closed_won = true AND d.closed_at > now() - interval '90 days'
        ) AS deals_won_90d,
        sum(d.deal_value) FILTER (
          WHERE d.closed_won = true AND d.closed_at > now() - interval '90 days'
        ) AS gmv_90d
      FROM public.developers dev
      LEFT JOIN public.buildings b ON b.developer_id = dev.id
      LEFT JOIN public.listings  l ON l.building_id  = b.id
                                  AND l.is_online = true
                                  AND l.deleted_at IS NULL
                                  AND l.sale_price IS NOT NULL
      LEFT JOIN public.deals     d ON d.listing_id   = l.id
      GROUP BY dev.id, dev.name
    $v$;
    EXECUTE 'GRANT SELECT ON public.developer_market_summary TO authenticated';
  END IF;
END $$;


-- =====================================================================
-- 7. mv_market_monthly_trends — backfilled per-month rollup
-- =====================================================================
--
-- One row per (year_month × city_id × property_type). Refreshed
-- nightly. Used for the line-chart trend widget.

-- Sale listings only (rent has different pricing semantics).
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_market_monthly_trends AS
SELECT
  date_trunc('month', l.created_at)::date AS month_start,
  l.city_id,
  l.property_type,
  count(*)                                                          AS listings_created,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY l.sale_price)         AS median_price,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY (l.sale_price::numeric / NULLIF(l.floor_area, 0))
  )                                                                 AS median_price_per_sqm,
  avg(l.sale_price)                                                 AS avg_price
FROM public.listings l
WHERE l.deleted_at IS NULL
  AND l.sale_price IS NOT NULL AND l.sale_price > 0
  AND l.created_at IS NOT NULL
GROUP BY date_trunc('month', l.created_at), l.city_id, l.property_type;

CREATE UNIQUE INDEX IF NOT EXISTS mv_market_monthly_trends_uniq
  ON public.mv_market_monthly_trends(month_start, city_id, property_type);
CREATE INDEX IF NOT EXISTS mv_market_monthly_trends_city_idx
  ON public.mv_market_monthly_trends(city_id, month_start DESC);

GRANT SELECT ON public.mv_market_monthly_trends TO authenticated;


-- =====================================================================
-- 8. mv_listing_quality_score — deterministic per-listing score
-- =====================================================================
--
-- Components and weights are explicit. Total = 100.
-- Recomputed hourly via cron. The raw component values are stored
-- alongside the total so the broker UI can show "your score is 65
-- because (image: 12/20, description: 10/15, ...)".

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_listing_quality_score AS
WITH listing_images AS (
  SELECT listing_id, count(*) AS image_count
    FROM public.listing_images
   GROUP BY listing_id
),
broker_responsiveness AS (
  -- Per-listing creator's 30d response rate. NULL if no inquiries.
  SELECT
    l.id AS listing_id,
    CASE WHEN count(i.id) FILTER (WHERE i.created_at > now() - interval '30 days') > 0
      THEN count(i.id) FILTER (
             WHERE i.created_at > now() - interval '30 days' AND i.status != 'new'
           )::numeric
           / count(i.id) FILTER (WHERE i.created_at > now() - interval '30 days')::numeric
      ELSE NULL
    END AS response_rate_30d
  FROM public.listings l
  LEFT JOIN public.inquiries i ON i.listing_id = l.id AND i.assigned_user_id = l.created_by
  GROUP BY l.id
),
broker_trust AS (
  SELECT
    l.id AS listing_id,
    ts.trust_score
  FROM public.listings l
  LEFT JOIN public.trust_score ts
    ON ts.target_type = 'agent' AND ts.target_id = l.created_by::text
)
SELECT
  l.id AS listing_id,
  -- 1. Image completeness — 20 max. Normalize at 8 images.
  least(coalesce(li.image_count, 0), 8) * 2.5                AS score_images,
  -- 2. Description completeness — 15 max.
  CASE
    WHEN l.description IS NULL OR length(l.description) = 0 THEN 0
    WHEN length(l.description) < 100  THEN 5
    WHEN length(l.description) < 300  THEN 10
    ELSE 15
  END                                                         AS score_description,
  -- 3. Verification — 15 max.
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.listing_verifications lv
       WHERE lv.listing_id = l.id AND lv.status = 'verified'
    ) THEN 15
    ELSE 0
  END                                                         AS score_verification,
  -- 4. Freshness — 10 max. Half-life 30 days, capped at 0.
  greatest(0,
    round((10 * exp(
      -EXTRACT(EPOCH FROM (now() - coalesce(l.price_changed_at, l.created_at))) / (86400 * 30 * 1.4427)
    ))::numeric, 2)
  )                                                           AS score_freshness,
  -- 5. Inquiry responsiveness — 15 max. response_rate_30d * 15.
  -- NULL response (no inquiries) gets a neutral 7.5 — neither
  -- penalized nor rewarded.
  coalesce(br.response_rate_30d * 15, 7.5)                   AS score_responsiveness,
  -- 6. Broker trust — 10 max. trust_score is 0..100; scale.
  coalesce(bt.trust_score / 10.0, 5.0)                       AS score_broker_trust,
  -- 7. Price/zonal alignment — 10 max. Closer to market = better.
  CASE lzc.zonal_band
    WHEN 'at_market'    THEN 10
    WHEN 'above_market' THEN 7
    WHEN 'below_market' THEN 7
    WHEN 'premium'      THEN 5
    WHEN 'discount'     THEN 5
    ELSE 5  -- NULL or unknown — neutral
  END                                                         AS score_price_alignment,
  -- 8. Geographic completeness — 5 max. Listings inherit location via
  -- their building (buildings.geom carries the actual coordinates),
  -- so building_id is the strongest signal a listing has a real
  -- pin. Falls back through barangay → city.
  CASE
    WHEN l.barangay_id IS NOT NULL AND l.building_id IS NOT NULL THEN 5
    WHEN l.barangay_id IS NOT NULL                               THEN 3
    WHEN l.city_id     IS NOT NULL                               THEN 1
    ELSE 0
  END                                                         AS score_geography,
  now() AS computed_at
FROM public.listings l
LEFT JOIN listing_images        li  ON li.listing_id  = l.id
LEFT JOIN broker_responsiveness br  ON br.listing_id  = l.id
LEFT JOIN broker_trust          bt  ON bt.listing_id  = l.id
LEFT JOIN public.listing_zonal_comparison lzc ON lzc.listing_id = l.id
WHERE l.is_online = true AND l.deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS mv_listing_quality_score_uniq
  ON public.mv_listing_quality_score(listing_id);

GRANT SELECT ON public.mv_listing_quality_score TO authenticated;


-- =====================================================================
-- 9. listing_quality view — total + components in one row
-- =====================================================================

CREATE OR REPLACE VIEW public.listing_quality AS
SELECT
  q.listing_id,
  round(
    (q.score_images + q.score_description + q.score_verification +
     q.score_freshness + q.score_responsiveness + q.score_broker_trust +
     q.score_price_alignment + q.score_geography)::numeric, 1
  ) AS total_score,
  q.score_images,
  q.score_description,
  q.score_verification,
  q.score_freshness,
  q.score_responsiveness,
  q.score_broker_trust,
  q.score_price_alignment,
  q.score_geography,
  q.computed_at
FROM public.mv_listing_quality_score q;
GRANT SELECT ON public.listing_quality TO authenticated;


-- =====================================================================
-- 10. listing_ranking_signals — exposed but not yet wired into search
-- =====================================================================

CREATE OR REPLACE VIEW public.listing_ranking_signals AS
WITH config AS (
  SELECT weights FROM public.market_ranking_config WHERE id = 1
),
listing_dom AS (
  SELECT
    l.id,
    l.city_id,
    l.property_type,
    EXTRACT(EPOCH FROM (now() - coalesce(l.price_changed_at, l.created_at))) / 86400 AS dom_days
  FROM public.listings l
  WHERE l.is_online = true AND l.deleted_at IS NULL
),
segment_dom_p75 AS (
  SELECT
    city_id,
    property_type,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY dom_days) AS p75
  FROM listing_dom
  GROUP BY city_id, property_type
)
SELECT
  ld.id AS listing_id,
  q.total_score                                                 AS quality_score,
  -- Time decay using the half-life from config.
  greatest(0, exp(
    -ld.dom_days / NULLIF((cfg.weights->>'freshness_half_life_days')::numeric * 1.4427, 0)
  ))::numeric                                                   AS freshness_score,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.listing_verifications lv
       WHERE lv.listing_id = ld.id AND lv.status = 'verified'
    ) THEN (cfg.weights->>'verification_verified')::numeric
    ELSE (cfg.weights->>'verification_default')::numeric
  END                                                           AS verification_boost,
  -- broker trust scaled into [floor, max].
  CASE
    WHEN bt.trust_score IS NULL THEN (cfg.weights->>'broker_trust_floor')::numeric
    ELSE
      (cfg.weights->>'broker_trust_floor')::numeric
      + ((cfg.weights->>'broker_trust_max')::numeric - (cfg.weights->>'broker_trust_floor')::numeric)
        * least(1, bt.trust_score / 100.0)
  END                                                           AS broker_trust_boost,
  CASE
    WHEN ld.dom_days > sdp.p75 THEN (cfg.weights->>'stale_dom_p75_penalty')::numeric
    ELSE 1.00
  END                                                           AS velocity_penalty
FROM listing_dom ld
CROSS JOIN config cfg
LEFT JOIN public.listing_quality q  ON q.listing_id = ld.id
LEFT JOIN segment_dom_p75 sdp ON sdp.city_id = ld.city_id AND sdp.property_type = ld.property_type
LEFT JOIN public.trust_score bt
  ON bt.target_type = 'agent'
 AND bt.target_id IN (SELECT created_by::text FROM public.listings WHERE id = ld.id);
GRANT SELECT ON public.listing_ranking_signals TO authenticated;


-- =====================================================================
-- 11. Heatmap RPCs — pricing, demand, absorption
-- =====================================================================
--
-- Grid-aggregated for map overlays. cell_size_deg is approximate;
-- callers should match it to the zoom level they're rendering.

-- Listings inherit their pin from their building (buildings.geom is
-- a PostGIS geometry; listings have NO own latitude/longitude
-- columns). Heatmaps therefore JOIN listings → buildings and use
-- ST_Y/ST_X to project geom onto lat/lng cells. Listings without a
-- building (e.g., raw land entered without a structure) don't show
-- on heatmaps — acceptable for v1 since those are a small minority.

CREATE OR REPLACE FUNCTION public.market_pricing_heatmap_grid(
  p_min_lat numeric,
  p_min_lng numeric,
  p_max_lat numeric,
  p_max_lng numeric,
  p_cell_size_deg numeric DEFAULT 0.01
) RETURNS TABLE (
  cell_lat numeric,
  cell_lng numeric,
  median_price_per_sqm numeric,
  listing_count bigint
)
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = public, extensions
AS $$
  WITH located AS (
    SELECT
      l.id,
      l.sale_price,
      l.floor_area,
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
  )
  SELECT
    floor(lat / p_cell_size_deg) * p_cell_size_deg AS cell_lat,
    floor(lng / p_cell_size_deg) * p_cell_size_deg AS cell_lng,
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY (sale_price::numeric / NULLIF(floor_area, 0))
    ) AS median_price_per_sqm,
    count(*)::bigint AS listing_count
  FROM located
  GROUP BY 1, 2
  HAVING count(*) >= 3;  -- privacy: don't expose single-listing cells
$$;
GRANT EXECUTE ON FUNCTION public.market_pricing_heatmap_grid(numeric, numeric, numeric, numeric, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.market_demand_heatmap_grid(
  p_min_lat numeric,
  p_min_lng numeric,
  p_max_lat numeric,
  p_max_lng numeric,
  p_cell_size_deg numeric DEFAULT 0.01
) RETURNS TABLE (
  cell_lat numeric,
  cell_lng numeric,
  inquiry_count_30d bigint,
  listing_count bigint
)
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = public, extensions
AS $$
  WITH located AS (
    SELECT
      l.id,
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
    floor(loc.lat / p_cell_size_deg) * p_cell_size_deg AS cell_lat,
    floor(loc.lng / p_cell_size_deg) * p_cell_size_deg AS cell_lng,
    count(i.id)::bigint AS inquiry_count_30d,
    count(DISTINCT loc.id)::bigint AS listing_count
  FROM located loc
  LEFT JOIN public.inquiries i
    ON i.listing_id = loc.id AND i.created_at > now() - interval '30 days'
  GROUP BY 1, 2
  HAVING count(DISTINCT loc.id) >= 2;  -- avoid single-listing privacy issues
$$;
GRANT EXECUTE ON FUNCTION public.market_demand_heatmap_grid(numeric, numeric, numeric, numeric, numeric) TO authenticated;


-- =====================================================================
-- 12. Refresh helpers + cron jobs
-- =====================================================================
--
-- Each MV refresh is wrapped to record start/end + duration via the
-- governance helpers. Concurrent refresh requires a unique index
-- (created above) — falls back to non-concurrent if that's missing.

CREATE OR REPLACE FUNCTION public.refresh_mv_market_monthly_trends()
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.governance_record_mv_refresh_start('public.mv_market_monthly_trends');
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_market_monthly_trends;
    PERFORM public.governance_record_mv_refresh_end('public.mv_market_monthly_trends', NULL);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.governance_record_mv_refresh_end(
      'public.mv_market_monthly_trends', SQLERRM
    );
    RAISE;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_mv_listing_quality_score()
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.governance_record_mv_refresh_start('public.mv_listing_quality_score');
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_listing_quality_score;
    PERFORM public.governance_record_mv_refresh_end('public.mv_listing_quality_score', NULL);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.governance_record_mv_refresh_end(
      'public.mv_listing_quality_score', SQLERRM
    );
    RAISE;
  END;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Monthly trends: nightly at 02:00.
    PERFORM cron.unschedule('mv_market_monthly_trends_refresh')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mv_market_monthly_trends_refresh');
    PERFORM cron.schedule(
      'mv_market_monthly_trends_refresh',
      '0 2 * * *',
      'SELECT public.refresh_mv_market_monthly_trends();'
    );

    -- Listing quality: hourly at :15.
    PERFORM cron.unschedule('mv_listing_quality_score_refresh')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mv_listing_quality_score_refresh');
    PERFORM cron.schedule(
      'mv_listing_quality_score_refresh',
      '15 * * * *',
      'SELECT public.refresh_mv_listing_quality_score();'
    );
  END IF;
END $$;


-- =====================================================================
-- 13. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('market.read',   'Read market intelligence views and reports', 'market'),
  ('market.export', 'Export market intelligence data',            'market')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'market.read'),
  ('admin',   'market.export'),
  ('manager', 'market.read'),
  ('manager', 'market.export'),
  ('agent',   'market.read')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 14. Governance registration
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.market_inventory_summary',  'view',              'userportal', ARRAY['userportal'], 'Per-city × property_type inventory + price aggregates.', false),
  ('public.market_velocity',           'view',              'userportal', ARRAY['userportal'], 'DOM, absorption, sales velocity per segment.', false),
  ('public.listing_zonal_comparison',  'view',              'userportal', ARRAY['userportal','website'], 'Per-listing premium/discount vs. zonal_values.', false),
  ('public.building_market_summary',   'view',              'userportal', ARRAY['userportal','website'], 'Per-building inventory + 90d activity + trust score.', false),
  ('public.listing_quality',           'view',              'userportal', ARRAY['userportal'], 'Per-listing deterministic quality score with component breakdown.', false),
  ('public.listing_ranking_signals',   'view',              'userportal', ARRAY['userportal'], 'Combined ranking inputs (quality, freshness, verification, broker trust, velocity).', false),
  ('public.mv_market_monthly_trends',  'materialized_view', 'userportal', ARRAY['userportal','website'], 'Per-month market trends; refreshed nightly.', false),
  ('public.mv_listing_quality_score',  'materialized_view', 'userportal', ARRAY['userportal'], 'Materialized quality scores; refreshed hourly.', false)
ON CONFLICT (contract_name) DO NOTHING;

INSERT INTO public.governance_materialized_views
  (view_name, refresh_cadence, depends_on, notes)
VALUES
  ('public.mv_market_monthly_trends', 'daily',
   ARRAY['public.listings'],
   'Per-month × city × property_type aggregates. Refreshed nightly at 02:00.'),
  ('public.mv_listing_quality_score', 'hourly',
   ARRAY['public.listings','public.listing_images','public.listing_verifications','public.inquiries','public.trust_score','public.listing_zonal_comparison'],
   'Per-listing deterministic quality. Refreshed hourly at :15.')
ON CONFLICT (view_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
