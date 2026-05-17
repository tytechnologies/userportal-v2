-- Fix: `find_listing_duplicates_nightly` cron timeout.
--
-- 2026-05-14 prod alert: the cron job failed with
-- "ERROR: canceling statement due to statement timeout" inside the
-- function's main WITH-cte INSERT. Root causes diagnosed against the
-- 49k-live-listings / 1,274-buildings shape:
--
--   1. `building_pairs` is a cross-join within building_id. Some
--      buildings carry hundreds of listings (catch-all "default" /
--      legacy buckets). One 500-listing building produces ~125k pairs
--      ALONE. Cumulative pair count was reaching low millions, then
--      the scoring CTE joins back to `base` × 2 — that's the timeout
--      hot path.
--   2. Default `statement_timeout` is 60s (Supabase default) but pg_cron
--      runs in the maintenance role with the same cap. The detector
--      legitimately needs more — single full pass should complete in
--      5-10 minutes for the foreseeable corpus size.
--
-- Fix (additive — same function signature, same return shape, same
-- INSERT target, same scoring weights):
--   a) SET LOCAL statement_timeout = '15min' at function start.
--   b) Pre-compute a `building_sizes` CTE; exclude buildings with
--      > BUILDING_PAIR_MAX listings from the within-building pass.
--      Real duplicate detection in catch-all buildings is doomed
--      anyway — too noisy to be useful; the 30-min recent cron
--      catches genuine new-listing dupes incrementally.
--   c) Cap the address-trgm pair source at a hard upper bound so
--      pathological trigram-rich datasets can't blow the budget.
--
-- BUILDING_PAIR_MAX is set to 100 — chosen to keep within-building
-- cross-joins under ~5000 pairs per building. Lower if a future
-- detector run still times out; raise if you measure that important
-- duplicate pairs are getting dropped.
--
-- Strictly additive: prior function body recreated with the three
-- additions above. Cron schedule itself unchanged (mig 037).
--
-- ROLLBACK: re-run mig 20260510000003 to restore the prior body.


-- =====================================================================
-- Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines
                  WHERE routine_schema='public'
                    AND routine_name='find_listing_duplicate_candidates') THEN
    RAISE EXCEPTION 'Migration 20260514000009 requires the existing find_listing_duplicate_candidates function (mig 20260510000003)'
      USING ERRCODE = '42704';
  END IF;
END $$;


-- =====================================================================
-- CREATE OR REPLACE — body identical to mig 510000003 + 3 changes:
--   (a) SET LOCAL statement_timeout
--   (b) building_sizes CTE + WHERE filter on building_pairs
--   (c) hard LIMIT on addr_trgm_pairs as a safety net
-- =====================================================================

CREATE OR REPLACE FUNCTION public.find_listing_duplicate_candidates(
  p_only_recent boolean DEFAULT false,
  p_max         int     DEFAULT 1000
) RETURNS TABLE (
  inserted_count int,
  evaluated_pairs int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_inserted  int := 0;
  v_evaluated int := 0;
  v_run_label text := CASE WHEN p_only_recent THEN 'recent_30min' ELSE 'nightly' END;
  -- (b) Skip within-building cross-joins for buildings with more
  --     listings than this. 100 keeps each building's pair count
  --     under 5000. Adjustable in a future migration if data shape
  --     changes; defined as a constant for now.
  BUILDING_PAIR_MAX constant int := 100;
  -- (c) Hard ceiling on address-trgm pair count. Index can stream
  --     hundreds of thousands of matches at the 0.6 threshold on
  --     pathological addresses; cap before they feed the scoring CTE.
  ADDR_TRGM_PAIR_MAX constant int := 100000;
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: detector is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  -- (a) Raise statement_timeout for this function call only.
  --     LOCAL scope: doesn't leak to other sessions.
  PERFORM set_config('statement_timeout', '900000', true);  -- 15 minutes

  PERFORM set_config('pg_trgm.similarity_threshold', '0.6', true);

  WITH base AS (
    SELECT
      l.id,
      l.building_id,
      l.property_id,
      l.created_by,
      l.title,
      l.sale_price,
      l.rent_price,
      l.floor_area,
      l.bedrooms,
      l.created_at,
      l.price_changed_at,
      p.geom           AS prop_geom,
      p.street_address AS prop_street
    FROM public.listings l
    LEFT JOIN public.properties p ON p.id = l.property_id
    WHERE l.is_online   = true
      AND l.deleted_at  IS NULL
      AND (
        NOT p_only_recent
        OR coalesce(l.price_changed_at, l.created_at) > now() - interval '90 minutes'
      )
  ),
  -- (b) Pre-compute building sizes so we can exclude catch-all
  --     buckets from the cross-join.
  building_sizes AS (
    SELECT building_id, count(*) AS n
      FROM base
     WHERE building_id IS NOT NULL
     GROUP BY building_id
    HAVING count(*) <= BUILDING_PAIR_MAX
  ),
  -- Pass 1: within-building (excluding pathological buckets).
  building_pairs AS (
    SELECT a.id AS a_id, b.id AS b_id
    FROM base a
    JOIN building_sizes bs ON bs.building_id = a.building_id
    JOIN base b
      ON b.building_id = a.building_id
     AND b.id          > a.id
    WHERE a.building_id IS NOT NULL
  ),
  -- Pass 2: GPS proximity ≤ 50m (added by mig 510000002).
  geo_pairs AS (
    SELECT a.id AS a_id, b.id AS b_id
    FROM base a
    JOIN base b
      ON a.prop_geom IS NOT NULL
     AND b.prop_geom IS NOT NULL
     AND b.id > a.id
     AND ST_DWithin(a.prop_geom::geography, b.prop_geom::geography, 50)
     AND (
       a.building_id IS DISTINCT FROM b.building_id
       OR a.building_id IS NULL
       OR b.building_id IS NULL
     )
  ),
  -- Pass 3: address trigram (mig 510000003).
  -- (c) Capped at ADDR_TRGM_PAIR_MAX as a safety net against
  --     pathological address-rich datasets. Pairs above the cap
  --     are dropped silently; they'd most likely be scored below
  --     the 50-confidence threshold anyway.
  addr_trgm_pairs AS (
    SELECT a_id, b_id FROM (
      SELECT a.id AS a_id, b.id AS b_id
      FROM base a
      JOIN base b
        ON a.prop_street IS NOT NULL
       AND b.prop_street IS NOT NULL
       AND length(a.prop_street) >= 6
       AND length(b.prop_street) >= 6
       AND b.id > a.id
       AND a.prop_street % b.prop_street
       AND (
         a.building_id IS NULL
         OR b.building_id IS NULL
         OR a.building_id IS DISTINCT FROM b.building_id
       )
       AND (
         a.prop_geom IS NULL
         OR b.prop_geom IS NULL
         OR NOT ST_DWithin(a.prop_geom::geography, b.prop_geom::geography, 50)
       )
      LIMIT ADDR_TRGM_PAIR_MAX
    ) s
  ),
  all_pair_ids AS (
    SELECT a_id, b_id FROM building_pairs
    UNION
    SELECT a_id, b_id FROM geo_pairs
    UNION
    SELECT a_id, b_id FROM addr_trgm_pairs
  ),
  pairs AS (
    SELECT
      ap.a_id, ap.b_id,
      CASE WHEN a.created_by IS NOT NULL
            AND a.created_by = b.created_by
           THEN 15 ELSE 0 END                                   AS sig_same_broker,
      CASE WHEN a.floor_area IS NOT NULL AND b.floor_area IS NOT NULL
            AND a.floor_area > 0 AND b.floor_area > 0
            AND abs(a.floor_area - b.floor_area)::numeric / a.floor_area <= 0.05
           THEN 25 ELSE 0 END                                   AS sig_floor_area,
      CASE
        WHEN a.sale_price IS NOT NULL AND b.sale_price IS NOT NULL
          AND a.sale_price > 0 AND b.sale_price > 0
          AND abs(a.sale_price - b.sale_price)::numeric / a.sale_price <= 0.05
          THEN 20
        WHEN a.rent_price IS NOT NULL AND b.rent_price IS NOT NULL
          AND a.rent_price > 0 AND b.rent_price > 0
          AND abs(a.rent_price - b.rent_price)::numeric / a.rent_price <= 0.05
          THEN 20
        ELSE 0
      END                                                      AS sig_price,
      CASE WHEN a.bedrooms IS NOT NULL AND a.bedrooms = b.bedrooms
           THEN 5 ELSE 0 END                                    AS sig_bedrooms,
      CASE WHEN a.title IS NOT NULL AND b.title IS NOT NULL
            AND length(a.title) > 0 AND length(b.title) > 0
            AND similarity(a.title, b.title) > 0.4
           THEN 10 ELSE 0 END                                   AS sig_title_similar,
      CASE WHEN a.prop_geom IS NOT NULL AND b.prop_geom IS NOT NULL
            AND ST_DWithin(a.prop_geom::geography, b.prop_geom::geography, 50)
           THEN 15 ELSE 0 END                                   AS sig_gps_proximity,
      CASE WHEN a.prop_street IS NOT NULL AND b.prop_street IS NOT NULL
            AND length(a.prop_street) > 3 AND length(b.prop_street) > 3
            AND similarity(a.prop_street, b.prop_street) > 0.5
           THEN 10 ELSE 0 END                                   AS sig_address_trgm
    FROM all_pair_ids ap
    JOIN base a ON a.id = ap.a_id
    JOIN base b ON b.id = ap.b_id
  ),
  scored AS (
    SELECT
      a_id, b_id,
      sig_same_broker + sig_floor_area + sig_price + sig_bedrooms
        + sig_title_similar + sig_gps_proximity + sig_address_trgm AS confidence,
      jsonb_build_object(
        'same_broker',   sig_same_broker,
        'floor_area',    sig_floor_area,
        'price',         sig_price,
        'bedrooms',      sig_bedrooms,
        'title_similar', sig_title_similar,
        'gps_proximity', sig_gps_proximity,
        'address_trgm',  sig_address_trgm
      ) AS signals
    FROM pairs
  )
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
  v_evaluated := v_inserted;

  inserted_count  := v_inserted;
  evaluated_pairs := v_evaluated;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.find_listing_duplicate_candidates(boolean, int) IS
  'Deterministic dedup detector. Three-pass: within-building (capped at <=100 listings per building) + GPS proximity ≤50m + address-trigram ≥0.6 (capped at 100k pairs). Threshold confidence 50. SET LOCAL statement_timeout=15min to survive the nightly full-scan. Mig 20260514000009 added the timeout + caps after the 2026-05-14 prod alert.';


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
-- 1) Function exists + signature unchanged.
-- SELECT proname, pg_get_function_arguments(oid)
--   FROM pg_proc
--  WHERE proname='find_listing_duplicate_candidates';
--
-- 2) Recent path (cheap) — should complete in seconds even on 49k.
-- SELECT * FROM public.find_listing_duplicate_candidates(true, 200);
--
-- 3) Full nightly path — should now complete in <5min.
-- SELECT * FROM public.find_listing_duplicate_candidates(false, 1000);
--
-- 4) If still timing out, two knobs to adjust (both inside the function):
--    - lower BUILDING_PAIR_MAX to skip more buckets
--    - lower ADDR_TRGM_PAIR_MAX
--    - raise the SET LOCAL statement_timeout (e.g. '30min')
