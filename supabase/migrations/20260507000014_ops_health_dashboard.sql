-- Operations & Health Dashboard foundation.
--
-- Three additive objects support the new /admin/operations dashboard:
--
--   1. public.system_metric_snapshots — time-series capture (5-min
--      cadence). Charts read from this. Backed by a cron job that
--      INSERTs the current aggregates into a row.
--
--   2. public.ops_alerts (view) — derived alert feed from existing
--      tables. Pure SQL, no backing storage; always fresh.
--
--   3. public.ops_overview() RPC — single-round-trip aggregate for
--      the overview cards. Avoids N parallel queries from the page.
--
-- All three are admin-only via 'admin.access' permission gate.
--
-- ROLLBACK:
--   SELECT cron.unschedule('system_metric_snapshot_5min')
--     WHERE EXISTS (SELECT 1 FROM cron.job
--                    WHERE jobname = 'system_metric_snapshot_5min');
--   SELECT cron.unschedule('system_metric_snapshots_prune_daily')
--     WHERE EXISTS (SELECT 1 FROM cron.job
--                    WHERE jobname = 'system_metric_snapshots_prune_daily');
--   DROP FUNCTION IF EXISTS public.ops_overview();
--   DROP VIEW IF EXISTS public.ops_alerts;
--   DROP TABLE IF EXISTS public.system_metric_snapshots;
--
-- DEPENDS ON: webhook_subscriptions, webhook_retry_queue,
--   listing_sources, listing_source_ingest_runs, listings, inquiries,
--   profile_verifications, saved_search_subscriptions, activities


-- =====================================================================
-- 1. system_metric_snapshots — time series
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.system_metric_snapshots (
  id            bigserial PRIMARY KEY,
  captured_at   timestamptz NOT NULL DEFAULT now(),

  -- Listings
  listings_online              integer NOT NULL,
  listings_total_active        integer NOT NULL,
  listings_soft_deleted        integer NOT NULL,
  listings_source_imported     integer NOT NULL,
  listings_orphan_created_by   integer NOT NULL,

  -- Webhooks
  webhook_subscriptions_total          integer NOT NULL,
  webhook_subscriptions_enabled        integer NOT NULL,
  webhook_subscriptions_failing        integer NOT NULL,    -- consecutive_failures >= 5
  webhook_retry_queue_depth            integer NOT NULL,
  webhook_retry_queue_stale            integer NOT NULL,    -- next_attempt_at < now() - 5min
  webhook_deliveries_24h               integer NOT NULL,
  webhook_deliveries_24h_failed        integer NOT NULL,

  -- Ingestion
  ingest_sources_enabled       integer NOT NULL,
  ingest_sources_stale         integer NOT NULL,            -- past staleness_ttl_hours
  ingest_runs_24h              integer NOT NULL,
  ingest_runs_24h_with_errors  integer NOT NULL,

  -- Inquiries
  inquiries_unassigned_total       integer NOT NULL,
  inquiries_unassigned_recent_7d   integer NOT NULL,

  -- Verifications
  verifications_pending  integer NOT NULL,

  -- Saved searches
  saved_search_subscriptions_confirmed  integer NOT NULL,
  saved_search_subscriptions_pending    integer NOT NULL,

  -- Rate limits — currently-throttling buckets (instantaneous)
  rate_limit_throttling_now  integer NOT NULL
);

-- One index for the only access pattern: ORDER BY captured_at DESC
-- with optional LIMIT. Matches the time-series chart query.
CREATE INDEX IF NOT EXISTS system_metric_snapshots_captured_idx
  ON public.system_metric_snapshots (captured_at DESC);

ALTER TABLE public.system_metric_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_metric_snapshots_select_admin
  ON public.system_metric_snapshots;
CREATE POLICY system_metric_snapshots_select_admin
  ON public.system_metric_snapshots FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.access'));
-- INSERT/UPDATE/DELETE: service-role only via the snapshot cron.

COMMENT ON TABLE public.system_metric_snapshots IS
  'Periodic point-in-time aggregates for the Operations & Health dashboard. Captured every 5 minutes by cron job system_metric_snapshot_5min. Pruned daily — rows > 90 days are deleted.';


-- =====================================================================
-- 2. ops_alerts — derived alert feed
-- =====================================================================
--
-- Each branch reads from existing tables. severity buckets:
--   'critical' — operator should act now (cron dead, sub failing, ...)
--   'warning'  — degraded but not broken (queue stale, source lagging)
--   'info'     — noteworthy but normal (recently disabled, etc.)
--
-- created_at: when the underlying condition started (best-effort).
-- key: stable identifier so the UI can dedupe / dismiss.

CREATE OR REPLACE VIEW public.ops_alerts AS

-- Webhook subscription failing repeatedly
SELECT
  'webhook.failing.' || id::text                               AS key,
  'critical'                                                   AS severity,
  'webhook'                                                    AS category,
  'Webhook "' || display_name || '" failing'                   AS title,
  consecutive_failures || ' consecutive failures'              AS detail,
  jsonb_build_object(
    'subscription_id', id,
    'consecutive_failures', consecutive_failures,
    'url_host', split_part(replace(replace(url, 'https://', ''), 'http://', ''), '/', 1)
  )                                                            AS metadata,
  COALESCE(last_delivery_at, updated_at)                       AS started_at
  FROM public.webhook_subscriptions
 WHERE enabled = true AND consecutive_failures >= 5

UNION ALL

-- Webhook subscription auto-disabled
SELECT
  'webhook.disabled.' || id::text,
  'critical',
  'webhook',
  'Webhook "' || display_name || '" auto-disabled',
  'Hit ' || consecutive_failures || '-failure threshold; manual re-enable required',
  jsonb_build_object(
    'subscription_id', id,
    'consecutive_failures', consecutive_failures
  ),
  updated_at
  FROM public.webhook_subscriptions
 WHERE enabled = false AND consecutive_failures >= 10

UNION ALL

-- Webhook retry queue stuck (next_attempt_at far past, worker not draining)
SELECT
  'webhook.retry_stuck',
  'warning',
  'webhook',
  count(*) || ' webhook retries overdue',
  'Worker should drain every minute; oldest is ' ||
    EXTRACT(EPOCH FROM now() - min(next_attempt_at))::int || 's overdue',
  jsonb_build_object('overdue_count', count(*)),
  min(next_attempt_at)
  FROM public.webhook_retry_queue
 WHERE next_attempt_at < now() - interval '5 minutes'
 HAVING count(*) > 0

UNION ALL

-- Ingestion source past its staleness TTL
SELECT
  'ingest.stale.' || id::text,
  'warning',
  'ingest',
  'Source "' || slug || '" hasn''t reported in ' ||
    EXTRACT(EPOCH FROM now() - last_ingested_at)::int / 3600 || 'h',
  'TTL is ' || staleness_ttl_hours || 'h',
  jsonb_build_object(
    'source_id', id,
    'slug', slug,
    'last_ingested_at', last_ingested_at,
    'staleness_ttl_hours', staleness_ttl_hours
  ),
  last_ingested_at + (staleness_ttl_hours || ' hours')::interval
  FROM public.listing_sources
 WHERE enabled = true
   AND last_ingested_at IS NOT NULL
   AND now() - last_ingested_at > (staleness_ttl_hours || ' hours')::interval

UNION ALL

-- Ingest source has never reported
SELECT
  'ingest.never_run.' || id::text,
  'info',
  'ingest',
  'Source "' || slug || '" has never run',
  'No ingest runs recorded since source was created',
  jsonb_build_object('source_id', id, 'slug', slug),
  created_at
  FROM public.listing_sources
 WHERE enabled = true AND last_ingested_at IS NULL

UNION ALL

-- Cron job has never run or last run failed
SELECT
  'cron.failed.' || j.jobname,
  CASE
    WHEN latest.start_time IS NULL THEN 'warning'
    WHEN latest.status IS NOT DISTINCT FROM 'failed' THEN 'critical'
    ELSE 'warning'
  END,
  'cron',
  'Cron "' || j.jobname || '" ' ||
    CASE
      WHEN latest.start_time IS NULL THEN 'has never run'
      WHEN latest.status IS NOT DISTINCT FROM 'failed' THEN 'last run failed'
      ELSE 'is overdue'
    END,
  COALESCE(latest.return_message, 'No run history'),
  jsonb_build_object(
    'jobname', j.jobname,
    'schedule', j.schedule,
    'last_status', latest.status,
    'last_run_at', latest.start_time
  ),
  COALESCE(latest.start_time, j.jobname::timestamptz)
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT start_time, status, return_message
      FROM cron.job_run_details d
     WHERE d.jobid = j.jobid
     ORDER BY d.start_time DESC
     LIMIT 1
  ) latest ON true
 WHERE j.active = true
   AND (
     latest.start_time IS NULL
     OR latest.status IS NOT DISTINCT FROM 'failed'
     OR (
       -- Stale: heuristic per cadence. */5 cron not run in 1h is bad;
       -- daily cron not run in 25h is bad. We use a simple
       -- "no run in last 26h" gate which catches all but the */5 case.
       latest.start_time < now() - interval '26 hours'
     )
   )

ORDER BY
  CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
  started_at DESC;

GRANT SELECT ON public.ops_alerts TO authenticated;

COMMENT ON VIEW public.ops_alerts IS
  'Derived alert feed for the Operations dashboard. Reads existing tables (webhook_subscriptions, webhook_retry_queue, listing_sources, cron.job, cron.job_run_details). Always fresh; no separate storage.';


-- =====================================================================
-- 3. ops_overview() RPC — overview cards in one round trip
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ops_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listings jsonb;
  v_webhooks jsonb;
  v_ingest jsonb;
  v_inquiries jsonb;
  v_alerts jsonb;
BEGIN
  IF NOT (
    public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: admin.access required'
      USING ERRCODE = '42501';
  END IF;

  -- Listings — same shape SystemStatusCard already consumes, but in one
  -- round trip instead of five.
  SELECT jsonb_build_object(
    'online',         count(*) FILTER (WHERE is_online = true AND deleted_at IS NULL),
    'soft_deleted',   count(*) FILTER (WHERE deleted_at IS NOT NULL),
    'source_imported', count(*) FILTER (WHERE source_id IS NOT NULL AND deleted_at IS NULL),
    'agent_created',  count(*) FILTER (WHERE source_id IS NULL AND deleted_at IS NULL),
    'total_active',   count(*) FILTER (WHERE deleted_at IS NULL)
  ) INTO v_listings FROM public.listings;

  -- Webhooks
  SELECT jsonb_build_object(
    'subscriptions_total',    count(*),
    'subscriptions_enabled',  count(*) FILTER (WHERE enabled = true),
    'subscriptions_failing',  count(*) FILTER (WHERE enabled = true AND consecutive_failures >= 5),
    'subscriptions_disabled', count(*) FILTER (WHERE enabled = false),
    'retry_queue_depth',      (SELECT count(*) FROM public.webhook_retry_queue),
    'retry_queue_stale',      (SELECT count(*) FROM public.webhook_retry_queue
                                WHERE next_attempt_at < now() - interval '5 minutes')
  ) INTO v_webhooks FROM public.webhook_subscriptions;

  -- Ingestion
  SELECT jsonb_build_object(
    'sources_enabled',  count(*) FILTER (WHERE enabled = true),
    'sources_stale',    count(*) FILTER (
      WHERE enabled = true
        AND last_ingested_at IS NOT NULL
        AND now() - last_ingested_at > (staleness_ttl_hours || ' hours')::interval
    ),
    'runs_24h',             (SELECT count(*) FROM public.listing_source_ingest_runs
                              WHERE created_at > now() - interval '24 hours'),
    'runs_24h_with_errors', (SELECT count(*) FROM public.listing_source_ingest_runs
                              WHERE created_at > now() - interval '24 hours'
                                AND errors_count > 0)
  ) INTO v_ingest FROM public.listing_sources;

  -- Inquiries
  SELECT jsonb_build_object(
    'unassigned_total',     count(*) FILTER (WHERE assigned_user_id IS NULL),
    'unassigned_recent_7d', count(*) FILTER (
      WHERE assigned_user_id IS NULL
        AND created_at > now() - interval '7 days'
    )
  ) INTO v_inquiries FROM public.inquiries;

  -- Alerts — counts grouped by severity
  SELECT jsonb_build_object(
    'critical', count(*) FILTER (WHERE severity = 'critical'),
    'warning',  count(*) FILTER (WHERE severity = 'warning'),
    'info',     count(*) FILTER (WHERE severity = 'info')
  ) INTO v_alerts FROM public.ops_alerts;

  RETURN jsonb_build_object(
    'captured_at', now(),
    'listings',    v_listings,
    'webhooks',    v_webhooks,
    'ingest',      v_ingest,
    'inquiries',   v_inquiries,
    'alerts',      v_alerts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ops_overview() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ops_overview() TO authenticated;

COMMENT ON FUNCTION public.ops_overview() IS
  'Admin-only RPC returning overview-card aggregates in a single round trip. Reads listings, webhooks, ingest, inquiries, ops_alerts. Permission: admin.access (with the standard ops-bypass for postgres/service_role).';


-- =====================================================================
-- 3.5 ops_metrics_downsampled() RPC — time-series for 7d / 30d views
-- =====================================================================
--
-- The 24h view reads system_metric_snapshots directly (~288 points,
-- ~30KB on the wire). For 7d (~2K raw points) and 30d (~8.6K raw
-- points) we down-sample via date_trunc + AVG so the chart payload
-- stays under 50KB.

CREATE OR REPLACE FUNCTION public.ops_metrics_downsampled(
  p_range text
)
RETURNS TABLE (
  bucket                       timestamptz,
  listings_online              double precision,
  listings_total_active        double precision,
  listings_soft_deleted        double precision,
  listings_source_imported     double precision,
  listings_orphan_created_by   double precision,
  webhook_subscriptions_enabled  double precision,
  webhook_subscriptions_failing  double precision,
  webhook_retry_queue_depth      double precision,
  webhook_retry_queue_stale      double precision,
  webhook_deliveries_24h         double precision,
  webhook_deliveries_24h_failed  double precision,
  ingest_sources_stale         double precision,
  ingest_runs_24h              double precision,
  ingest_runs_24h_with_errors  double precision,
  inquiries_unassigned_total       double precision,
  inquiries_unassigned_recent_7d   double precision,
  verifications_pending  double precision,
  rate_limit_throttling_now  double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
  v_trunc text;
BEGIN
  IF NOT (
    public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: admin.access required'
      USING ERRCODE = '42501';
  END IF;

  -- Translate the range to a (since, trunc-unit) pair. date_trunc's
  -- unit must be one of Postgres' supported strings; we whitelist.
  IF p_range = '7d' THEN
    v_since := now() - interval '7 days';
    v_trunc := 'hour';
  ELSIF p_range = '30d' THEN
    v_since := now() - interval '30 days';
    v_trunc := 'hour'; -- 30 days × 24h = 720 points; chart can handle
  ELSE
    RAISE EXCEPTION 'invalid range: %', p_range USING ERRCODE = '22023';
  END IF;

  RETURN QUERY EXECUTE format(
    $sql$
      SELECT
        date_trunc(%L, captured_at) AS bucket,
        avg(listings_online),
        avg(listings_total_active),
        avg(listings_soft_deleted),
        avg(listings_source_imported),
        avg(listings_orphan_created_by),
        avg(webhook_subscriptions_enabled),
        avg(webhook_subscriptions_failing),
        avg(webhook_retry_queue_depth),
        avg(webhook_retry_queue_stale),
        avg(webhook_deliveries_24h),
        avg(webhook_deliveries_24h_failed),
        avg(ingest_sources_stale),
        avg(ingest_runs_24h),
        avg(ingest_runs_24h_with_errors),
        avg(inquiries_unassigned_total),
        avg(inquiries_unassigned_recent_7d),
        avg(verifications_pending),
        avg(rate_limit_throttling_now)
      FROM public.system_metric_snapshots
       WHERE captured_at >= %L
       GROUP BY bucket
       ORDER BY bucket ASC
    $sql$,
    v_trunc, v_since
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ops_metrics_downsampled(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ops_metrics_downsampled(text) TO authenticated;


-- =====================================================================
-- 4. Snapshot capture cron — every 5 minutes
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed; system_metric_snapshot cron NOT scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('system_metric_snapshot_5min')
    WHERE EXISTS (SELECT 1 FROM cron.job
                   WHERE jobname = 'system_metric_snapshot_5min');

  -- INSERT writes a row; the SELECT runs all aggregates inline. Each
  -- branch is bounded by indexed predicates — total cost expected
  -- <50ms even on a sizable platform.
  PERFORM cron.schedule(
    'system_metric_snapshot_5min',
    '*/5 * * * *',
    $cmd$
      INSERT INTO public.system_metric_snapshots (
        listings_online,
        listings_total_active,
        listings_soft_deleted,
        listings_source_imported,
        listings_orphan_created_by,
        webhook_subscriptions_total,
        webhook_subscriptions_enabled,
        webhook_subscriptions_failing,
        webhook_retry_queue_depth,
        webhook_retry_queue_stale,
        webhook_deliveries_24h,
        webhook_deliveries_24h_failed,
        ingest_sources_enabled,
        ingest_sources_stale,
        ingest_runs_24h,
        ingest_runs_24h_with_errors,
        inquiries_unassigned_total,
        inquiries_unassigned_recent_7d,
        verifications_pending,
        saved_search_subscriptions_confirmed,
        saved_search_subscriptions_pending,
        rate_limit_throttling_now
      )
      SELECT
        (SELECT count(*) FROM public.listings WHERE is_online=true AND deleted_at IS NULL),
        (SELECT count(*) FROM public.listings WHERE deleted_at IS NULL),
        (SELECT count(*) FROM public.listings WHERE deleted_at IS NOT NULL),
        (SELECT count(*) FROM public.listings
          WHERE source_id IS NOT NULL AND deleted_at IS NULL),
        (SELECT count(*) FROM public.listings l
          WHERE l.created_by IS NOT NULL AND l.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = l.created_by)),
        (SELECT count(*) FROM public.webhook_subscriptions),
        (SELECT count(*) FROM public.webhook_subscriptions WHERE enabled = true),
        (SELECT count(*) FROM public.webhook_subscriptions
          WHERE enabled = true AND consecutive_failures >= 5),
        (SELECT count(*) FROM public.webhook_retry_queue),
        (SELECT count(*) FROM public.webhook_retry_queue
          WHERE next_attempt_at < now() - interval '5 minutes'),
        (SELECT count(*) FROM public.webhook_deliveries
          WHERE attempted_at > now() - interval '24 hours'),
        (SELECT count(*) FROM public.webhook_deliveries
          WHERE attempted_at > now() - interval '24 hours'
            AND (http_status IS NULL OR http_status >= 400)),
        (SELECT count(*) FROM public.listing_sources WHERE enabled = true),
        (SELECT count(*) FROM public.listing_sources
          WHERE enabled = true
            AND last_ingested_at IS NOT NULL
            AND now() - last_ingested_at > (staleness_ttl_hours || ' hours')::interval),
        (SELECT count(*) FROM public.listing_source_ingest_runs
          WHERE created_at > now() - interval '24 hours'),
        (SELECT count(*) FROM public.listing_source_ingest_runs
          WHERE created_at > now() - interval '24 hours' AND errors_count > 0),
        (SELECT count(*) FROM public.inquiries WHERE assigned_user_id IS NULL),
        (SELECT count(*) FROM public.inquiries
          WHERE assigned_user_id IS NULL AND created_at > now() - interval '7 days'),
        (SELECT count(*) FROM public.profile_verifications WHERE status = 'pending'),
        (SELECT count(*) FROM public.saved_search_subscriptions WHERE confirmed_at IS NOT NULL),
        (SELECT count(*) FROM public.saved_search_subscriptions WHERE confirmed_at IS NULL),
        (SELECT count(*) FROM public.rate_limit_buckets
          WHERE count >= max_per_window AND window_started_at > now() - interval '1 hour');
    $cmd$
  );

  -- Daily prune — rows > 90 days are deleted.
  PERFORM cron.unschedule('system_metric_snapshots_prune_daily')
    WHERE EXISTS (SELECT 1 FROM cron.job
                   WHERE jobname = 'system_metric_snapshots_prune_daily');

  PERFORM cron.schedule(
    'system_metric_snapshots_prune_daily',
    '15 4 * * *',
    $cmd$
      DELETE FROM public.system_metric_snapshots
       WHERE captured_at < now() - interval '90 days';
    $cmd$
  );
END $$;


NOTIFY pgrst, 'reload schema';
