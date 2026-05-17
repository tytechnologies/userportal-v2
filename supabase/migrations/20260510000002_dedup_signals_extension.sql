-- Dedup detector signals extension — B-2 of the listing aggregation rebuild.
--
-- CREATE OR REPLACEs public.find_listing_duplicate_candidates so the
-- existing pg_cron jobs (set up in mig 20260507000037) keep their
-- schedules and call sites untouched. Same signature, same return
-- shape, same INSERT target — only the internals change:
--
--   1. Two pair-source passes, UNION'd before scoring:
--        within_building_pairs  — preserves existing same-building scope
--        geo_pairs              — NEW: cross-building, ST_DWithin ≤ 50m
--                                 on properties.geom (from db-main-reference)
--      This catches houses, lots, and single-family residences that
--      the building_id-only scope used to miss entirely, plus same-unit
--      pairs imported under different building rows.
--
--   2. Re-balanced weights (still summing to 100):
--        same_broker      +15  (was 20)
--        floor_area 5%    +25  (was 30)
--        price 5%         +20  (was 25)
--        bedrooms exact    +5  (was 10)
--        title trgm > 0.4 +10  (unchanged)
--        gps_proximity    +15  (NEW — replaces "same_geom +5")
--        address_trgm     +10  (NEW)
--      Pairs already in listing_duplicate_candidates keep their old
--      signals jsonb / confidence. Only future cron-emitted pairs use
--      the new weights. The 50-confidence threshold is unchanged.
--
-- Strictly additive at the schema level. No tables / columns / FKs
-- created or modified. `properties.street_address` and `properties.geom`
-- are read but those exist in db-main-reference and are untouched.
--
-- Image perceptual hash signal is intentionally NOT included yet — no
-- phash column / pipeline lands until B-3.
--
-- ROLLBACK (restore the mig 037 body verbatim):
--   Re-apply 20260507000037_mls_duplicate_detection.sql section 2.
--   Both the table and the cron entries are unaffected; only the
--   function body needs to be replaced back.
--
-- DEPENDS ON:
--   db-main-reference/tables.sql         (properties.geom, .street_address)
--   db-main-reference/listings.sql       (listings.property_id)
--   20260507000037_mls_duplicate_detection.sql
--                                        (listing_duplicate_candidates, pg_trgm,
--                                         pg_cron schedules)


-- =====================================================================
-- 0. Hard preconditions + drift introspection
-- =====================================================================
-- Fails loud if mig 037 hasn't been applied, or if properties.geom is
-- missing in this environment.

DO $$
DECLARE
  v_missing   text[] := ARRAY[]::text[];
  v_has_geom  boolean;
  v_has_addr  boolean;
  v_has_st_dwithin boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listing_duplicate_candidates') THEN
    v_missing := v_missing || 'public.listing_duplicate_candidates (mig 507000037)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines
                  WHERE routine_schema='public' AND routine_name='find_listing_duplicate_candidates') THEN
    v_missing := v_missing || 'public.find_listing_duplicate_candidates (mig 507000037)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    v_missing := v_missing || 'extension: pg_trgm';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    v_missing := v_missing || 'extension: postgis';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 20260510000002 missing prerequisites: %.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42P01';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='properties' AND column_name='geom'
  ) INTO v_has_geom;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='properties' AND column_name='street_address'
  ) INTO v_has_addr;

  IF NOT v_has_geom THEN
    RAISE EXCEPTION
      'Schema drift: public.properties.geom is missing. Reference schema (db-main-reference/tables.sql) declares it as GEOMETRY.'
      USING ERRCODE = '42703';
  END IF;
  IF NOT v_has_addr THEN
    RAISE EXCEPTION
      'Schema drift: public.properties.street_address is missing. Reference schema declares it as VARCHAR(255).'
      USING ERRCODE = '42703';
  END IF;

  -- Confirm ST_DWithin is callable in the resolved search_path.
  -- We don't actually exec it; just check the function exists.
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'st_dwithin'
  ) INTO v_has_st_dwithin;
  IF NOT v_has_st_dwithin THEN
    RAISE EXCEPTION
      'PostGIS ST_DWithin not callable. Confirm postgis extension is installed in a schema visible to public.find_listing_duplicate_candidates.'
      USING ERRCODE = '42883';
  END IF;
END $$;


-- =====================================================================
-- 1. Replace the detector body
-- =====================================================================
-- Same signature, same return shape, same INSERT target. The signals
-- jsonb gains two keys (`gps_proximity`, `address_trgm`) and loses one
-- (`same_geom`, which was a coarse "building has geom?" boolean and is
-- now replaced by actual GPS proximity). Existing rows in the queue
-- keep their prior jsonb; only new cron emissions use the new shape.

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
  -- Caller gate. Same as mig 037 — cron runs as postgres / supabase_admin
  -- / service_role; admins can also trigger ad-hoc via the operations
  -- surface.
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: detector is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  -- Build candidate set + score in one CTE chain. Two pair-source
  -- passes are UNION'd to dedupe pair identity at the SQL layer; the
  -- final INSERT also relies on the table's UNIQUE (a,b) for ultimate
  -- idempotency.
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
    WHERE l.is_online = true
      AND l.deleted_at IS NULL
      AND (
        NOT p_only_recent
        OR coalesce(l.price_changed_at, l.created_at) > now() - interval '90 minutes'
      )
  ),
  -- Pass 1: within-building (preserves mig 037 scope exactly).
  building_pairs AS (
    SELECT a.id AS a_id, b.id AS b_id
    FROM base a
    JOIN base b
      ON b.building_id = a.building_id
     AND b.id          > a.id
    WHERE a.building_id IS NOT NULL
  ),
  -- Pass 2: GPS proximity ≤ 50m using properties.geom (NEW).
  -- Excludes pairs already caught by the within-building pass so the
  -- per-pair scoring runs once per candidate. ST_DWithin uses the
  -- spatial index on properties.geom (reference declares it as
  -- GEOMETRY; we cast to geography for meter semantics).
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
  all_pair_ids AS (
    SELECT a_id, b_id FROM building_pairs
    UNION
    SELECT a_id, b_id FROM geo_pairs
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
  -- Same cap pattern as mig 037: ordered subquery + LIMIT before the
  -- INSERT, then ON CONFLICT to absorb pair-identity collisions
  -- (UNION already dedupes a_id/b_id, but the table-level constraint
  -- is the canonical guard).
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
  -- Same lower-bound surfacing pattern as mig 037 — we don't carry an
  -- exact pair-evaluation count out of the INSERT.
  v_evaluated := v_inserted;

  inserted_count  := v_inserted;
  evaluated_pairs := v_evaluated;
  RETURN NEXT;
END;
$$;


-- =====================================================================
-- 2. Governance update
-- =====================================================================
-- Re-stamp the existing contract so consumers see the description
-- update; rest of the row is unchanged.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RAISE NOTICE 'governance_schema_contracts not present; skipping update.';
    RETURN;
  END IF;

  UPDATE public.governance_schema_contracts
     SET description =
           'Deterministic detector. Two-pass: within-building + GPS proximity ≤ 50m on properties.geom. Threshold confidence 50. Weights re-balanced in mig 20260510000002 (same signature, same return shape).',
         updated_at = now()
   WHERE contract_name = 'public.find_listing_duplicate_candidates';
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste in the SQL editor.
-- Per feedback_smoke_sql_no_placeholders: subqueries, no `'...'`.
-- =====================================================================
--
-- 1) Function shape unchanged (still 2 args / 2-col table return).
-- SELECT proname, pg_get_function_identity_arguments(oid) AS args,
--        pg_get_function_result(oid) AS result
--   FROM pg_proc
--  WHERE proname = 'find_listing_duplicate_candidates';
--
-- 2) Recent pass — emits within minutes of a recent listing edit.
--    Run twice; first run inserts, second is ON CONFLICT no-op.
-- SELECT * FROM public.find_listing_duplicate_candidates(true, 100);
--
-- 3) Inspect the new signal keys on freshly inserted rows.
-- SELECT id, confidence, signals, detected_run, detected_at
--   FROM public.listing_duplicate_candidates
--  WHERE detected_run = 'recent_30min'
--  ORDER BY detected_at DESC
--  LIMIT 5;
--
-- 4) Cross-building GPS pair — find any pair caught by the geo pass
--    but NOT by the within-building pass. Demonstrates the new scope.
-- SELECT c.id, c.a_listing_id, c.b_listing_id, c.confidence,
--        c.signals->>'gps_proximity'  AS gps_signal,
--        c.signals->>'address_trgm'   AS addr_signal,
--        la.building_id AS a_building, lb.building_id AS b_building
--   FROM public.listing_duplicate_candidates c
--   JOIN public.listings la ON la.id = c.a_listing_id
--   JOIN public.listings lb ON lb.id = c.b_listing_id
--  WHERE (c.signals->>'gps_proximity')::int > 0
--    AND (la.building_id IS DISTINCT FROM lb.building_id
--         OR la.building_id IS NULL OR lb.building_id IS NULL)
--  ORDER BY c.detected_at DESC
--  LIMIT 10;
