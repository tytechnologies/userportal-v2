-- Per-domain health RPC for /admin/operations.
--
-- Returns one jsonb with 6 domain sections, each with KPI counters
-- + a small "top items" array (capped at 5) for in-place drilldown:
--   webhooks      — subscriptions / retry queue / deliveries 24h
--   ingest        — sources / runs / failing sources
--   cron          — jobs registered / stale / failing
--   rate_limits   — active buckets / top throttling keys
--   notifications — 24h count / unread / by kind
--   search        — listing_details MV refresh + row count
--
-- Single round-trip vs. 6 separate queries from the page; each
-- section is a self-contained CTE inside one SQL function.
--
-- The function is SECURITY DEFINER + admin-permission-gated +
-- service-role/postgres bypass for SQL-editor smoke tests
-- (per the operating contract).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ops_domain_health();


CREATE OR REPLACE FUNCTION public.ops_domain_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_webhooks      jsonb;
  v_ingest        jsonb;
  v_cron          jsonb;
  v_rate_limits   jsonb;
  v_notifications jsonb;
  v_search        jsonb;
  v_has_pg_cron   boolean;
BEGIN
  IF NOT (
    public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: admin.access required'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    INTO v_has_pg_cron;

  -- ===================================================================
  -- WEBHOOKS
  -- ===================================================================
  WITH sub_stats AS (
    SELECT
      count(*)                                                         AS total,
      count(*) FILTER (WHERE enabled = true)                           AS enabled,
      count(*) FILTER (WHERE enabled = false)                          AS disabled,
      count(*) FILTER (WHERE enabled = true AND consecutive_failures >= 5) AS failing
    FROM public.webhook_subscriptions
  ),
  retry_stats AS (
    SELECT
      count(*) AS depth,
      count(*) FILTER (WHERE next_attempt_at < now() - interval '5 minutes') AS stale
    FROM public.webhook_retry_queue
  ),
  delivery_stats AS (
    SELECT
      count(*)                                                AS total_24h,
      count(*) FILTER (WHERE status_code IS NULL OR status_code >= 400) AS failed_24h
    FROM public.webhook_deliveries
    WHERE attempted_at > now() - interval '24 hours'
  ),
  failing_subs AS (
    SELECT id, name, url, consecutive_failures
    FROM public.webhook_subscriptions
    WHERE enabled = true AND consecutive_failures >= 5
    ORDER BY consecutive_failures DESC
    LIMIT 5
  )
  SELECT jsonb_build_object(
    'subscriptions_total',    s.total,
    'subscriptions_enabled',  s.enabled,
    'subscriptions_disabled', s.disabled,
    'subscriptions_failing',  s.failing,
    'retry_queue_depth',      r.depth,
    'retry_queue_stale',      r.stale,
    'deliveries_24h',         d.total_24h,
    'deliveries_24h_failed',  d.failed_24h,
    'top_failing',            COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'id', f.id,
         'name', f.name,
         'url', f.url,
         'consecutive_failures', f.consecutive_failures
       )) FROM failing_subs f),
      '[]'::jsonb
    )
  ) INTO v_webhooks
  FROM sub_stats s, retry_stats r, delivery_stats d;

  -- ===================================================================
  -- INGEST
  -- ===================================================================
  WITH source_stats AS (
    SELECT
      count(*)                                                         AS total,
      count(*) FILTER (WHERE enabled = true)                           AS enabled,
      count(*) FILTER (
        WHERE enabled = true
          AND last_ingested_at IS NOT NULL
          AND now() - last_ingested_at > (staleness_ttl_hours || ' hours')::interval
      ) AS stale
    FROM public.listing_sources
  ),
  run_stats AS (
    SELECT
      count(*)                                          AS runs_24h,
      count(*) FILTER (WHERE errors_count > 0)          AS runs_24h_with_errors,
      coalesce(sum(processed_count), 0)::bigint         AS rows_processed_24h,
      coalesce(sum(errors_count), 0)::bigint            AS errors_24h
    FROM public.listing_source_ingest_runs
    WHERE created_at > now() - interval '24 hours'
  ),
  stale_sources AS (
    SELECT id, slug, display_name, last_ingested_at, staleness_ttl_hours
    FROM public.listing_sources
    WHERE enabled = true
      AND (
        last_ingested_at IS NULL
        OR now() - last_ingested_at > (staleness_ttl_hours || ' hours')::interval
      )
    ORDER BY last_ingested_at NULLS FIRST
    LIMIT 5
  )
  SELECT jsonb_build_object(
    'sources_total',         s.total,
    'sources_enabled',       s.enabled,
    'sources_stale',         s.stale,
    'runs_24h',              r.runs_24h,
    'runs_24h_with_errors',  r.runs_24h_with_errors,
    'rows_processed_24h',    r.rows_processed_24h,
    'errors_24h',            r.errors_24h,
    'top_stale',             COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'id', x.id,
         'slug', x.slug,
         'display_name', x.display_name,
         'last_ingested_at', x.last_ingested_at,
         'ttl_hours', x.staleness_ttl_hours
       )) FROM stale_sources x),
      '[]'::jsonb
    )
  ) INTO v_ingest
  FROM source_stats s, run_stats r;

  -- ===================================================================
  -- CRON
  -- ===================================================================
  -- pg_cron is hosted in the cron schema. Wrap in extension check so
  -- this RPC remains usable on projects without it (rare, but keeps
  -- the dashboard from blowing up on a fresh dev DB).
  IF v_has_pg_cron THEN
    -- Plug the cron schema into search_path FOR THIS QUERY ONLY by
    -- fully-qualifying the references below.
    WITH last_runs AS (
      SELECT DISTINCT ON (j.jobid)
        j.jobid,
        j.jobname,
        j.schedule,
        j.active,
        d.status,
        d.start_time,
        d.return_message
      FROM cron.job j
      LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid
      ORDER BY j.jobid, d.start_time DESC NULLS LAST
    ),
    cron_stats AS (
      SELECT
        count(*)                                                   AS total,
        count(*) FILTER (WHERE active = true)                       AS active,
        count(*) FILTER (WHERE status = 'failed')                   AS last_run_failed,
        count(*) FILTER (
          WHERE active = true
            AND (start_time IS NULL OR start_time < now() - interval '25 hours')
        ) AS stale
      FROM last_runs
    ),
    cron_problems AS (
      SELECT jobname, status, start_time, return_message
      FROM last_runs
      WHERE active = true
        AND (
          status = 'failed'
          OR start_time IS NULL
          OR start_time < now() - interval '25 hours'
        )
      ORDER BY
        (status = 'failed') DESC,
        start_time NULLS FIRST
      LIMIT 5
    )
    SELECT jsonb_build_object(
      'jobs_total',          c.total,
      'jobs_active',         c.active,
      'jobs_last_failed',    c.last_run_failed,
      'jobs_stale',          c.stale,
      'top_problems',        COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
           'jobname', p.jobname,
           'status', p.status,
           'last_start', p.start_time,
           'message', p.return_message
         )) FROM cron_problems p),
        '[]'::jsonb
      )
    ) INTO v_cron
    FROM cron_stats c;
  ELSE
    v_cron := jsonb_build_object(
      'jobs_total', 0,
      'jobs_active', 0,
      'jobs_last_failed', 0,
      'jobs_stale', 0,
      'top_problems', '[]'::jsonb,
      'note', 'pg_cron not installed'
    );
  END IF;

  -- ===================================================================
  -- RATE LIMITS
  -- ===================================================================
  WITH bucket_stats AS (
    SELECT
      count(*)                                                       AS buckets_total,
      count(*) FILTER (WHERE window_started_at > now() - interval '5 minutes') AS active_5m,
      count(*) FILTER (WHERE request_count > 100)                    AS heavy_keys
    FROM public.rate_limit_buckets
  ),
  top_buckets AS (
    SELECT bucket_key, request_count, window_started_at, updated_at
    FROM public.rate_limit_buckets
    WHERE window_started_at > now() - interval '15 minutes'
    ORDER BY request_count DESC
    LIMIT 5
  )
  SELECT jsonb_build_object(
    'buckets_total',  s.buckets_total,
    'active_5m',      s.active_5m,
    'heavy_keys',     s.heavy_keys,
    'top_buckets',    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'bucket_key', b.bucket_key,
         'request_count', b.request_count,
         'window_started_at', b.window_started_at,
         'updated_at', b.updated_at
       )) FROM top_buckets b),
      '[]'::jsonb
    )
  ) INTO v_rate_limits
  FROM bucket_stats s;

  -- ===================================================================
  -- NOTIFICATIONS
  -- ===================================================================
  WITH notif_stats AS (
    SELECT
      count(*)                                                  AS total_24h,
      count(*) FILTER (WHERE read_at IS NULL)                    AS unread_24h,
      count(*) FILTER (WHERE dismissed_at IS NOT NULL)           AS dismissed_24h
    FROM public.notifications
    WHERE created_at > now() - interval '24 hours'
  ),
  notif_kinds AS (
    SELECT kind, count(*) AS c
    FROM public.notifications
    WHERE created_at > now() - interval '24 hours'
    GROUP BY kind
    ORDER BY count(*) DESC
    LIMIT 5
  ),
  unread_total AS (
    SELECT count(*) AS total FROM public.notifications WHERE read_at IS NULL
  )
  SELECT jsonb_build_object(
    'total_24h',       s.total_24h,
    'unread_24h',      s.unread_24h,
    'dismissed_24h',   s.dismissed_24h,
    'unread_all_time', u.total,
    'top_kinds',       COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('kind', k.kind, 'count', k.c))
         FROM notif_kinds k),
      '[]'::jsonb
    )
  ) INTO v_notifications
  FROM notif_stats s, unread_total u;

  -- ===================================================================
  -- SEARCH (listing_details MV state)
  -- ===================================================================
  -- listing_details is a materialized view; refresh time isn't
  -- tracked on the view itself. Best-effort proxy: the most recent
  -- successful start of the refresh cron job (which we own).
  IF v_has_pg_cron THEN
    WITH refresh_history AS (
      SELECT
        d.start_time,
        d.status,
        d.return_message
      FROM cron.job j
      JOIN cron.job_run_details d ON d.jobid = j.jobid
      WHERE j.jobname IN ('refresh_listing_details_periodic', 'refresh-listing-job')
      ORDER BY d.start_time DESC
      LIMIT 5
    ),
    last_success AS (
      SELECT start_time
      FROM refresh_history
      WHERE status = 'succeeded'
      LIMIT 1
    )
    SELECT jsonb_build_object(
      'mv_row_count',     (SELECT count(*) FROM public.listing_details),
      'last_refresh',     (SELECT start_time FROM last_success),
      'last_status',      (SELECT status FROM refresh_history LIMIT 1),
      'recent_refreshes', COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
           'started_at', r.start_time,
           'status',     r.status,
           'message',    r.return_message
         )) FROM refresh_history r),
        '[]'::jsonb
      )
    ) INTO v_search;
  ELSE
    v_search := jsonb_build_object(
      'mv_row_count', (SELECT count(*) FROM public.listing_details),
      'last_refresh', NULL,
      'last_status', NULL,
      'recent_refreshes', '[]'::jsonb,
      'note', 'pg_cron not installed; refresh history unavailable'
    );
  END IF;

  RETURN jsonb_build_object(
    'captured_at',   now(),
    'webhooks',      v_webhooks,
    'ingest',        v_ingest,
    'cron',          v_cron,
    'rate_limits',   v_rate_limits,
    'notifications', v_notifications,
    'search',        v_search
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ops_domain_health() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ops_domain_health() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_domain_health() TO service_role;


-- =====================================================================
-- Governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.ops_domain_health', 'function', 'userportal', ARRAY['userportal'],
   'Per-domain health RPC for /admin/operations: webhooks, ingest, cron, rate_limits, notifications, search.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
