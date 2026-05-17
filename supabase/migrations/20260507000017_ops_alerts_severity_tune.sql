-- Tune ops_alerts severity for "never run" cron entries.
--
-- Background: 20260507000016 fires "warning" for any active cron
-- whose cron.job_run_details is empty. After fresh deploys, daily
-- crons (saved-search digest, deliveries prune, etc.) sit in
-- "never run" state for up to 24h before their first fire — which
-- showed up as warnings on a healthy system.
--
-- Severity rule going forward:
--   critical → last run failed (real failure on this cycle)
--   warning  → had a previous successful run, now overdue (>26h)
--   info     → never run (registered but no history yet — common
--              right after deploy; auto-resolves on first fire)
--
-- The "26h overdue with no successful predecessor" case (a daemon
-- that's been registered for ages but never fires anything) is
-- still surfaced — but as info severity. Operators investigating
-- a fresh deploy can dismiss; if it's still info 48h later, that's
-- the signal something deeper is wrong.
--
-- ROLLBACK:
--   Re-apply 20260507000016 (CREATE OR REPLACE overwrites this).

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

    -- Cron job has never run / last run failed / overdue.
    -- Severity tuned per condition (see migration header).
    SELECT
      'cron.failed.' || j.jobname,
      CASE
        WHEN latest.status IS NOT DISTINCT FROM 'failed' THEN 'critical'
        WHEN latest.start_time IS NULL THEN 'info'
        ELSE 'warning'
      END,
      'cron',
      'Cron "' || j.jobname || '" ' ||
        CASE
          WHEN latest.start_time IS NULL THEN 'has never run'
          WHEN latest.status IS NOT DISTINCT FROM 'failed' THEN 'last run failed'
          ELSE 'is overdue'
        END,
      COALESCE(latest.return_message,
        CASE
          WHEN latest.start_time IS NULL THEN
            'Registered with schedule "' || j.schedule
            || '" but no runs recorded yet — first fire pending or pg_cron daemon not running.'
          ELSE 'No detail available'
        END
      ),
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
  'Derived alert feed for the Operations dashboard. Severity ladder for cron: critical=last run failed, warning=overdue (had a prior run), info=never run (fresh deploy or daemon stalled).';


NOTIFY pgrst, 'reload schema';
