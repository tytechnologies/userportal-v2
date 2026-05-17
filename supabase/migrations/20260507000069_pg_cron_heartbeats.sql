-- pg_cron worker heartbeats.
--
-- Wraps existing pg_cron-driven workers so they record an
-- ops_worker_heartbeats row each tick. The cron job is then
-- rescheduled to call the wrapper instead of the underlying RPC.
--
-- Wrapper pattern:
--   * SECURITY DEFINER so cron runs (postgres role) can write
--     heartbeats without needing extra grants.
--   * Calls the underlying RPC inside a BEGIN/EXCEPTION so a single
--     bad run still records its failure as a heartbeat — the operator
--     sees runs_last_hour stay non-zero even when the work failed.
--
-- Schedules wired here:
--   charge_due_reminders        — daily 09:00 UTC (already existed; rescheduled to wrapper)
--   platform_fee_settlement     — monthly day 1 02:00 UTC (NEW)
--
-- commission_ledger_sweep:
--   The registry references this worker_key but there is no
--   underlying RPC yet (the commission_ledger table itself is the
--   source of truth and doesn't need a sweep today). Left out
--   intentionally; will surface as "never_seen" in the runbook
--   until a real sweep exists.
--
-- ROLLBACK:
--   SELECT cron.unschedule('charge_due_reminders_with_heartbeat')
--     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'charge_due_reminders_with_heartbeat');
--   SELECT cron.unschedule('platform_fee_settlement_monthly')
--     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'platform_fee_settlement_monthly');
--   DROP FUNCTION IF EXISTS public.cron_charge_due_reminders_tick();
--   DROP FUNCTION IF EXISTS public.cron_platform_fee_settlement_tick();


-- =====================================================================
-- charge_due_reminders wrapper
-- =====================================================================

CREATE OR REPLACE FUNCTION public.cron_charge_due_reminders_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_started_at  timestamptz := clock_timestamp();
  v_result      jsonb;
  v_status      text := 'ok';
  v_err         text;
BEGIN
  BEGIN
    v_result := public.enqueue_due_charge_reminders();
  EXCEPTION WHEN others THEN
    v_status := 'failed';
    v_err    := SQLERRM;
    v_result := jsonb_build_object('error', v_err);
  END;

  PERFORM public.record_worker_heartbeat(
    'charge_due_reminders',
    jsonb_build_object(
      'status',     v_status,
      'elapsed_ms', (extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::int,
      'result',     v_result
    )
  );

  IF v_status = 'failed' THEN
    -- Re-raise so cron.job_run_details captures the failure too —
    -- heartbeat already recorded so the runbook sees it either way.
    RAISE EXCEPTION 'cron_charge_due_reminders_tick failed: %', v_err;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.cron_charge_due_reminders_tick() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cron_charge_due_reminders_tick() TO service_role;


-- Reschedule the existing job to call the wrapper.
DO $$
BEGIN
  PERFORM cron.unschedule('property_charges_due_reminders_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'property_charges_due_reminders_daily');
  PERFORM cron.unschedule('charge_due_reminders_with_heartbeat')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'charge_due_reminders_with_heartbeat');
  PERFORM cron.schedule(
    'charge_due_reminders_with_heartbeat',
    '0 9 * * *',
    $cron$ SELECT public.cron_charge_due_reminders_tick(); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'charge_due_reminders cron: pg_cron unavailable';
END $$;


-- =====================================================================
-- platform_fee_settlement wrapper (NEW schedule)
-- =====================================================================
--
-- Runs on the 1st of each month at 02:00 UTC, settling fees for the
-- previous month. Period_end = last day of previous month so all
-- the prior month's deals are captured.

CREATE OR REPLACE FUNCTION public.cron_platform_fee_settlement_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_started_at timestamptz := clock_timestamp();
  v_period_end date;
  v_result     jsonb;
  v_status     text := 'ok';
  v_err        text;
BEGIN
  -- Last day of previous month, in UTC.
  v_period_end := (date_trunc('month', current_date AT TIME ZONE 'UTC') - interval '1 day')::date;

  BEGIN
    v_result := public.platform_fee_settlement_run(v_period_end);
  EXCEPTION WHEN others THEN
    v_status := 'failed';
    v_err    := SQLERRM;
    v_result := jsonb_build_object('error', v_err);
  END;

  PERFORM public.record_worker_heartbeat(
    'platform_fee_settlement',
    jsonb_build_object(
      'status',     v_status,
      'period_end', v_period_end,
      'elapsed_ms', (extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::int,
      'result',     v_result
    )
  );

  IF v_status = 'failed' THEN
    RAISE EXCEPTION 'cron_platform_fee_settlement_tick failed: %', v_err;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.cron_platform_fee_settlement_tick() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cron_platform_fee_settlement_tick() TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('platform_fee_settlement_monthly')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'platform_fee_settlement_monthly');
  PERFORM cron.schedule(
    'platform_fee_settlement_monthly',
    '0 2 1 * *',
    $cron$ SELECT public.cron_platform_fee_settlement_tick(); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'platform_fee_settlement cron: pg_cron unavailable';
END $$;


COMMENT ON FUNCTION public.cron_charge_due_reminders_tick() IS
  'pg_cron tick wrapper: calls enqueue_due_charge_reminders() and writes ops_worker_heartbeats.';
COMMENT ON FUNCTION public.cron_platform_fee_settlement_tick() IS
  'pg_cron tick wrapper: settles platform fees for the previous month and writes ops_worker_heartbeats.';


NOTIFY pgrst, 'reload schema';
