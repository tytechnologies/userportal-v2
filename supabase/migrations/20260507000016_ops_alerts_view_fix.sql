-- Fix for 20260507000014_ops_health_dashboard.sql.
--
-- The ops_alerts view's ORDER BY uses a CASE expression after a chain
-- of UNION ALL. Postgres rejects this with:
--   0A000: invalid UNION/INTERSECT/EXCEPT ORDER BY clause
--   DETAIL: Only result column names can be used, not expressions
--   HINT: Add the expression/function to every SELECT, or move the
--         UNION into a FROM clause.
--
-- The hint's second option is cleaner: wrap the UNION ALL in a
-- subquery and ORDER BY at the outer level. View body otherwise
-- unchanged from the original migration.
--
-- ROLLBACK:
--   Re-apply 20260507000014 (CREATE OR REPLACE overwrites this).

CREATE OR REPLACE VIEW public.ops_alerts AS
SELECT *
  FROM (
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

    -- Webhook retry queue stuck
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
      COALESCE(latest.start_time, now() - interval '99 years')
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
         OR latest.start_time < now() - interval '26 hours'
       )
  ) AS u
ORDER BY
  CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
  started_at DESC;

GRANT SELECT ON public.ops_alerts TO authenticated;

COMMENT ON VIEW public.ops_alerts IS
  'Derived alert feed for the Operations dashboard. Reads existing tables (webhook_subscriptions, webhook_retry_queue, listing_sources, cron.job, cron.job_run_details). Always fresh; no separate storage. ORDER BY wraps the UNION ALL in a subquery to satisfy Postgres''s rule against expressions in UNION-level ORDER BY (0A000).';


NOTIFY pgrst, 'reload schema';
