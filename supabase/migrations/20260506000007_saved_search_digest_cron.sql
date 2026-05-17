-- Daily auto-trigger for the saved-search digest worker.
--
-- Schedules a pg_cron job that POSTs to
-- /api/admin/saved-searches/run-digest with the INTERNAL_CRON_SECRET
-- in the x-internal-secret header. The endpoint accepts that as a
-- bypass for the admin-JWT auth check (see run-digest.post.ts).
--
-- Schedule: 22:00 UTC daily = 06:00 PHT — gets the "what's new this
-- morning" digests into inboxes before the workday starts. Daily
-- cadence covers both 'daily' and 'weekly' subscriptions; the
-- in-endpoint cadence filter (saved_searches_due_for_digest) decides
-- whether each row actually fires.
--
-- Configuration (URL + secret) lives in a one-row `internal_config`
-- table so the cron command stays a static string. To rotate either:
--   UPDATE public.internal_config
--      SET digest_endpoint_url = '...', digest_cron_secret = '...';
-- No re-scheduling required — pg_cron picks up the new values on next
-- tick.
--
-- Conditional installation:
--   - pg_cron must be enabled (Database → Extensions in Supabase).
--   - pg_net must be enabled (Database → Extensions; provides http_post).
-- If either is missing the migration emits a NOTICE and exits cleanly.
-- Re-run after enabling.
--
-- Idempotent: prior job with the same name is unscheduled before
-- re-scheduling. Re-running the migration is safe.
--
-- ROLLBACK:
--   DO $$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       PERFORM cron.unschedule('saved_search_digest_daily');
--     END IF;
--   END $$;
--   DROP TABLE IF EXISTS public.internal_config;
--
-- DEPENDS ON:
--   20260506000005_saved_search_subscriptions.sql
--   20260506000006_saved_searches_due_function.sql

-- =====================================================================
-- 1. Internal config table (URL + secret for cron-triggered endpoints)
-- =====================================================================
--
-- Singleton: id = 1 always. RLS enabled with no policies — service-role
-- only. The cron job runs as the cron extension's owner (typically
-- postgres), which bypasses RLS, so the read works.
--
-- Seeded with NULLs by the migration; ops sets the real values via:
--   UPDATE public.internal_config
--      SET digest_endpoint_url = 'https://app.housinginteractive.com.ph/api/admin/saved-searches/run-digest',
--          digest_cron_secret  = '<32-byte-hex-secret>';
--
-- The cron job's pg_net.http_post call SKIPS the call if either field
-- is NULL — fail-closed. Logs a NOTICE so the gap is visible.

CREATE TABLE IF NOT EXISTS public.internal_config (
  id                    smallint PRIMARY KEY DEFAULT 1
                        CHECK (id = 1),
  digest_endpoint_url   text,
  digest_cron_secret    text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.internal_config ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.

-- Seed singleton row if not present.
INSERT INTO public.internal_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.internal_config IS
  'Singleton config for internal scheduled-job triggers (pg_cron → portal endpoints). RLS no-policies; service-role only. Set digest_endpoint_url + digest_cron_secret post-migration.';


-- =====================================================================
-- 2. Conditional pg_cron schedule
-- =====================================================================

DO $$
DECLARE
  v_jobname constant text := 'saved_search_digest_daily';
  v_exists  bigint;
  v_has_cron boolean;
  v_has_net  boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO v_has_cron;
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')  INTO v_has_net;

  IF NOT v_has_cron OR NOT v_has_net THEN
    RAISE NOTICE
      'pg_cron=% pg_net=%. Both extensions are required for the saved-search digest auto-schedule. Skipping. Enable both via Supabase Dashboard (Database → Extensions) and re-run this migration.',
      v_has_cron,
      v_has_net;
    RETURN;
  END IF;

  -- Idempotent: drop any prior job with the same name.
  SELECT count(*) INTO v_exists FROM cron.job WHERE jobname = v_jobname;
  IF v_exists > 0 THEN
    PERFORM cron.unschedule(v_jobname);
  END IF;

  -- Schedule: 22:00 UTC daily (= 06:00 PHT). The cron command is a
  -- single SELECT that reads the URL + secret from internal_config and
  -- fires pg_net.http_post if both are populated. SECURITY DEFINER on
  -- pg_net.http_post lets it execute under the cron job owner's
  -- privileges; no extra GRANTs needed.
  --
  -- pg_net is async — the call enqueues the request and returns
  -- immediately. Status / response can be inspected via
  -- net.http_request_queue / net._http_response.
  PERFORM cron.schedule(
    v_jobname,
    '0 22 * * *',
    $cron$
      WITH cfg AS (
        SELECT digest_endpoint_url, digest_cron_secret
        FROM public.internal_config
        WHERE id = 1
      )
      SELECT
        CASE
          WHEN cfg.digest_endpoint_url IS NULL OR cfg.digest_cron_secret IS NULL THEN
            -- Fail-closed: log and skip if config not seeded.
            NULL
          ELSE
            (
              SELECT net.http_post(
                url     := cfg.digest_endpoint_url,
                headers := jsonb_build_object(
                  'content-type',      'application/json',
                  'x-internal-secret', cfg.digest_cron_secret
                ),
                body    := jsonb_build_object('dryRun', false),
                timeout_milliseconds := 60000
              )::text
            )
        END
      FROM cfg;
    $cron$
  );

  RAISE NOTICE
    'Scheduled %: daily at 22:00 UTC (06:00 PHT). Set internal_config.digest_endpoint_url + digest_cron_secret to activate.',
    v_jobname;
END
$$;
