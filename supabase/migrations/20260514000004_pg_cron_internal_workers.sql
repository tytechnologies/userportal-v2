-- pg_cron schedules for the new internal worker endpoints.
--
-- Three jobs:
--   1. normalize_raw_batch     every  5 min   POST /api/internal/normalize-raw-batch
--   2. index_search_queue      every  2 min   POST /api/internal/index-search-queue
--   3. expire_live_search      daily 03:00 UTC SELECT expire_live_search_cache(30)
--
-- All three reuse the singleton `internal_config` table (mig
-- 20260506000007) for URL + secret. To keep the table shape flat, we
-- add ONE new column — `portal_base_url` — and each cron command
-- builds its endpoint URL by concatenating the path. The existing
-- `digest_cron_secret` column is reused as the shared internal-cron
-- secret (semantically broader now; same value).
--
-- Conditional:
--   - pg_cron + pg_net must both be enabled. If either is missing the
--     migration RAISE NOTICE-s and exits cleanly — re-run after
--     enabling them in Supabase (Database → Extensions).
--   - The schedules are still installed even if portal_base_url is
--     NULL — the cron commands themselves skip work in that case (fail-
--     closed). This avoids a chicken-and-egg between schema and ops.
--
-- Idempotent — any pre-existing job with the same name is unscheduled
-- before re-scheduling.
--
-- ROLLBACK:
--   DO $$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       PERFORM cron.unschedule('normalize_raw_batch_5m');
--       PERFORM cron.unschedule('index_search_queue_2m');
--       PERFORM cron.unschedule('expire_live_search_cache_daily');
--     END IF;
--   END $$;
--   ALTER TABLE public.internal_config DROP COLUMN IF EXISTS portal_base_url;


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='internal_config') THEN
    RAISE EXCEPTION
      'Migration 20260514000004 requires public.internal_config (mig 20260506000007)'
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. Add portal_base_url to internal_config (additive)
-- =====================================================================

ALTER TABLE public.internal_config
  ADD COLUMN IF NOT EXISTS portal_base_url text;

COMMENT ON COLUMN public.internal_config.portal_base_url IS
  'Base URL of the userportal (e.g. https://portal.housinginteractive.com.ph). Used by pg_cron internal-worker jobs to construct their endpoint URLs. Leave NULL to fail-closed (cron jobs skip work). Must NOT include a trailing slash.';


-- =====================================================================
-- 2. Conditional schedule installation
-- =====================================================================

DO $$
DECLARE
  v_has_cron boolean;
  v_has_net  boolean;
  v_exists   bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO v_has_cron;
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')  INTO v_has_net;

  IF NOT v_has_cron OR NOT v_has_net THEN
    RAISE NOTICE
      'pg_cron=% pg_net=%. Both extensions are required to schedule the internal-worker jobs. Skipping schedule install — re-run this migration after enabling them in Supabase (Database → Extensions).',
      v_has_cron, v_has_net;
    RETURN;
  END IF;

  -- ---- 2a. normalize_raw_batch ------------------------------------
  SELECT count(*) INTO v_exists FROM cron.job WHERE jobname = 'normalize_raw_batch_5m';
  IF v_exists > 0 THEN PERFORM cron.unschedule('normalize_raw_batch_5m'); END IF;

  PERFORM cron.schedule(
    'normalize_raw_batch_5m',
    '*/5 * * * *',
    $cron$
      WITH cfg AS (
        SELECT portal_base_url, digest_cron_secret
          FROM public.internal_config WHERE id = 1
      )
      SELECT CASE
        WHEN cfg.portal_base_url IS NULL OR cfg.digest_cron_secret IS NULL THEN NULL
        ELSE (
          SELECT net.http_post(
            url     := cfg.portal_base_url || '/api/internal/normalize-raw-batch',
            headers := jsonb_build_object(
              'content-type',      'application/json',
              'x-internal-secret', cfg.digest_cron_secret
            ),
            body    := jsonb_build_object('max', 200),
            timeout_milliseconds := 60000
          )::text
        )
      END
      FROM cfg;
    $cron$
  );

  -- ---- 2b. index_search_queue -------------------------------------
  SELECT count(*) INTO v_exists FROM cron.job WHERE jobname = 'index_search_queue_2m';
  IF v_exists > 0 THEN PERFORM cron.unschedule('index_search_queue_2m'); END IF;

  PERFORM cron.schedule(
    'index_search_queue_2m',
    '*/2 * * * *',
    $cron$
      WITH cfg AS (
        SELECT portal_base_url, digest_cron_secret
          FROM public.internal_config WHERE id = 1
      )
      SELECT CASE
        WHEN cfg.portal_base_url IS NULL OR cfg.digest_cron_secret IS NULL THEN NULL
        ELSE (
          SELECT net.http_post(
            url     := cfg.portal_base_url || '/api/internal/index-search-queue',
            headers := jsonb_build_object(
              'content-type',      'application/json',
              'x-internal-secret', cfg.digest_cron_secret
            ),
            body    := jsonb_build_object('max', 200),
            timeout_milliseconds := 60000
          )::text
        )
      END
      FROM cfg;
    $cron$
  );

  -- ---- 2c. expire_live_search_cache -------------------------------
  -- This one is a direct RPC, not an HTTP call — the function is in
  -- the same DB and SECURITY DEFINER. Less moving parts.
  SELECT count(*) INTO v_exists FROM cron.job WHERE jobname = 'expire_live_search_cache_daily';
  IF v_exists > 0 THEN PERFORM cron.unschedule('expire_live_search_cache_daily'); END IF;

  PERFORM cron.schedule(
    'expire_live_search_cache_daily',
    '0 3 * * *',
    $cron$ SELECT public.expire_live_search_cache(30); $cron$
  );

  RAISE NOTICE
    'Scheduled internal workers — normalize_raw_batch (5m), index_search_queue (2m), expire_live_search_cache (daily 03:00 UTC). Set internal_config.portal_base_url + digest_cron_secret to activate the HTTP workers.';
END
$$;


-- =====================================================================
-- 3. Refresh PostgREST schema cache
-- =====================================================================

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste in SQL editor.
-- =====================================================================
-- 1) Jobs scheduled.
-- SELECT jobname, schedule, active FROM cron.job
--  WHERE jobname IN (
--    'normalize_raw_batch_5m',
--    'index_search_queue_2m',
--    'expire_live_search_cache_daily',
--    'saved_search_digest_daily'
--  ) ORDER BY jobname;
--
-- 2) Activate the HTTP workers by setting portal_base_url + the secret:
-- UPDATE public.internal_config
--    SET portal_base_url    = 'https://YOUR-PORTAL.example.com',
--        digest_cron_secret = '<INTERNAL_CRON_SECRET value>'
--  WHERE id = 1;
--
-- 3) Last 10 cron runs:
-- SELECT jobname, status, return_message, start_time, end_time
--   FROM cron.job_run_details
--  ORDER BY start_time DESC
--  LIMIT 10;
--
-- 4) Manual fire from the SQL editor (no waiting for next tick):
-- WITH cfg AS (
--   SELECT portal_base_url, digest_cron_secret FROM public.internal_config WHERE id = 1
-- )
-- SELECT net.http_post(
--   url     := cfg.portal_base_url || '/api/internal/normalize-raw-batch',
--   headers := jsonb_build_object('content-type','application/json',
--                                 'x-internal-secret', cfg.digest_cron_secret),
--   body    := jsonb_build_object('max', 50)
-- ) FROM cfg;
