-- source_health recorder RPC.
--
-- Mig 510000006 created public.source_health as a per-source SLO
-- rollup table but no writer populates it. This migration adds the
-- recorder RPC that the ingest endpoint (and any future source
-- worker) calls after each run. The state transitions are:
--
--   success run  → last_success_at = now()
--                  consecutive_failures = 0
--                  alert_state recomputed (likely → 'ok')
--                  avg_duration_ms ← EWMA blend with run duration
--
--   failure run  → last_failure_at = now()
--                  consecutive_failures += 1
--                  alert_state recomputed:
--                    consecutive_failures >= 3   → 'alert'
--                    consecutive_failures >= 1   → 'warning'
--                    consecutive_failures == 0   → 'ok'
--
--   rolling_success_pct ← simple ratio of (successes / total runs)
--                         over the last 50 ingest_runs for the source.
--
-- The RPC is SECURITY DEFINER so the cron-driven worker path can
-- record without role context. The escape clause per
-- feedback_security_definer_smoke_tests lets the SQL editor smoke-
-- test it as the operator.
--
-- Strictly additive. No tables / columns / FKs touched. source_health
-- table itself is unchanged.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.record_source_health(bigint, boolean, int);
--   DELETE FROM public.governance_schema_contracts
--    WHERE contract_name = 'public.record_source_health';


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='source_health') THEN
    RAISE EXCEPTION
      'Migration 20260513000003 requires public.source_health (mig 510000006).'
      USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listing_sources') THEN
    RAISE EXCEPTION
      'Migration 20260513000003 requires public.listing_sources (mig 506000013).'
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. record_source_health
-- =====================================================================
-- EWMA weight α=0.3 → recent runs influence avg_duration_ms quickly
-- without throwing away history entirely. Picked α=0.3 because at
-- typical partner sync cadence (every 5-30 min), a 4-hour outage's
-- 8-12 runs of zero duration would otherwise pull the average to
-- ~0 in a few hours; α=0.3 keeps a longer-term baseline visible.

CREATE OR REPLACE FUNCTION public.record_source_health(
  p_source_id   bigint,
  p_success     boolean,
  p_duration_ms int
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev               record;
  v_consecutive        int;
  v_avg_duration       int;
  v_alert_state        text;
  v_rolling_pct        numeric;
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: record_source_health is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  IF p_source_id IS NULL THEN
    RAISE EXCEPTION 'record_source_health: source_id is required'
      USING ERRCODE = '22023';
  END IF;

  -- Source must exist. We don't FK-check at write time because the
  -- table already has source_id PK REFERENCES listing_sources(id)
  -- with CASCADE — but we want a clear error for the operator if a
  -- stale id is passed.
  IF NOT EXISTS (SELECT 1 FROM public.listing_sources WHERE id = p_source_id) THEN
    RAISE EXCEPTION 'record_source_health: source % not found', p_source_id
      USING ERRCODE = '42704';
  END IF;

  -- Pull prior row (may not exist yet — first run on this source).
  SELECT consecutive_failures, avg_duration_ms
    INTO v_prev
    FROM public.source_health
   WHERE source_id = p_source_id;

  -- Recompute consecutive_failures.
  IF p_success THEN
    v_consecutive := 0;
  ELSE
    v_consecutive := COALESCE(v_prev.consecutive_failures, 0) + 1;
  END IF;

  -- EWMA blend. Drop NULL duration_ms onto the prior avg (no change).
  -- First run: just take the duration as-is.
  IF p_duration_ms IS NULL OR p_duration_ms < 0 THEN
    v_avg_duration := v_prev.avg_duration_ms;
  ELSIF v_prev.avg_duration_ms IS NULL THEN
    v_avg_duration := p_duration_ms;
  ELSE
    v_avg_duration := (0.3 * p_duration_ms + 0.7 * v_prev.avg_duration_ms)::int;
  END IF;

  -- Alert state recomputed from consecutive_failures.
  v_alert_state := CASE
    WHEN v_consecutive >= 3 THEN 'alert'
    WHEN v_consecutive >= 1 THEN 'warning'
    ELSE 'ok'
  END;

  -- Rolling success % over the last 50 runs for this source. Uses
  -- listing_source_ingest_runs (mig 507000001). The "errors_count = 0
  -- AND (inserted + updated) > 0" predicate is our success criterion;
  -- a run with all errors AND zero data movement is a failure even if
  -- the request itself returned 200.
  SELECT round(
           100.0 * (count(*) FILTER (
             WHERE errors_count = 0
               AND coalesce(inserted, 0) + coalesce(updated, 0) > 0
           ))::numeric / nullif(count(*), 0),
           1
         )
    INTO v_rolling_pct
    FROM (
      SELECT errors_count, inserted, updated
        FROM public.listing_source_ingest_runs
       WHERE source_id = p_source_id
       ORDER BY id DESC
       LIMIT 50
    ) recent;

  -- Upsert.
  INSERT INTO public.source_health AS sh (
    source_id, last_success_at, last_failure_at,
    consecutive_failures, rolling_success_pct, avg_duration_ms,
    alert_state, updated_at
  )
  VALUES (
    p_source_id,
    CASE WHEN p_success     THEN now() ELSE NULL END,
    CASE WHEN NOT p_success THEN now() ELSE NULL END,
    v_consecutive, v_rolling_pct, v_avg_duration,
    v_alert_state, now()
  )
  ON CONFLICT (source_id) DO UPDATE
     SET last_success_at      = CASE WHEN p_success
                                     THEN now()
                                     ELSE sh.last_success_at END,
         last_failure_at      = CASE WHEN NOT p_success
                                     THEN now()
                                     ELSE sh.last_failure_at END,
         consecutive_failures = v_consecutive,
         rolling_success_pct  = COALESCE(v_rolling_pct, sh.rolling_success_pct),
         avg_duration_ms      = COALESCE(v_avg_duration, sh.avg_duration_ms),
         alert_state          = v_alert_state,
         updated_at           = now();
END;
$$;

REVOKE ALL ON FUNCTION public.record_source_health(bigint, boolean, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_source_health(bigint, boolean, int)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.record_source_health(bigint, boolean, int) IS
  'Per-run SLO recorder. Updates public.source_health with last_*_at, consecutive_failures, rolling_success_pct (last 50 runs), avg_duration_ms (EWMA α=0.3), and alert_state. Called from /api/admin/listings/ingest after each batch.';


-- =====================================================================
-- 2. Governance
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RETURN;
  END IF;

  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('public.record_source_health', 'function', 'userportal', ARRAY['userportal'],
     'Per-run SLO recorder for source_health. Called after each /api/admin/listings/ingest batch.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
--
-- 1) Simulate a healthy run.
-- SELECT public.record_source_health(
--   (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1),
--   true, 250);
-- SELECT * FROM public.source_health
--  WHERE source_id = (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1);
--
-- 2) Simulate two consecutive failures → expect alert_state = 'warning'.
-- SELECT public.record_source_health(
--   (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1),
--   false, 5000);
-- SELECT public.record_source_health(
--   (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1),
--   false, 5000);
-- SELECT consecutive_failures, alert_state
--   FROM public.source_health
--  WHERE source_id = (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1);
--
-- 3) Third failure → 'alert'.
-- SELECT public.record_source_health(
--   (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1),
--   false, 5000);
-- SELECT consecutive_failures, alert_state
--   FROM public.source_health
--  WHERE source_id = (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1);
--
-- 4) Success → reset consecutive_failures to 0, alert_state to 'ok'.
-- SELECT public.record_source_health(
--   (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1),
--   true, 200);
-- SELECT consecutive_failures, alert_state, last_success_at, last_failure_at,
--        rolling_success_pct, avg_duration_ms
--   FROM public.source_health
--  WHERE source_id = (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1);
