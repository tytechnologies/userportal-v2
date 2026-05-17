-- Materialized-view refresh coalescer.
--
-- Today, `refreshListingDetails()` (server/utils/refresh-listing-details.ts)
-- calls `public.refresh_listing_details()` synchronously after every
-- write that might change MV contents: every ingest batch, every
-- merge, every promote-primary, etc. Under parallel partner traffic
-- this serializes ingest throughput on the refresh lock — a 500-row
-- batch from 4 partners pushing simultaneously costs 4×refresh time.
--
-- This migration adds a debouncer:
--
--   request_listing_details_refresh()  — sub-ms UPDATE of a single
--                                        coalescer row. Ingest paths
--                                        call this instead of doing
--                                        the refresh inline.
--   process_listing_details_refresh()  — the worker. Called by
--                                        pg_cron every 30s. Checks
--                                        the coalescer flag; if any
--                                        requests are pending,
--                                        performs ONE refresh call
--                                        and clears the flag.
--
-- The 5-minute periodic refresh from mig 20260506000002 stays as a
-- safety net — if cron / pg_net misfires, the periodic tick
-- guarantees freshness within the SLO. Under normal load the
-- coalescer's 30s cycle dominates and the periodic refresh is a
-- frequent no-op (refresh_listing_details() short-circuits when
-- listings.max_updated_at <= listing_details.max_updated_at).
--
-- Strictly additive. No existing tables / functions modified. The
-- existing refresh_listing_details() (declared in
-- db-main-reference/custom_functions.sql) is unchanged — the
-- coalescer just batches CALLS to it.
--
-- ROLLBACK:
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       PERFORM cron.unschedule('process_listing_details_refresh_30s')
--         WHERE EXISTS (SELECT 1 FROM cron.job
--                        WHERE jobname = 'process_listing_details_refresh_30s');
--     END IF;
--   END $$;
--   DROP FUNCTION IF EXISTS public.process_listing_details_refresh();
--   DROP FUNCTION IF EXISTS public.request_listing_details_refresh();
--   DROP TABLE IF EXISTS public.mv_refresh_coalescer;
--
-- DEPENDS ON:
--   db-main-reference/custom_functions.sql  (refresh_listing_details)


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines
                  WHERE routine_schema='public'
                    AND routine_name='refresh_listing_details') THEN
    RAISE EXCEPTION
      'Migration 20260513000004 requires public.refresh_listing_details (db-main-reference/custom_functions.sql).'
      USING ERRCODE = '42883';
  END IF;
END $$;


-- =====================================================================
-- 1. Coalescer table
-- =====================================================================
-- Single row per MV. Future MVs (e.g. amenities_usage from
-- db-main-reference/materialized_views.sql) can join the same
-- pattern by inserting a row with their name.

CREATE TABLE IF NOT EXISTS public.mv_refresh_coalescer (
  mv_name              text PRIMARY KEY,
  refresh_requested_at timestamptz,
  last_refreshed_at    timestamptz,
  request_count        int NOT NULL DEFAULT 0,
  last_run_ms          int,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.mv_refresh_coalescer (mv_name)
VALUES ('listing_details')
ON CONFLICT (mv_name) DO NOTHING;

ALTER TABLE public.mv_refresh_coalescer ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mv_refresh_coalescer_admin ON public.mv_refresh_coalescer;
CREATE POLICY mv_refresh_coalescer_admin ON public.mv_refresh_coalescer FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));
-- service_role bypasses RLS — cron worker uses it.

COMMENT ON TABLE public.mv_refresh_coalescer IS
  'Coalescer for MV refresh requests. Writers flip refresh_requested_at via request_listing_details_refresh(); cron worker drains via process_listing_details_refresh() every 30s.';


-- =====================================================================
-- 2. request_listing_details_refresh()
-- =====================================================================
-- The cheap path. Single UPDATE; sub-ms under any realistic load.
-- COALESCE keeps refresh_requested_at pinned to the FIRST request
-- in this debounce window so we can measure debounce latency
-- (time between first request and actual refresh).
--
-- SECURITY DEFINER + grant to authenticated so any operator-facing
-- write path can call it without role gymnastics. The function does
-- ONE bounded UPDATE — no abuse vector beyond inflating request_count.

CREATE OR REPLACE FUNCTION public.request_listing_details_refresh()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.mv_refresh_coalescer
     SET refresh_requested_at = COALESCE(refresh_requested_at, now()),
         request_count        = request_count + 1,
         updated_at           = now()
   WHERE mv_name = 'listing_details';
END
$$;

REVOKE ALL ON FUNCTION public.request_listing_details_refresh() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_listing_details_refresh()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.request_listing_details_refresh() IS
  'Sub-ms request to refresh listing_details. Coalesced + debounced; the actual refresh runs via process_listing_details_refresh on the next 30s cron tick.';


-- =====================================================================
-- 3. process_listing_details_refresh()
-- =====================================================================
-- The drain. Runs from cron every 30s OR can be invoked manually by
-- admins for an immediate sweep.
--
-- Returns a jsonb summary so the cron log surfaces useful detail:
--   { refreshed, coalesced, duration_ms, last_request_age_ms }
--
-- Idempotent — calling it when nothing is pending is a cheap no-op
-- (SELECT-only path returns immediately).

CREATE OR REPLACE FUNCTION public.process_listing_details_refresh()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_requested_at timestamptz;
  v_request_count int;
  v_started_at timestamptz;
  v_duration_ms int;
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: process worker is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  -- FOR UPDATE so we don't race with a parallel cron tick on the
  -- same row — only one worker drains at a time.
  SELECT refresh_requested_at, request_count
    INTO v_requested_at, v_request_count
    FROM public.mv_refresh_coalescer
   WHERE mv_name = 'listing_details'
     FOR UPDATE;

  IF v_requested_at IS NULL THEN
    RETURN jsonb_build_object('refreshed', false, 'reason', 'no_pending');
  END IF;

  v_started_at := clock_timestamp();

  -- Existing reference function. Self-conditional: short-circuits
  -- when listings.max_updated_at <= listing_details.max_updated_at,
  -- so even if request_count > 0 from a no-op-update path this is
  -- still cheap.
  PERFORM public.refresh_listing_details();

  v_duration_ms := (extract(epoch FROM clock_timestamp() - v_started_at) * 1000)::int;

  UPDATE public.mv_refresh_coalescer
     SET refresh_requested_at = NULL,
         last_refreshed_at    = now(),
         request_count        = 0,
         last_run_ms          = v_duration_ms,
         updated_at           = now()
   WHERE mv_name = 'listing_details';

  RETURN jsonb_build_object(
    'refreshed', true,
    'coalesced', v_request_count,
    'duration_ms', v_duration_ms,
    'last_request_age_ms', (extract(epoch FROM now() - v_requested_at) * 1000)::int
  );
END
$$;

REVOKE ALL ON FUNCTION public.process_listing_details_refresh() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_listing_details_refresh()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.process_listing_details_refresh() IS
  'Coalescer drain. Performs the actual refresh_listing_details() call iff a request is pending. Cron at 30s; admins may invoke for an immediate sweep.';


-- =====================================================================
-- 4. pg_cron schedule
-- =====================================================================
-- Every 30 seconds. pg_cron's minimum granularity is 1 minute via
-- the `* * * * *` syntax — we run twice per minute by scheduling
-- two jobs offset by 30s. Postgres + pg_cron 1.5+ supports the
-- `* * * * * */30` interval form on some installs but the
-- two-job pattern is portable.

DO $$
DECLARE
  v_jobname_a constant text := 'process_listing_details_refresh_30s_a';
  v_jobname_b constant text := 'process_listing_details_refresh_30s_b';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled; skipping MV-refresh coalescer schedule.';
    RETURN;
  END IF;

  -- Idempotent re-schedule.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_jobname_a) THEN
    PERFORM cron.unschedule(v_jobname_a);
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_jobname_b) THEN
    PERFORM cron.unschedule(v_jobname_b);
  END IF;

  -- Job A runs at second 0 of every minute (no extra delay).
  PERFORM cron.schedule(
    v_jobname_a,
    '* * * * *',
    $cron$ SELECT public.process_listing_details_refresh(); $cron$
  );

  -- Job B runs at second 0 too but uses pg_sleep(30) at the start
  -- so the effective fire is +30s. Cheap; only one DB connection
  -- held idle for half a minute.
  PERFORM cron.schedule(
    v_jobname_b,
    '* * * * *',
    $cron$ SELECT pg_sleep(30); SELECT public.process_listing_details_refresh(); $cron$
  );

  RAISE NOTICE 'Scheduled MV-refresh coalescer: % + % (every 30s).',
    v_jobname_a, v_jobname_b;
END
$$;


-- =====================================================================
-- 5. Governance
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
    ('public.mv_refresh_coalescer', 'table', 'userportal', ARRAY['userportal'],
     'Single-row-per-MV coalescer. refresh_requested_at pinned on first request in a debounce window.', false),
    ('public.request_listing_details_refresh', 'function', 'userportal', ARRAY['userportal'],
     'Cheap path for write-side code. UPDATE-only; sub-ms; called instead of direct refresh.', false),
    ('public.process_listing_details_refresh', 'function', 'userportal', ARRAY['userportal'],
     'Coalescer drain. Runs every 30s via pg_cron.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
--
-- 1) Coalescer row was seeded.
-- SELECT * FROM public.mv_refresh_coalescer;
--
-- 2) Cheap-path request flips the flag.
-- SELECT public.request_listing_details_refresh();
-- SELECT mv_name, refresh_requested_at, request_count
--   FROM public.mv_refresh_coalescer
--  WHERE mv_name = 'listing_details';
-- -- → refresh_requested_at NOT NULL, request_count = 1
--
-- 3) Multiple requests within a window coalesce into one pending state.
-- SELECT public.request_listing_details_refresh();
-- SELECT public.request_listing_details_refresh();
-- SELECT public.request_listing_details_refresh();
-- SELECT mv_name, refresh_requested_at, request_count
--   FROM public.mv_refresh_coalescer
--  WHERE mv_name = 'listing_details';
-- -- → refresh_requested_at unchanged (first request preserved), request_count = 4
--
-- 4) Drain — performs the refresh and returns a summary.
-- SELECT public.process_listing_details_refresh();
-- -- → { refreshed: true, coalesced: 4, duration_ms: ..., last_request_age_ms: ... }
--
-- 5) Second drain immediately after = no-op.
-- SELECT public.process_listing_details_refresh();
-- -- → { refreshed: false, reason: 'no_pending' }
--
-- 6) Cron is scheduled (both A and B jobs).
-- SELECT jobname, schedule, command
--   FROM cron.job
--  WHERE jobname LIKE 'process_listing_details_refresh_30s_%';
