-- Operations Health Dashboard — partial-application remediation.
--
-- Direct REST probes against the live DB on 2026-05-07 confirmed:
--   - public.ops_alerts (view)            EXISTS  ← from mig 14
--   - public.system_metric_snapshots      MISSING
--   - public.ops_overview()               MISSING
--   - public.ops_metrics_downsampled()    MISSING
--   - cron job system_metric_snapshot_5min  MISSING
--
-- Mig 14 was partially applied somehow (possibly the file was edited
-- mid-run, or only the view portion executed). The endpoints
-- `/api/admin/ops/overview` and `/api/admin/ops/metrics?range=24h`
-- fail with 500 because they depend on these missing objects.
--
-- This migration is purely additive remediation. Everything is
-- idempotent — safe to re-run.
--
-- ROLLBACK:
--   See mig 14 for the original definitions. To remove what this
--   ships, drop in this order:
--     DROP FUNCTION IF EXISTS public.ops_metrics_downsampled(text);
--     DROP FUNCTION IF EXISTS public.ops_overview();
--     DROP TABLE IF EXISTS public.system_metric_snapshots;


-- =====================================================================
-- 1. system_metric_snapshots — periodic point-in-time aggregates
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.system_metric_snapshots (
  id            bigserial PRIMARY KEY,
  captured_at   timestamptz NOT NULL DEFAULT now(),

  listings_online              integer NOT NULL,
  listings_total_active        integer NOT NULL,
  listings_soft_deleted        integer NOT NULL,
  listings_source_imported     integer NOT NULL,
  listings_orphan_created_by   integer NOT NULL,

  webhook_subscriptions_total          integer NOT NULL,
  webhook_subscriptions_enabled        integer NOT NULL,
  webhook_subscriptions_failing        integer NOT NULL,
  webhook_retry_queue_depth            integer NOT NULL,
  webhook_retry_queue_stale            integer NOT NULL,
  webhook_deliveries_24h               integer NOT NULL,
  webhook_deliveries_24h_failed        integer NOT NULL,

  ingest_sources_enabled       integer NOT NULL,
  ingest_sources_stale         integer NOT NULL,
  ingest_runs_24h              integer NOT NULL,
  ingest_runs_24h_with_errors  integer NOT NULL,

  inquiries_unassigned_total       integer NOT NULL,
  inquiries_unassigned_recent_7d   integer NOT NULL,

  verifications_pending  integer NOT NULL,

  saved_search_subscriptions_confirmed  integer NOT NULL,
  saved_search_subscriptions_pending    integer NOT NULL,

  rate_limit_throttling_now  integer NOT NULL
);

CREATE INDEX IF NOT EXISTS system_metric_snapshots_captured_idx
  ON public.system_metric_snapshots (captured_at DESC);

ALTER TABLE public.system_metric_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_metric_snapshots_select_admin
  ON public.system_metric_snapshots;
CREATE POLICY system_metric_snapshots_select_admin
  ON public.system_metric_snapshots FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.access'));
-- INSERT/UPDATE/DELETE: service-role only (cron writes).

COMMENT ON TABLE public.system_metric_snapshots IS
  'Periodic point-in-time aggregates for the Operations & Health dashboard. Captured every 5 minutes by cron job system_metric_snapshot_5min. Pruned daily — rows > 90 days are deleted.';


-- =====================================================================
-- 2. ops_overview() — overview-card aggregates RPC
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

  SELECT jsonb_build_object(
    'online',         count(*) FILTER (WHERE is_online = true AND deleted_at IS NULL),
    'soft_deleted',   count(*) FILTER (WHERE deleted_at IS NOT NULL),
    'source_imported', count(*) FILTER (WHERE source_id IS NOT NULL AND deleted_at IS NULL),
    'agent_created',  count(*) FILTER (WHERE source_id IS NULL AND deleted_at IS NULL),
    'total_active',   count(*) FILTER (WHERE deleted_at IS NULL)
  ) INTO v_listings FROM public.listings;

  SELECT jsonb_build_object(
    'subscriptions_total',    count(*),
    'subscriptions_enabled',  count(*) FILTER (WHERE enabled = true),
    'subscriptions_failing',  count(*) FILTER (WHERE enabled = true AND consecutive_failures >= 5),
    'subscriptions_disabled', count(*) FILTER (WHERE enabled = false),
    'retry_queue_depth',      (SELECT count(*) FROM public.webhook_retry_queue),
    'retry_queue_stale',      (SELECT count(*) FROM public.webhook_retry_queue
                                WHERE next_attempt_at < now() - interval '5 minutes')
  ) INTO v_webhooks FROM public.webhook_subscriptions;

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

  SELECT jsonb_build_object(
    'unassigned_total',     count(*) FILTER (WHERE assigned_user_id IS NULL),
    'unassigned_recent_7d', count(*) FILTER (
      WHERE assigned_user_id IS NULL
        AND created_at > now() - interval '7 days'
    )
  ) INTO v_inquiries FROM public.inquiries;

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


-- =====================================================================
-- 3. ops_metrics_downsampled(text) — time-series for 7d / 30d
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ops_metrics_downsampled(p_range text)
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

  IF p_range = '7d' THEN
    v_since := now() - interval '7 days';
    v_trunc := 'hour';
  ELSIF p_range = '30d' THEN
    v_since := now() - interval '30 days';
    v_trunc := 'hour';
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
-- 4. Snapshot capture cron — every 5 minutes (idempotent re-schedule)
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
        -- rate_limit_buckets schema is (bucket_key, window_started_at,
        -- request_count, updated_at). The original mig 14 query
        -- expected a stored per-bucket limit, but limits are enforced
        -- application-side. Closest meaningful instantaneous metric:
        -- count buckets that received traffic in the last hour.
        (SELECT count(*) FROM public.rate_limit_buckets
          WHERE request_count > 0 AND window_started_at > now() - interval '1 hour');
    $cmd$
  );

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


-- =====================================================================
-- 5. Seed the first snapshot immediately so the dashboard isn't empty
-- =====================================================================
--
-- The cron fires every 5 min; without a manual seed the dashboard
-- shows an empty time-series for up to 5 minutes after this lands.
-- One synchronous insert here is cheap and matches the cron's INSERT.

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
  (SELECT count(*) FROM public.listings WHERE source_id IS NOT NULL AND deleted_at IS NULL),
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
    WHERE request_count > 0 AND window_started_at > now() - interval '1 hour')
WHERE NOT EXISTS (SELECT 1 FROM public.system_metric_snapshots);


NOTIFY pgrst, 'reload schema';
