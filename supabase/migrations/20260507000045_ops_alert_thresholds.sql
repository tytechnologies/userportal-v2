-- Admin-tunable thresholds for the ops_alerts view.
--
-- Until now the view (mig 17) hardcoded:
--   webhook_failing  : consecutive_failures >= 5
--   webhook_disabled : consecutive_failures >= 10
--   retry_stuck      : next_attempt_at < now() - interval '5 minutes'
--   cron_overdue     : start_time < now() - interval '26 hours'
--
-- Moving these to a config table lets ops tune the dashboard's
-- "noise floor" without a migration. Each entry is a key + integer
-- value + description; helper function `ops_alert_threshold(key)`
-- returns the value with a defensive fallback so missing rows never
-- silently weaken an alert.
--
-- The webhook dispatcher's own auto-disable threshold (server/utils/
-- webhooks.ts) currently hardcodes 10. Wiring that to this table is
-- a follow-up — it requires the dispatcher to query the value, which
-- is a different scope than this migration.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ops_alert_threshold(text);
--   DROP TABLE IF EXISTS public.ops_alert_thresholds;
--   -- And re-apply mig 17 to restore inline literals in ops_alerts.


-- =====================================================================
-- 1. Config table
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.ops_alert_thresholds (
  key          text PRIMARY KEY,
  value_int    integer NOT NULL CHECK (value_int >= 0),
  -- Operator-facing description of what this knob controls and the
  -- units (failures / minutes / hours). Surfaced in the admin form.
  description  text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

ALTER TABLE public.ops_alert_thresholds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ops_alert_thresholds_admin ON public.ops_alert_thresholds;
CREATE POLICY ops_alert_thresholds_admin
  ON public.ops_alert_thresholds
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 2. Seed defaults (matches the current hardcoded values from mig 17)
-- =====================================================================

INSERT INTO public.ops_alert_thresholds (key, value_int, description) VALUES
  ('webhook_failing_min_failures',  5,
   'Consecutive failures before a still-enabled webhook subscription is flagged "failing". Unit: failures.'),
  ('webhook_disabled_min_failures', 10,
   'Consecutive failures at which a subscription is treated as auto-disabled. Unit: failures.'),
  ('webhook_retry_stuck_minutes',   5,
   'Minutes a retry-queue row may sit past its next_attempt_at before being flagged "overdue". Unit: minutes.'),
  ('cron_overdue_hours',            26,
   'Hours since a cron job''s last successful run before flagging it overdue. Unit: hours.')
ON CONFLICT (key) DO NOTHING;


-- =====================================================================
-- 3. Helper function — read a threshold with a safe default
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ops_alert_threshold(p_key text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT value_int FROM public.ops_alert_thresholds WHERE key = p_key),
    -- Fallbacks match the original hardcoded values. If a row is
    -- missing for any reason, the alerting behavior is unchanged.
    CASE p_key
      WHEN 'webhook_failing_min_failures'  THEN 5
      WHEN 'webhook_disabled_min_failures' THEN 10
      WHEN 'webhook_retry_stuck_minutes'   THEN 5
      WHEN 'cron_overdue_hours'            THEN 26
      ELSE 0
    END
  );
$$;

REVOKE ALL ON FUNCTION public.ops_alert_threshold(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ops_alert_threshold(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_alert_threshold(text) TO service_role;


-- =====================================================================
-- 4. Re-define ops_alerts view to use the helper
-- =====================================================================
-- Identical structure to mig 17; only the literals are replaced.

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
     WHERE enabled = true
       AND consecutive_failures >= public.ops_alert_threshold('webhook_failing_min_failures')

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
     WHERE enabled = false
       AND consecutive_failures >= public.ops_alert_threshold('webhook_disabled_min_failures')

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
     WHERE next_attempt_at < now() - (public.ops_alert_threshold('webhook_retry_stuck_minutes') || ' minutes')::interval
     HAVING count(*) > 0

    UNION ALL

    -- Ingestion source past its staleness TTL (TTL is per-row config)
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
         OR latest.start_time < now() - (public.ops_alert_threshold('cron_overdue_hours') || ' hours')::interval
       )
  ) AS u
ORDER BY
  CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
  started_at DESC;

GRANT SELECT ON public.ops_alerts TO authenticated;

COMMENT ON VIEW public.ops_alerts IS
  'Derived alert feed for the Operations dashboard. Thresholds tunable via public.ops_alert_thresholds.';


-- =====================================================================
-- 5. Governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.ops_alert_thresholds', 'table', 'userportal', ARRAY['userportal'],
   'Admin-tunable alert thresholds. Read by ops_alerts view via ops_alert_threshold(key) helper.', false),
  ('public.ops_alert_threshold', 'function', 'userportal', ARRAY['userportal'],
   'STABLE helper returning the integer value for a threshold key, with hardcoded fallback if the row is missing.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
