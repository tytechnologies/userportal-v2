-- MLS Duplicate Detection — review queue infrastructure.
--
-- Deterministic signal-based detection. NEVER auto-merges. Inserts
-- pair candidates into a review queue; admin verdicts close them.
--
-- Detection signals + weights (sum to confidence 0-100):
--   same broker (created_by)        +20
--   floor area within 5%            +30
--   price within 5% (sale or rent)  +25
--   bedrooms exact match            +10
--   title trgm similarity > 0.4     +10  (pg_trgm)
--   building.geom not null          +5   (proxy for "same exact pin")
--
-- Candidates restricted to within-building pairs to bound the
-- search space. Buildings with >100 listings still fit easily
-- (100×100=10K pairs).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.find_listing_duplicate_candidates(bigint, int);
--   DROP TABLE IF EXISTS public.listing_duplicate_candidates;


-- =====================================================================
-- 1. listing_duplicate_candidates — review queue
-- =====================================================================
--
-- Pair-keyed: (LEAST(a,b), GREATEST(a,b)) is UNIQUE so the same pair
-- can't be inserted twice regardless of which side came first.

CREATE TABLE IF NOT EXISTS public.listing_duplicate_candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical-ordered pair: a_listing_id < b_listing_id always.
  -- Enforced by a CHECK + the inserter logic.
  a_listing_id    bigint NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  b_listing_id    bigint NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  CHECK (a_listing_id < b_listing_id),

  confidence      int NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  -- Per-signal contribution breakdown so admins see exactly what
  -- tipped the detector.
  signals         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Review state machine.
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending',           -- awaiting review
                       'confirmed_duplicate', -- admin confirmed; both listings refer to the same unit
                       'distinct',           -- admin confirmed; listings are genuinely different
                       'dismissed'           -- admin closed without strong verdict
                     )),
  reviewed_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  review_notes    text,

  -- Origin: which run created this candidate?
  detected_at     timestamptz NOT NULL DEFAULT now(),
  detected_run    text,        -- 'nightly' / 'recent_30min' / 'manual'

  UNIQUE (a_listing_id, b_listing_id)
);

CREATE INDEX IF NOT EXISTS listing_duplicate_pending_idx
  ON public.listing_duplicate_candidates(detected_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS listing_duplicate_listing_a_idx
  ON public.listing_duplicate_candidates(a_listing_id);
CREATE INDEX IF NOT EXISTS listing_duplicate_listing_b_idx
  ON public.listing_duplicate_candidates(b_listing_id);

ALTER TABLE public.listing_duplicate_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_duplicate_candidates_admin
  ON public.listing_duplicate_candidates;
CREATE POLICY listing_duplicate_candidates_admin
  ON public.listing_duplicate_candidates FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

COMMENT ON TABLE public.listing_duplicate_candidates IS
  'Pair-keyed review queue for listing duplicates. NEVER auto-merged. Pair canonical-ordered (a<b) + UNIQUE so the same pair never inserts twice. Admin verdicts close pending rows; CASCADE on listing deletion keeps the queue clean.';


-- =====================================================================
-- 2. find_listing_duplicate_candidates — the detector RPC
-- =====================================================================
--
-- p_only_recent: when true, only considers listings created or
-- price-changed in the last 90 minutes (the 30-min cron path).
-- When false, full pass over all online listings (nightly path).
-- p_max: caps the number of new candidates per run; protects against
-- a runaway dump if an unexpected mass-create event happens.

CREATE OR REPLACE FUNCTION public.find_listing_duplicate_candidates(
  p_only_recent boolean DEFAULT false,
  p_max         int     DEFAULT 1000
) RETURNS TABLE (
  inserted_count int,
  evaluated_pairs int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_inserted int := 0;
  v_evaluated int := 0;
  v_run_label text := CASE WHEN p_only_recent THEN 'recent_30min' ELSE 'nightly' END;
BEGIN
  -- Caller gate: cron runs as postgres / supabase_admin / service_role.
  IF NOT (session_user IN ('postgres', 'supabase_admin', 'service_role')
          OR public.has_permission('admin.access')) THEN
    RAISE EXCEPTION 'permission denied: detector is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  -- Build candidate listing set + scan within-building pairs in one
  -- CTE chain. The within-building gate keeps the join bounded.
  WITH base AS (
    SELECT l.id, l.building_id, l.created_by, l.title,
           l.sale_price, l.rent_price, l.floor_area, l.bedrooms,
           l.created_at, l.price_changed_at
    FROM public.listings l
    WHERE l.is_online = true
      AND l.deleted_at IS NULL
      AND l.building_id IS NOT NULL
      AND (
        NOT p_only_recent
        OR coalesce(l.price_changed_at, l.created_at) > now() - interval '90 minutes'
      )
  ),
  pairs AS (
    -- Self-join restricted to (a < b) within the same building.
    SELECT
      a.id AS a_id, b.id AS b_id,
      -- Per-signal contributions
      CASE WHEN a.created_by IS NOT NULL
            AND a.created_by = b.created_by THEN 20 ELSE 0 END  AS sig_same_broker,
      CASE WHEN a.floor_area IS NOT NULL AND b.floor_area IS NOT NULL
            AND a.floor_area > 0 AND b.floor_area > 0
            AND abs(a.floor_area - b.floor_area)::numeric / a.floor_area <= 0.05
           THEN 30 ELSE 0 END                                    AS sig_floor_area,
      CASE
        WHEN a.sale_price IS NOT NULL AND b.sale_price IS NOT NULL
          AND a.sale_price > 0 AND b.sale_price > 0
          AND abs(a.sale_price - b.sale_price)::numeric / a.sale_price <= 0.05
          THEN 25
        WHEN a.rent_price IS NOT NULL AND b.rent_price IS NOT NULL
          AND a.rent_price > 0 AND b.rent_price > 0
          AND abs(a.rent_price - b.rent_price)::numeric / a.rent_price <= 0.05
          THEN 25
        ELSE 0
      END                                                        AS sig_price,
      CASE WHEN a.bedrooms IS NOT NULL AND a.bedrooms = b.bedrooms
           THEN 10 ELSE 0 END                                    AS sig_bedrooms,
      CASE WHEN a.title IS NOT NULL AND b.title IS NOT NULL
            AND length(a.title) > 0 AND length(b.title) > 0
            AND similarity(a.title, b.title) > 0.4
           THEN 10 ELSE 0 END                                    AS sig_title_similar,
      CASE WHEN bld.geom IS NOT NULL THEN 5 ELSE 0 END           AS sig_same_geom
    FROM base a
    JOIN base b ON b.building_id = a.building_id AND b.id > a.id
    LEFT JOIN public.buildings bld ON bld.id = a.building_id
  ),
  scored AS (
    SELECT
      a_id, b_id,
      sig_same_broker + sig_floor_area + sig_price + sig_bedrooms
        + sig_title_similar + sig_same_geom AS confidence,
      jsonb_build_object(
        'same_broker',     sig_same_broker,
        'floor_area',      sig_floor_area,
        'price',           sig_price,
        'bedrooms',        sig_bedrooms,
        'title_similar',   sig_title_similar,
        'same_geom',       sig_same_geom
      ) AS signals
    FROM pairs
  )
  -- Cap per run via a subquery — LIMIT is not valid after
  -- ON CONFLICT in an INSERT.
  INSERT INTO public.listing_duplicate_candidates
    (a_listing_id, b_listing_id, confidence, signals, detected_run)
  SELECT
    s.a_id::bigint, s.b_id::bigint, s.confidence, s.signals, v_run_label
  FROM (
    SELECT a_id, b_id, confidence, signals
      FROM scored
     WHERE confidence >= 50
     ORDER BY confidence DESC
     LIMIT p_max
  ) s
  ON CONFLICT (a_listing_id, b_listing_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- We don't have a direct count of evaluated pairs in this insert
  -- form; surface a rough lower bound for observability.
  v_evaluated := v_inserted;

  inserted_count  := v_inserted;
  evaluated_pairs := v_evaluated;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_listing_duplicate_candidates(boolean, int) TO authenticated;


-- =====================================================================
-- 3. pg_trgm extension (required for similarity())
-- =====================================================================
--
-- Idempotent install. Supabase has it available in `extensions`
-- schema; safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;


-- =====================================================================
-- 4. Cron — nightly full pass + 30-min recent pass
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Nightly full scan at 04:00 UTC (12:00 PHT).
    PERFORM cron.unschedule('find_listing_duplicates_nightly')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'find_listing_duplicates_nightly');
    PERFORM cron.schedule(
      'find_listing_duplicates_nightly',
      '0 4 * * *',
      'SELECT public.find_listing_duplicate_candidates(false, 1000);'
    );

    -- Recent-only scan every 30 minutes — catches new listings
    -- without a full table scan.
    PERFORM cron.unschedule('find_listing_duplicates_recent_30min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'find_listing_duplicates_recent_30min');
    PERFORM cron.schedule(
      'find_listing_duplicates_recent_30min',
      '*/30 * * * *',
      'SELECT public.find_listing_duplicate_candidates(true, 200);'
    );
  END IF;
END $$;


-- =====================================================================
-- 5. Governance — register the new table + RPC
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.listing_duplicate_candidates', 'table', 'userportal', ARRAY['userportal'],
   'Pair-keyed review queue for duplicate listings. NEVER auto-merged.', false),
  ('public.find_listing_duplicate_candidates', 'function', 'userportal', ARRAY['userportal'],
   'Deterministic detector. Within-building scope; threshold confidence 50.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
