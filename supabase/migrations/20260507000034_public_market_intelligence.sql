-- Public Market Intelligence — anon-callable RPCs for SEO surfaces.
--
-- Wraps existing private aggregates (market_inventory_summary,
-- market_velocity, market_hot_areas, building_market_summary,
-- mv_market_monthly_trends) in SECURITY DEFINER RPCs that enforce
-- sparse-data suppression. The website renders /market/<city> and
-- /market/<city>/<barangay> from these.
--
-- Sparse-data rules:
--   - City: requires ≥10 listings to expose aggregates
--   - Barangay: requires ≥5 listings
-- Below threshold the RPC returns { sufficient_data: false }, which
-- the website renders as noindex (avoiding thin-page SEO penalty).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.public_market_index();
--   DROP FUNCTION IF EXISTS public.public_barangay_market_snapshot(text, text);
--   DROP FUNCTION IF EXISTS public.public_city_market_snapshot(text);


-- =====================================================================
-- 1. public_city_market_snapshot(p_slug)
-- =====================================================================
--
-- One round-trip aggregate for /market/<city>. Returns:
--   {
--     "city": { id, name, slug },
--     "sufficient_data": bool,
--     "inventory": { listing_count, available_count, sold_count },
--     "median_price", "median_price_per_sqm",
--     "median_dom_days", "absorption_rate_30d",
--     "top_buildings": [...],   -- min 5 listings each
--     "hot_barangays": [...],   -- top 5 by hot_score
--     "trends": [...]           -- last 12 months from mv_market_monthly_trends
--   }
--
-- SECURITY DEFINER so anon callers can read across the underlying
-- private views without RLS getting in the way.

CREATE OR REPLACE FUNCTION public.public_city_market_snapshot(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public STABLE
AS $$
DECLARE
  v_city          record;
  v_listing_count int;
  v_inventory     jsonb;
  v_velocity      record;
  v_top_buildings jsonb;
  v_hot_barangays jsonb;
  v_trends        jsonb;
BEGIN
  -- Resolve the city by slug. cities is anon-readable so this is
  -- idiomatic; we wrap it here so the caller doesn't need to do
  -- a separate lookup before reading the snapshot.
  SELECT id, name, slug INTO v_city
    FROM public.cities
   WHERE slug = p_slug
   LIMIT 1;

  IF v_city.id IS NULL THEN
    RETURN jsonb_build_object(
      'city', NULL,
      'sufficient_data', false,
      'reason', 'city_not_found'
    );
  END IF;

  -- Total active listings in the city. The threshold gate.
  SELECT count(*)::int INTO v_listing_count
    FROM public.listings l
   WHERE l.city_id = v_city.id
     AND l.is_online = true
     AND l.deleted_at IS NULL;

  IF v_listing_count < 10 THEN
    RETURN jsonb_build_object(
      'city', jsonb_build_object('id', v_city.id, 'name', v_city.name, 'slug', v_city.slug),
      'sufficient_data', false,
      'listing_count', v_listing_count,
      'reason', 'insufficient_listings'
    );
  END IF;

  -- Inventory summary, aggregated across property types for the city.
  SELECT jsonb_build_object(
    'listing_count',  sum(listing_count),
    'available_count', sum(available_count),
    'reserved_count',  sum(reserved_count),
    'sold_count',      sum(sold_count),
    'median_price',           round(avg(median_price)::numeric, 0),
    'median_price_per_sqm',   round(avg(median_price_per_sqm)::numeric, 0)
  ) INTO v_inventory
  FROM public.market_inventory_summary
  WHERE city_id = v_city.id;

  -- Velocity (DOM + absorption). Aggregate across property types.
  SELECT
    avg(median_dom_days)         AS median_dom_days,
    avg(absorption_rate_30d)     AS absorption_rate_30d,
    sum(deals_closed_30d)        AS deals_closed_30d,
    sum(gmv_90d)                 AS gmv_90d
  INTO v_velocity
  FROM public.market_velocity
  WHERE city_id = v_city.id;

  -- Top 8 buildings by listing count in this city. Already sparse-
  -- gated by building_market_summary.
  SELECT coalesce(jsonb_agg(b ORDER BY b.listing_count DESC), '[]'::jsonb)
    INTO v_top_buildings
    FROM (
      SELECT
        building_id, building_name, building_slug,
        listing_count, median_price, median_price_per_sqm,
        deals_won_90d, trust_score
      FROM public.building_market_summary
      WHERE city_id = v_city.id
        AND listing_count >= 5
      ORDER BY listing_count DESC
      LIMIT 8
    ) b;

  -- Top hot barangays in this city. Hot-area RPC already enforces
  -- ≥5 listings per barangay.
  SELECT coalesce(jsonb_agg(h ORDER BY h.hot_score DESC), '[]'::jsonb)
    INTO v_hot_barangays
    FROM (
      SELECT
        ha.barangay_id,
        ba.name AS barangay_name,
        ba.slug AS barangay_slug,
        ha.hot_score,
        ha.inquiry_velocity_30d,
        ha.deal_velocity_30d,
        ha.median_dom_days,
        ha.listing_count
      FROM public.market_hot_areas(v_city.id, 5) ha
      LEFT JOIN public.barangays ba ON ba.id = ha.barangay_id
      WHERE ha.hot_score >= 0.0
    ) h;

  -- Last 12 months of monthly trends.
  SELECT coalesce(jsonb_agg(t ORDER BY t.month_start ASC), '[]'::jsonb)
    INTO v_trends
    FROM (
      SELECT
        month_start,
        listings_created,
        median_price,
        median_price_per_sqm
      FROM public.mv_market_monthly_trends
      WHERE city_id = v_city.id
        AND month_start >= (now() - interval '12 months')::date
      ORDER BY month_start ASC
    ) t;

  RETURN jsonb_build_object(
    'city', jsonb_build_object(
      'id',   v_city.id,
      'name', v_city.name,
      'slug', v_city.slug
    ),
    'sufficient_data', true,
    'listing_count',   v_listing_count,
    'inventory',       coalesce(v_inventory, '{}'::jsonb),
    'velocity', jsonb_build_object(
      'median_dom_days',     coalesce(round(v_velocity.median_dom_days::numeric, 1), 0),
      'absorption_rate_30d', coalesce(round(v_velocity.absorption_rate_30d::numeric, 4), 0),
      'deals_closed_30d',    coalesce(v_velocity.deals_closed_30d, 0),
      'gmv_90d',             coalesce(v_velocity.gmv_90d, 0)
    ),
    'top_buildings',  v_top_buildings,
    'hot_barangays',  v_hot_barangays,
    'trends',         v_trends,
    'evaluated_at',   now()
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.public_city_market_snapshot(text) TO anon, authenticated;


-- =====================================================================
-- 2. public_barangay_market_snapshot(p_city_slug, p_barangay_slug)
-- =====================================================================
--
-- Same shape as city, scoped to one barangay. Threshold ≥5 listings.
-- Hot-area status surfaced from market_hot_areas.

CREATE OR REPLACE FUNCTION public.public_barangay_market_snapshot(
  p_city_slug     text,
  p_barangay_slug text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public STABLE
AS $$
DECLARE
  v_city           record;
  v_barangay       record;
  v_listing_count  int;
  v_inventory      jsonb;
  v_dom            numeric;
  v_zonal_avg      numeric;
  v_top_buildings  jsonb;
  v_hot_row        record;
BEGIN
  SELECT id, name, slug INTO v_city
    FROM public.cities
   WHERE slug = p_city_slug
   LIMIT 1;

  IF v_city.id IS NULL THEN
    RETURN jsonb_build_object('sufficient_data', false, 'reason', 'city_not_found');
  END IF;

  SELECT id, name, slug INTO v_barangay
    FROM public.barangays
   WHERE slug = p_barangay_slug
     AND city_id = v_city.id
   LIMIT 1;

  IF v_barangay.id IS NULL THEN
    RETURN jsonb_build_object(
      'city', jsonb_build_object('id', v_city.id, 'name', v_city.name, 'slug', v_city.slug),
      'sufficient_data', false,
      'reason', 'barangay_not_found'
    );
  END IF;

  SELECT count(*)::int INTO v_listing_count
    FROM public.listings l
   WHERE l.barangay_id = v_barangay.id
     AND l.is_online = true
     AND l.deleted_at IS NULL;

  IF v_listing_count < 5 THEN
    RETURN jsonb_build_object(
      'city', jsonb_build_object('id', v_city.id, 'name', v_city.name, 'slug', v_city.slug),
      'barangay', jsonb_build_object('id', v_barangay.id, 'name', v_barangay.name, 'slug', v_barangay.slug),
      'sufficient_data', false,
      'listing_count', v_listing_count,
      'reason', 'insufficient_listings'
    );
  END IF;

  -- Barangay inventory + price summary. Aggregates from listings
  -- directly because market_inventory_summary is per-(city × type),
  -- not per-barangay.
  SELECT jsonb_build_object(
    'listing_count',         count(*),
    'median_price',          round(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.sale_price)::numeric, 0),
    'median_price_per_sqm',  round(percentile_cont(0.5) WITHIN GROUP (
                              ORDER BY l.sale_price::numeric / NULLIF(l.floor_area, 0)
                             )::numeric, 0)
  ) INTO v_inventory
  FROM public.listings l
  WHERE l.barangay_id = v_barangay.id
    AND l.is_online = true
    AND l.deleted_at IS NULL
    AND l.sale_price IS NOT NULL AND l.sale_price > 0;

  -- Average DOM (days on market) within the barangay.
  SELECT avg(EXTRACT(EPOCH FROM (now() - coalesce(l.price_changed_at, l.created_at))) / 86400)
    INTO v_dom
    FROM public.listings l
   WHERE l.barangay_id = v_barangay.id
     AND l.is_online = true
     AND l.deleted_at IS NULL;

  -- Average zonal premium ratio for listings in this barangay.
  SELECT avg(zonal_premium_ratio)
    INTO v_zonal_avg
    FROM public.listing_zonal_comparison
   WHERE city_id = v_city.id
     AND barangay_id = v_barangay.id
     AND zonal_premium_ratio IS NOT NULL;

  -- Hot-area row for this barangay, if it qualifies.
  SELECT
    h.hot_score, h.inquiry_velocity_30d, h.deal_velocity_30d, h.components
    INTO v_hot_row
    FROM public.market_hot_areas(v_city.id, 1000) h
   WHERE h.barangay_id = v_barangay.id
   LIMIT 1;

  -- Top buildings within this barangay (≥3 listings each).
  SELECT coalesce(jsonb_agg(b ORDER BY b.listing_count DESC), '[]'::jsonb)
    INTO v_top_buildings
    FROM (
      SELECT
        bms.building_id, bms.building_name, bms.building_slug,
        bms.listing_count, bms.median_price, bms.median_price_per_sqm,
        bms.trust_score
      FROM public.building_market_summary bms
      JOIN public.buildings b ON b.id = bms.building_id
      WHERE b.barangay_id = v_barangay.id
        AND bms.listing_count >= 3
      ORDER BY bms.listing_count DESC
      LIMIT 6
    ) b;

  RETURN jsonb_build_object(
    'city', jsonb_build_object('id', v_city.id, 'name', v_city.name, 'slug', v_city.slug),
    'barangay', jsonb_build_object('id', v_barangay.id, 'name', v_barangay.name, 'slug', v_barangay.slug),
    'sufficient_data', true,
    'listing_count',   v_listing_count,
    'inventory',       coalesce(v_inventory, '{}'::jsonb),
    'velocity', jsonb_build_object(
      'avg_dom_days',  coalesce(round(v_dom, 1), 0)
    ),
    'zonal', jsonb_build_object(
      'avg_premium_ratio', coalesce(round(v_zonal_avg, 4), 0),
      'has_zonal_data',    v_zonal_avg IS NOT NULL
    ),
    'hot', CASE
      WHEN v_hot_row IS NULL THEN jsonb_build_object('is_hot', false)
      ELSE jsonb_build_object(
        'is_hot',                v_hot_row.hot_score >= 0.5,
        'hot_score',             v_hot_row.hot_score,
        'inquiry_velocity_30d',  v_hot_row.inquiry_velocity_30d,
        'deal_velocity_30d',     v_hot_row.deal_velocity_30d,
        'components',            v_hot_row.components
      )
    END,
    'top_buildings',  v_top_buildings,
    'evaluated_at',   now()
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.public_barangay_market_snapshot(text, text) TO anon, authenticated;


-- =====================================================================
-- 3. public_market_index() — sitemap source
-- =====================================================================
--
-- Returns the list of (city_slug, barangay_slug or NULL) pairs with
-- sufficient_data=true. The website's sitemap generator consumes
-- this and emits one URL per row. Sparse routes are NOT in the
-- output, so search engines never see thin pages.

CREATE OR REPLACE FUNCTION public.public_market_index()
RETURNS TABLE (
  level         text,        -- 'city' | 'barangay'
  city_slug     text,
  barangay_slug text,        -- NULL when level='city'
  listing_count int
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public STABLE
AS $$
  -- City rows: ≥10 listings.
  SELECT
    'city'::text                 AS level,
    c.slug                       AS city_slug,
    NULL::text                   AS barangay_slug,
    count(l.id)::int             AS listing_count
  FROM public.cities c
  JOIN public.listings l ON l.city_id = c.id AND l.is_online = true AND l.deleted_at IS NULL
  GROUP BY c.id, c.slug
  HAVING count(l.id) >= 10

  UNION ALL

  -- Barangay rows: ≥5 listings.
  SELECT
    'barangay'::text             AS level,
    c.slug                       AS city_slug,
    ba.slug                      AS barangay_slug,
    count(l.id)::int             AS listing_count
  FROM public.barangays ba
  JOIN public.cities c           ON c.id = ba.city_id
  JOIN public.listings l         ON l.barangay_id = ba.id AND l.is_online = true AND l.deleted_at IS NULL
  GROUP BY c.id, c.slug, ba.id, ba.slug
  HAVING count(l.id) >= 5;
$$;
GRANT EXECUTE ON FUNCTION public.public_market_index() TO anon, authenticated;


-- =====================================================================
-- 4. Governance — register the 3 new public RPCs
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.public_city_market_snapshot',     'function', 'userportal', ARRAY['userportal','website'],
   'Anon-callable city market snapshot. Sparse-data threshold: ≥10 listings.', true),
  ('public.public_barangay_market_snapshot', 'function', 'userportal', ARRAY['userportal','website'],
   'Anon-callable barangay market snapshot. Sparse-data threshold: ≥5 listings.', true),
  ('public.public_market_index',             'function', 'userportal', ARRAY['userportal','website'],
   'Sitemap source: list of sufficient-data city/barangay routes.', true)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
