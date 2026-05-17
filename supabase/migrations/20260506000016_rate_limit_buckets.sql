-- Rate-limit infrastructure shared across public POST endpoints.
--
-- Database-resident so multi-instance Nuxt deploys see the same
-- counts. Atomic UPSERT pattern: each call either increments the
-- existing bucket (same window) or resets it (window elapsed).
--
-- Wrapped by server/utils/rate-limit.ts. First consumers:
--   - /api/public/inquiries           (10/hr/IP)
--   - /api/public/saved-searches      (5/hr/IP)
-- More can opt in by calling check_rate_limit(key, max, window_seconds)
-- with a stable key (typically `<surface>:<client_ip>`).
--
-- Failure mode: the wrapper fails OPEN on RPC error. Better to over-
-- serve than to DOS ourselves with a flaky rate limiter.
--
-- Bucket lifecycle: daily cron deletes buckets whose updated_at is
-- older than 7 days. Bounds table growth at the cost of forgetting
-- abusers who go quiet for >7 days (acceptable; they re-trip).
--
-- ROLLBACK:
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       PERFORM cron.unschedule('rate_limit_buckets_cleanup_daily');
--     END IF;
--   END $$;
--   DROP FUNCTION IF EXISTS public.check_rate_limit(text, integer, integer);
--   DROP TABLE IF EXISTS public.rate_limit_buckets;


-- =====================================================================
-- 1. Bucket table
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key         text PRIMARY KEY,
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  request_count      integer NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- For the cleanup cron + observability ("show me hot buckets right now").
CREATE INDEX IF NOT EXISTS rate_limit_buckets_updated_at_idx
  ON public.rate_limit_buckets(updated_at);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
-- No policies — accessed only via the SECURITY DEFINER RPC below.

COMMENT ON TABLE public.rate_limit_buckets IS
  'Database-resident rate-limit counters. One row per (surface, client) bucket. Read/write via check_rate_limit() RPC only — no direct CRUD.';


-- =====================================================================
-- 2. check_rate_limit RPC
-- =====================================================================
--
-- Returns jsonb:
--   {
--     "allowed":            boolean,
--     "count":              integer,   -- after this call
--     "limit":              integer,   -- echoed back for clarity
--     "window_started_at":  timestamptz,
--     "reset_at":           timestamptz  -- when this window expires
--   }
--
-- Atomicity: INSERT … ON CONFLICT … DO UPDATE is one statement, run as
-- a single MVCC operation. Concurrent calls for the same key serialize
-- on the row lock; their increments compose correctly.
--
-- Window semantics: if the existing bucket's window started before
-- (now - window_seconds), reset it. Otherwise increment. Means a burst
-- can spend its budget in any sub-window of the rolling timer; that's
-- the intent of fixed-window rate limiting (vs. true sliding-window
-- which would cost more state per bucket).

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key             text,
  p_max             integer,
  p_window_seconds  integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now            timestamptz := now();
  v_window_cutoff  timestamptz := v_now - make_interval(secs => p_window_seconds);
  v_row            public.rate_limit_buckets%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) = 0 THEN
    -- Defensive: empty keys are always-allowed (no aggregation possible).
    RETURN jsonb_build_object(
      'allowed', true,
      'count', 0,
      'limit', p_max,
      'window_started_at', v_now,
      'reset_at', v_now
    );
  END IF;

  -- Clamp insane inputs to avoid pathological windows / counts.
  IF p_max <= 0 THEN p_max := 1; END IF;
  IF p_window_seconds <= 0 THEN p_window_seconds := 60; END IF;
  IF p_window_seconds > 86400 THEN p_window_seconds := 86400; END IF;

  INSERT INTO public.rate_limit_buckets (
    bucket_key, window_started_at, request_count, updated_at
  )
  VALUES (p_key, v_now, 1, v_now)
  ON CONFLICT (bucket_key) DO UPDATE
    SET window_started_at = CASE
          WHEN public.rate_limit_buckets.window_started_at < v_window_cutoff
            THEN v_now
          ELSE public.rate_limit_buckets.window_started_at
        END,
        request_count = CASE
          WHEN public.rate_limit_buckets.window_started_at < v_window_cutoff
            THEN 1
          ELSE public.rate_limit_buckets.request_count + 1
        END,
        updated_at = v_now
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'allowed',           v_row.request_count <= p_max,
    'count',             v_row.request_count,
    'limit',             p_max,
    'window_started_at', v_row.window_started_at,
    'reset_at',          v_row.window_started_at + make_interval(secs => p_window_seconds)
  );
END
$$;

COMMENT ON FUNCTION public.check_rate_limit(text, integer, integer) IS
  'Atomic fixed-window rate limit. Returns jsonb { allowed, count, limit, window_started_at, reset_at }. Empty key short-circuits to allowed. Window auto-resets after window_seconds elapsed. Server-side wrappers should fail-open on RPC error.';

REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer)
  TO authenticated, service_role, anon;
-- anon grant: public POST endpoints typically run with the anon /
-- service-role server client. The function is safe — it only mutates
-- one row keyed by the caller-provided key, returns derived stats.


-- =====================================================================
-- 3. Daily cleanup cron
-- =====================================================================

DO $$
DECLARE
  v_jobname constant text := 'rate_limit_buckets_cleanup_daily';
  v_exists  bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled; skipping bucket cleanup schedule.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_exists FROM cron.job WHERE jobname = v_jobname;
  IF v_exists > 0 THEN
    PERFORM cron.unschedule(v_jobname);
  END IF;

  -- 02:00 UTC daily — outside the digest (22:00) and archive (23:00)
  -- windows. Cleanup is cheap (bounded by row count which is bounded
  -- by 7 days of distinct-IP traffic).
  PERFORM cron.schedule(
    v_jobname,
    '0 2 * * *',
    $cron$
      DELETE FROM public.rate_limit_buckets
       WHERE updated_at < now() - interval '7 days';
    $cron$
  );

  RAISE NOTICE 'Scheduled %: nightly cleanup at 02:00 UTC.', v_jobname;
END
$$;
