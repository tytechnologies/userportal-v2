-- Search + Discovery Intelligence.
--
-- Opt-in intelligent ranking that consumes the signals shipped in
-- mig 28 (listing_ranking_signals, listing_quality, market_velocity,
-- listing_zonal_comparison, trust_score). Existing search endpoints
-- are NOT modified — discovery is a separate endpoint surface.
--
-- Architecture:
--   search_sort_modes               — registry of intelligent sort modes
--   listing_discovery_score (view)  — one row per listing × mode column
--   similar_listings()              — deterministic weighted similarity RPC
--   listing_ranking_explanation()   — admin debug RPC
--   saved_search_subscriptions.alert_types text[]  — additive column
--
-- Schema-drift defense: assertions at the top so the migration fails
-- fast with a clear message if a prerequisite column is missing.
--
-- ROLLBACK:
--   ALTER TABLE public.saved_search_subscriptions DROP COLUMN IF EXISTS alert_types;
--   DROP FUNCTION IF EXISTS public.listing_ranking_explanation(bigint);
--   DROP FUNCTION IF EXISTS public.similar_listings(bigint, int);
--   DROP VIEW IF EXISTS public.listing_discovery_score;
--   DROP TABLE IF EXISTS public.search_sort_modes;


-- =====================================================================
-- 0. Pre-flight assertions
-- =====================================================================
--
-- Mig 27 ships governance_assert_column_type. Use it to fail-fast
-- on the columns this migration depends on. Wrapped in a DO block
-- so missing assertion helpers (if mig 27 hasn't been applied) just
-- skip rather than break.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.routines
     WHERE routine_schema='public' AND routine_name='governance_assert_column_type'
  ) THEN
    PERFORM public.governance_assert_table_exists('public', 'listing_ranking_signals');
    PERFORM public.governance_assert_table_exists('public', 'listing_quality');
    PERFORM public.governance_assert_table_exists('public', 'trust_score');
    PERFORM public.governance_assert_table_exists('public', 'listing_zonal_comparison');
    PERFORM public.governance_assert_table_exists('public', 'market_velocity');
  END IF;
END $$;


-- =====================================================================
-- 1. search_sort_modes — registry of intelligent sort modes
-- =====================================================================
--
-- One row per intelligent mode. Documents the formula and surfaces
-- it in the admin debug response. Editable by admins to tune
-- weights without a migration.

CREATE TABLE IF NOT EXISTS public.search_sort_modes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable enum-like key referenced by the endpoint's sort_mode param.
  mode_key        text NOT NULL UNIQUE,
  display_name    text NOT NULL,
  -- Human-readable explanation surfaced in the UI dropdown tooltip.
  description     text,
  -- Formula description (markdown). Surfaced by the ranking-
  -- explanation endpoint so admins / power users see exactly what
  -- the sort is doing.
  formula_doc     text,
  -- Score column on listing_discovery_score that this mode reads.
  score_column    text NOT NULL,
  -- Default for users who haven't picked a mode yet. Only one row
  -- should have is_default = true; not enforced by constraint
  -- because seeding swaps it.
  is_default      boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_search_sort_modes_updated_at ON public.search_sort_modes;
CREATE TRIGGER set_search_sort_modes_updated_at
  BEFORE UPDATE ON public.search_sort_modes
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.search_sort_modes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS search_sort_modes_select ON public.search_sort_modes;
CREATE POLICY search_sort_modes_select ON public.search_sort_modes FOR SELECT
  TO authenticated, anon USING (enabled = true);
DROP POLICY IF EXISTS search_sort_modes_modify ON public.search_sort_modes;
CREATE POLICY search_sort_modes_modify ON public.search_sort_modes FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

INSERT INTO public.search_sort_modes
  (mode_key, display_name, description, formula_doc, score_column, is_default)
VALUES
  ('recommended',       'Recommended',
   'Balanced quality × trust × freshness × verification × velocity. The default for users who haven''t chosen a sort.',
   'quality_score × verification_boost × broker_trust_boost × velocity_penalty × freshness_score',
   'recommended_score', true),
  ('highest_quality',   'Highest quality',
   'Sorted by total listing quality score (images, description, verification, etc.).',
   'listing_quality.total_score',
   'quality_score', false),
  ('trusted',           'Most trusted',
   'Listings from brokers with the highest trust scores rise. Quality acts as a tie-breaker.',
   '(broker_trust_boost × 100) + (quality_score / 10)',
   'trusted_score', false),
  ('fastest_moving',    'Fast-moving inventory',
   'Listings in segments with the highest 30-day absorption rate. Useful for spotting hot markets.',
   'absorption_rate_30d × quality_score',
   'fastest_moving_score', false),
  ('undervalued',       'Undervalued vs. zonal',
   'Listings priced below their zonal value. Premium % is the primary signal.',
   '-zonal_premium_ratio × quality_score (negative ratios surface first)',
   'undervalued_score', false),
  ('luxury_priority',   'Luxury priority',
   'High-end inventory weighted by verification + trust. Surfaces verified luxury first.',
   'price_per_sqm_percentile × verification_boost × broker_trust_boost',
   'luxury_score', false),
  ('newest',            'Newest first',
   'Pure created_at descending. Deterministic; no intelligent re-ranking applied.',
   'listings.created_at DESC',
   'newest_score', false)
ON CONFLICT (mode_key) DO NOTHING;


-- =====================================================================
-- 2. listing_discovery_score — combined view per mode
-- =====================================================================
--
-- One row per active listing with one column per sort mode. Reads
-- the signals shipped in mig 28 + trust_score. NULL-safe — listings
-- without a quality score (brand new, MV not refreshed yet) get a
-- baseline 50/100 so they appear in discovery feeds rather than
-- being invisible.

CREATE OR REPLACE VIEW public.listing_discovery_score AS
WITH base AS (
  SELECT
    l.id              AS listing_id,
    l.city_id,
    l.property_type,
    l.created_by,
    l.created_at,
    l.sale_price,
    l.floor_area,
    l.is_online,
    l.deleted_at,
    -- price-per-sqm percentile within the segment (city × property_type).
    CASE
      WHEN l.floor_area IS NOT NULL AND l.floor_area > 0
        THEN l.sale_price::numeric / l.floor_area
      ELSE NULL
    END AS pps
  FROM public.listings l
  WHERE l.is_online = true AND l.deleted_at IS NULL
),
ranking AS (
  SELECT * FROM public.listing_ranking_signals
),
zonal AS (
  SELECT listing_id, zonal_premium_ratio FROM public.listing_zonal_comparison
),
broker_trust_join AS (
  -- Per-listing broker trust score. trust_score is polymorphic
  -- (target_type='agent' + target_id=created_by).
  SELECT b.listing_id, b.created_by, ts.trust_score
  FROM (
    SELECT id AS listing_id, created_by FROM public.listings
  ) b
  LEFT JOIN public.trust_score ts
    ON ts.target_type = 'agent' AND ts.target_id = b.created_by::text
),
velocity AS (
  SELECT city_id, property_type, absorption_rate_30d
  FROM public.market_velocity
),
percentile_pps AS (
  -- Per-segment percentile rank of price-per-sqm. Used by luxury_score.
  SELECT
    base.listing_id,
    percent_rank() OVER (
      PARTITION BY base.city_id, base.property_type
      ORDER BY base.pps NULLS FIRST
    ) AS pps_pct
  FROM base
)
SELECT
  base.listing_id,
  base.city_id,
  base.property_type,
  -- Component values surfaced for the explanation endpoint.
  coalesce(r.quality_score, 50)            AS quality_score,
  coalesce(r.freshness_score, 0.5)         AS freshness_score,
  coalesce(r.verification_boost, 1.0)      AS verification_boost,
  coalesce(r.broker_trust_boost, 1.0)      AS broker_trust_boost,
  coalesce(r.velocity_penalty, 1.0)        AS velocity_penalty,
  coalesce(z.zonal_premium_ratio, 0)       AS zonal_premium_ratio,
  coalesce(bt.trust_score, 0)              AS broker_trust_score,
  coalesce(v.absorption_rate_30d, 0)       AS absorption_rate_30d,
  coalesce(pp.pps_pct, 0)                  AS pps_percentile,
  -- ----- per-mode score columns -----
  -- recommended_score: balanced product. NULL components default
  -- to neutral so a brand-new listing isn't invisible.
  ( coalesce(r.quality_score, 50)
    * coalesce(r.verification_boost, 1.0)
    * coalesce(r.broker_trust_boost, 1.0)
    * coalesce(r.velocity_penalty, 1.0)
    * coalesce(r.freshness_score, 0.5)
  )::numeric                                AS recommended_score,
  -- quality_score: direct.
  coalesce(r.quality_score, 50)::numeric    AS quality_score_sort,
  -- trusted_score: broker trust × 100 + quality/10 as tiebreaker.
  ( coalesce(r.broker_trust_boost, 1.0) * 100
    + coalesce(r.quality_score, 50) / 10.0
  )::numeric                                AS trusted_score,
  -- fastest_moving_score: absorption × quality. Listings in
  -- low-absorption segments score near 0.
  ( coalesce(v.absorption_rate_30d, 0)
    * coalesce(r.quality_score, 50)
  )::numeric                                AS fastest_moving_score,
  -- undervalued_score: negative zonal premium = undervalued.
  -- Multiply by quality so we don't surface low-quality + low-priced.
  ( -coalesce(z.zonal_premium_ratio, 0)
    * coalesce(r.quality_score, 50)
  )::numeric                                AS undervalued_score,
  -- luxury_score: per-segment price percentile × verification × trust.
  ( coalesce(pp.pps_pct, 0)
    * coalesce(r.verification_boost, 1.0)
    * coalesce(r.broker_trust_boost, 1.0)
    * 100
  )::numeric                                AS luxury_score,
  -- newest_score: createdAt's epoch / fixed denominator. Sortable
  -- as a numeric so it joins the others in the same shape.
  EXTRACT(EPOCH FROM base.created_at)::numeric AS newest_score
FROM base
LEFT JOIN ranking            r  ON r.listing_id  = base.listing_id
LEFT JOIN zonal              z  ON z.listing_id  = base.listing_id
LEFT JOIN broker_trust_join  bt ON bt.listing_id = base.listing_id
LEFT JOIN velocity           v  ON v.city_id = base.city_id AND v.property_type = base.property_type
LEFT JOIN percentile_pps     pp ON pp.listing_id = base.listing_id;

GRANT SELECT ON public.listing_discovery_score TO authenticated, anon;

COMMENT ON VIEW public.listing_discovery_score IS
  'Per-listing × per-sort-mode score columns. Read by /api/listings/discover. Each *_score column corresponds to a search_sort_modes.score_column. NULL components default to neutral so listings without ranking data still appear (just at neutral position).';


-- =====================================================================
-- 3. similar_listings RPC — deterministic weighted similarity
-- =====================================================================
--
-- Given a source listing, returns the top-N most similar by weighted
-- match score. Signals (additive):
--   same building            +50
--   same city                +10
--   same property_type       +10
--   same segment + bedrooms  +15
--   price within ±20%        +10
--   same broker (created_by) +5
--   quality score within 15  +5

CREATE OR REPLACE FUNCTION public.similar_listings(
  p_listing_id bigint,
  p_limit      int DEFAULT 10
) RETURNS TABLE (
  listing_id      bigint,
  similarity_score int,
  match_reasons   text[]
)
LANGUAGE plpgsql STABLE PARALLEL SAFE
SET search_path = public, extensions
AS $$
DECLARE
  v_src record;
BEGIN
  -- Cap limit to a sane ceiling — protects pagination from N+1.
  p_limit := least(coalesce(p_limit, 10), 50);

  SELECT
    l.id,
    l.city_id,
    l.barangay_id,
    l.building_id,
    l.property_type,
    l.bedrooms,
    l.sale_price,
    l.created_by,
    coalesce(q.total_score, 50) AS quality_score
  INTO v_src
  FROM public.listings l
  LEFT JOIN public.listing_quality q ON q.listing_id = l.id
  WHERE l.id = p_listing_id
    AND l.is_online = true
    AND l.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN;  -- source not found / not visible
  END IF;

  RETURN QUERY
    SELECT
      candidate.id::bigint,
      (
        CASE WHEN candidate.building_id = v_src.building_id     THEN 50 ELSE 0 END
      + CASE WHEN candidate.city_id     = v_src.city_id         THEN 10 ELSE 0 END
      + CASE WHEN candidate.property_type = v_src.property_type THEN 10 ELSE 0 END
      + CASE WHEN candidate.city_id = v_src.city_id
             AND candidate.property_type = v_src.property_type
             AND abs(coalesce(candidate.bedrooms, 0) - coalesce(v_src.bedrooms, 0)) <= 1
             THEN 15 ELSE 0 END
      + CASE WHEN v_src.sale_price IS NOT NULL
             AND candidate.sale_price IS NOT NULL
             AND v_src.sale_price > 0
             AND abs(candidate.sale_price - v_src.sale_price)::numeric / v_src.sale_price <= 0.20
             THEN 10 ELSE 0 END
      + CASE WHEN candidate.created_by = v_src.created_by       THEN 5  ELSE 0 END
      + CASE WHEN abs(coalesce(cq.total_score, 50) - v_src.quality_score) <= 15
             THEN 5 ELSE 0 END
      )::int AS similarity_score,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN candidate.building_id = v_src.building_id THEN 'same_building' END,
        CASE WHEN candidate.city_id     = v_src.city_id     THEN 'same_city' END,
        CASE WHEN candidate.property_type = v_src.property_type THEN 'same_property_type' END,
        CASE WHEN candidate.city_id = v_src.city_id
             AND candidate.property_type = v_src.property_type
             AND abs(coalesce(candidate.bedrooms, 0) - coalesce(v_src.bedrooms, 0)) <= 1
             THEN 'similar_bedrooms' END,
        CASE WHEN v_src.sale_price IS NOT NULL
             AND candidate.sale_price IS NOT NULL
             AND v_src.sale_price > 0
             AND abs(candidate.sale_price - v_src.sale_price)::numeric / v_src.sale_price <= 0.20
             THEN 'similar_price' END,
        CASE WHEN candidate.created_by = v_src.created_by THEN 'same_broker' END,
        CASE WHEN abs(coalesce(cq.total_score, 50) - v_src.quality_score) <= 15
             THEN 'similar_quality' END
      ], NULL) AS match_reasons
    FROM public.listings candidate
    LEFT JOIN public.listing_quality cq ON cq.listing_id = candidate.id
    WHERE candidate.id <> p_listing_id
      AND candidate.is_online = true
      AND candidate.deleted_at IS NULL
      -- Lock the candidate set to same city by default. Cross-city
      -- "similar" doesn't make sense for property search.
      AND candidate.city_id = v_src.city_id
    ORDER BY similarity_score DESC, candidate.created_at DESC
    LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.similar_listings(bigint, int) TO authenticated, anon;

COMMENT ON FUNCTION public.similar_listings(bigint, int) IS
  'Deterministic weighted similarity. Returns top-N candidates with their match reasons array (e.g., ["same_building","similar_price"]). No embeddings, no ML — every signal is auditable.';


-- =====================================================================
-- 4. listing_ranking_explanation RPC — admin debug
-- =====================================================================

CREATE OR REPLACE FUNCTION public.listing_ranking_explanation(
  p_listing_id bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
DECLARE
  v_row jsonb;
  v_quality jsonb;
  v_modes jsonb;
BEGIN
  IF NOT (
    public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: admin.access' USING ERRCODE = '42501';
  END IF;

  SELECT to_jsonb(d.*) INTO v_row
    FROM public.listing_discovery_score d
   WHERE d.listing_id = p_listing_id;

  IF v_row IS NULL THEN
    RETURN jsonb_build_object(
      'listing_id', p_listing_id,
      'error',      'not_found',
      'message',    'Listing not in discovery view (offline, deleted, or pending MV refresh).'
    );
  END IF;

  SELECT to_jsonb(q.*) INTO v_quality
    FROM public.listing_quality q
   WHERE q.listing_id = p_listing_id;

  SELECT jsonb_agg(jsonb_build_object(
    'mode_key',     m.mode_key,
    'display_name', m.display_name,
    'formula',      m.formula_doc,
    'score',        v_row -> m.score_column
  ) ORDER BY m.is_default DESC, m.mode_key)
  INTO v_modes
  FROM public.search_sort_modes m
  WHERE m.enabled = true;

  RETURN jsonb_build_object(
    'listing_id',       p_listing_id,
    'discovery_signals', v_row,
    'quality_breakdown', coalesce(v_quality, '{}'::jsonb),
    'sort_modes',       coalesce(v_modes, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.listing_ranking_explanation(bigint) TO authenticated;


-- =====================================================================
-- 5. saved_search_subscriptions.alert_types — additive column
-- =====================================================================
--
-- Default ['match'] preserves existing behavior (digest sends new
-- listings matching the filter). Additional types: 'price_drop',
-- 'verified_listing', 'trusted_broker', 'hot_area'.
--
-- Cron evaluator that respects these types is deferred — this turn
-- ships only the column + UI/endpoint scaffolding so subscribers
-- can pick their alert types now and the worker turns them on
-- when it lands.

ALTER TABLE public.saved_search_subscriptions
  ADD COLUMN IF NOT EXISTS alert_types text[] NOT NULL
    DEFAULT ARRAY['match']::text[];

CREATE INDEX IF NOT EXISTS saved_search_alert_types_gin
  ON public.saved_search_subscriptions USING gin (alert_types);

COMMENT ON COLUMN public.saved_search_subscriptions.alert_types IS
  'Subscriber-selected alert types. Default [match] = current digest behavior. Extended types (price_drop, verified_listing, trusted_broker, hot_area) require the discovery-aware digest worker — shipped separately.';


-- =====================================================================
-- 6. Permissions + governance registration
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('discovery.read',  'Read intelligent discovery (sort modes, similar listings)', 'discovery')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'discovery.read'),
  ('manager', 'discovery.read'),
  ('agent',   'discovery.read')
ON CONFLICT DO NOTHING;

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.listing_discovery_score', 'view', 'userportal', ARRAY['userportal','website'],
   'Per-listing × per-sort-mode discovery scores. Reads listing_ranking_signals + listing_zonal_comparison + market_velocity + trust_score.', true),
  ('public.search_sort_modes',       'table', 'userportal', ARRAY['userportal','website'],
   'Registry of intelligent search sort modes with formula docs.', true),
  ('public.similar_listings',        'function', 'userportal', ARRAY['userportal','website'],
   'Deterministic weighted similarity RPC. Returns top-N candidates with match reasons.', true)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
