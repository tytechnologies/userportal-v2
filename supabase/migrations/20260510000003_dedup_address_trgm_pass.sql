-- Dedup detector — address trigram pair-source pass.
--
-- Mig 510000002 added GPS proximity as a NEW pair-source pass on top of
-- the original within-building pass from mig 507000037. Production
-- diagnosis showed that this DB has 0% geom coverage on properties
-- (11,533 referenced rows, 0 with geom) AND only 1,274 distinct
-- building_ids across 49,491 live listings — so both passes are
-- starved on this data shape.
--
-- This migration adds a THIRD pair-source pass that doesn't depend on
-- either signal. It joins listings via properties.street_address with
-- pg_trgm similarity ≥ 0.6, backed by a GIN trigram index for fast
-- cross-table lookup. The address_trgm scoring signal (introduced in
-- mig 510000002 at threshold 0.5 → +10) is unchanged — we keep the
-- looser threshold for *scoring* and use a tighter threshold for
-- *pair sourcing* so weak matches still score but don't flood the
-- queue on their own.
--
-- Confidence threshold (50) is unchanged. An address-sourced pair must
-- still pick up at least 40 corroborating points from price / floor
-- area / bedrooms / broker / title to enter the queue. Address alone
-- → +10 → below threshold → discarded.
--
-- Strictly additive at the schema level: one new partial GIN index,
-- one function body replacement (same signature). Reference schema
-- untouched.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.properties_street_address_trgm_idx;
--   -- Restore the prior detector body by re-applying
--   -- 20260510000002_dedup_signals_extension.sql, OR
--   -- 20260507000037_mls_duplicate_detection.sql if 002 was also rolled back.
--
-- DEPENDS ON:
--   db-main-reference/tables.sql               (properties.street_address)
--   20260507000037_mls_duplicate_detection.sql (pg_trgm extension, table, cron)
--   20260510000002_dedup_signals_extension.sql (current detector body — not
--                                               strictly required; CREATE OR
--                                               REPLACE supersedes either prior body)


-- =====================================================================
-- 0. Preconditions + drift introspection
-- =====================================================================

DO $$
DECLARE
  v_missing             text[] := ARRAY[]::text[];
  v_has_trgm_opclass    boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='properties') THEN
    v_missing := v_missing || 'public.properties';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='properties'
                    AND column_name='street_address') THEN
    v_missing := v_missing || 'public.properties.street_address';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listing_duplicate_candidates') THEN
    v_missing := v_missing || 'public.listing_duplicate_candidates (mig 507000037)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm') THEN
    v_missing := v_missing || 'extension: pg_trgm';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis') THEN
    v_missing := v_missing || 'extension: postgis';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 20260510000003 missing prerequisites: %.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42P01';
  END IF;

  -- gin_trgm_ops operator class must be resolvable for the CREATE INDEX
  -- expression we're about to run. pg_trgm lives in `extensions` on
  -- Supabase — we schema-qualify below, but verify here so the failure
  -- mode is clear if the install path differs.
  SELECT EXISTS (
    SELECT 1
      FROM pg_opclass oc
      JOIN pg_am am  ON am.oid = oc.opcmethod
      JOIN pg_namespace n ON n.oid = oc.opcnamespace
     WHERE oc.opcname = 'gin_trgm_ops'
       AND am.amname  = 'gin'
  ) INTO v_has_trgm_opclass;

  IF NOT v_has_trgm_opclass THEN
    RAISE EXCEPTION
      'pg_trgm GIN operator class (gin_trgm_ops) not found. Confirm pg_trgm extension installed in a reachable schema.'
      USING ERRCODE = '42704';
  END IF;
END $$;


-- =====================================================================
-- 1. GIN trigram index on properties.street_address
-- =====================================================================
-- Partial: skip rows with no address or too-short addresses (the
-- detector's same filter). length() is IMMUTABLE per
-- feedback_immutable_index_expressions, so it's index-predicate safe.
--
-- Schema-qualified opclass `extensions.gin_trgm_ops` per
-- feedback_supabase_pgcrypto_search_path — pg_trgm lives in
-- `extensions` on Supabase.
--
-- Build is sub-second at 11.5k rows; no CONCURRENTLY needed at this
-- size. Idempotent via IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS properties_street_address_trgm_idx
  ON public.properties
  USING gin (street_address extensions.gin_trgm_ops)
  WHERE street_address IS NOT NULL AND length(street_address) >= 6;

COMMENT ON INDEX public.properties_street_address_trgm_idx IS
  'Trigram GIN index supporting the address-trgm pair-source pass of find_listing_duplicate_candidates. Partial: skips empty/too-short addresses.';


-- =====================================================================
-- 2. Replace the detector body — add the third pair-source pass
-- =====================================================================
-- Same signature, same return shape, same INSERT target. The third
-- pass is gated by length(prop_street) >= 6 (matching the index
-- predicate) and the `%` operator with similarity_threshold = 0.6
-- set via SET LOCAL — that's the value the GIN index uses to filter,
-- so the planner can pick the trigram index.
--
-- The address pass is restricted to pairs NOT already covered by the
-- first two passes (different building_id or either NULL, no geom on
-- both sides) so we don't pointlessly re-score the same pair. The
-- final UNION at the bottom of `all_pair_ids` is still a safety net.

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
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: detector is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  -- Set the trigram-operator threshold for THIS function call only.
  -- The `%` operator below uses this value; the GIN index filters at
  -- the same threshold so the planner can pick the index. 0.6 is the
  -- pair-source threshold (tighter than the 0.5 used for the scoring
  -- signal — see mig 510000002).
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
  -- Pass 1: within-building (original mig 037 scope).
  building_pairs AS (
    SELECT a.id AS a_id, b.id AS b_id
    FROM base a
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
  -- Pass 3: address trigram (NEW). Cross-property, cross-building.
  -- Restricted to listings whose properties have addresses long
  -- enough to be index-eligible. The `%` operator uses the GIN
  -- trigram index at the 0.6 threshold set above.
  addr_trgm_pairs AS (
    SELECT a.id AS a_id, b.id AS b_id
    FROM base a
    JOIN base b
      ON a.prop_street IS NOT NULL
     AND b.prop_street IS NOT NULL
     AND length(a.prop_street) >= 6
     AND length(b.prop_street) >= 6
     AND b.id > a.id
     AND a.prop_street % b.prop_street
     -- Skip pairs already covered by pass 1 or pass 2.
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
      -- Scoring threshold (0.5) stays looser than the pair-source
      -- threshold (0.6) so weak-but-real address matches still score
      -- when other signals carry the pair.
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


-- =====================================================================
-- 3. Governance update
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RAISE NOTICE 'governance_schema_contracts not present; skipping update.';
    RETURN;
  END IF;

  UPDATE public.governance_schema_contracts
     SET description =
           'Deterministic detector. Three-pass: within-building + GPS proximity ≤ 50m + address-trigram ≥ 0.6. Threshold confidence 50. Same signature, same return, same INSERT target.',
         updated_at = now()
   WHERE contract_name = 'public.find_listing_duplicate_candidates';
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste in the SQL editor.
-- =====================================================================
--
-- 1) Index landed where expected.
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE schemaname = 'public'
--    AND tablename  = 'properties'
--    AND indexname  = 'properties_street_address_trgm_idx';
--
-- 2) Full pass — should now emit > 0 on a populated DB.
-- SELECT * FROM public.find_listing_duplicate_candidates(false, 1000);
--
-- 3) Distribution of the address-trgm pass output.
-- SELECT count(*)                                                              AS total_pairs,
--        count(*) FILTER (WHERE (signals->>'address_trgm')::int > 0)           AS with_addr_signal,
--        count(*) FILTER (WHERE (signals->>'gps_proximity')::int > 0)          AS with_gps_signal,
--        count(*) FILTER (WHERE (signals->>'floor_area')::int > 0)             AS with_area_signal,
--        avg(confidence)::int                                                  AS avg_conf
--   FROM public.listing_duplicate_candidates
--  WHERE detected_at > now() - interval '5 minutes';
--
-- 4) Top emitted pairs (sanity-check that the new pass surfaces real
--    looking duplicates).
-- SELECT c.id, c.confidence, c.signals,
--        la.id AS a_id, la.title AS a_title, la.property_id AS a_prop,
--        lb.id AS b_id, lb.title AS b_title, lb.property_id AS b_prop
--   FROM public.listing_duplicate_candidates c
--   JOIN public.listings la ON la.id = c.a_listing_id
--   JOIN public.listings lb ON lb.id = c.b_listing_id
--  WHERE c.detected_at > now() - interval '5 minutes'
--  ORDER BY c.confidence DESC
--  LIMIT 20;
