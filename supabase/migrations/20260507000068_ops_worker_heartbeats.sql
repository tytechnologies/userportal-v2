-- Worker heartbeat + queue depth observability.
--
-- Phase E. Foundation for the operator runbook: every internal /tick
-- worker (email, AI suggestions, charge reminders, …) writes a row
-- on each successful run. The runbook page reads from this table to
-- show last-success, runs-in-last-hour, and detects silent failure
-- (no heartbeat in expected interval).
--
-- Trust contract:
--   * Heartbeats are append-only via BEFORE UPDATE/DELETE trigger.
--     A worker that's been compromised cannot rewrite history.
--   * Caller identity comes from the request context — service_role
--     for cron-runner endpoints, never user-trusted input.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.record_worker_heartbeat(text, jsonb);
--   DROP TABLE IF EXISTS public.ops_worker_heartbeats;
--   DELETE FROM public.governance_schema_contracts
--     WHERE contract_name IN ('public.ops_worker_heartbeats',
--                             'public.record_worker_heartbeat');


CREATE TABLE IF NOT EXISTS public.ops_worker_heartbeats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Documented worker keys (open-ended; new workers add rows freely):
  --   'email_worker_tick'
  --   'ai_suggestion_worker_tick'
  --   'charge_due_reminders'
  --   'platform_fee_settlement'
  worker_key      text NOT NULL,
  -- Per-run free-form payload. Documented keys:
  --   sent (int), failed (int), claimed (int), batch_size (int),
  --   stats (jsonb), elapsed_ms (int).
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_worker_heartbeats_key_time_idx
  ON public.ops_worker_heartbeats(worker_key, recorded_at DESC);
CREATE INDEX IF NOT EXISTS ops_worker_heartbeats_recent_idx
  ON public.ops_worker_heartbeats(recorded_at DESC);

ALTER TABLE public.ops_worker_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ops_worker_heartbeats_select ON public.ops_worker_heartbeats;
CREATE POLICY ops_worker_heartbeats_select ON public.ops_worker_heartbeats FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.access'));

DROP POLICY IF EXISTS ops_worker_heartbeats_insert ON public.ops_worker_heartbeats;
CREATE POLICY ops_worker_heartbeats_insert ON public.ops_worker_heartbeats FOR INSERT
  TO authenticated
  WITH CHECK (public.has_permission('admin.access'));

CREATE OR REPLACE FUNCTION public._ops_worker_heartbeats_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ops_worker_heartbeats is append-only';
END;
$$;

DROP TRIGGER IF EXISTS ops_worker_heartbeats_no_update ON public.ops_worker_heartbeats;
CREATE TRIGGER ops_worker_heartbeats_no_update
  BEFORE UPDATE OR DELETE ON public.ops_worker_heartbeats
  FOR EACH ROW EXECUTE FUNCTION public._ops_worker_heartbeats_block_mutation();


-- =====================================================================
-- Insert helper — called by every internal worker endpoint.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.record_worker_heartbeat(
  p_worker_key text,
  p_payload    jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_worker_key IS NULL OR length(trim(p_worker_key)) = 0 THEN
    RAISE EXCEPTION 'worker_key is required';
  END IF;
  INSERT INTO public.ops_worker_heartbeats (worker_key, payload)
  VALUES (p_worker_key, COALESCE(p_payload, '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.record_worker_heartbeat(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_worker_heartbeat(text, jsonb)
  TO authenticated, service_role;


-- =====================================================================
-- Summary view for the runbook UI.
-- =====================================================================
--
-- One row per documented worker_key with last-run timestamp + run
-- count in the last hour. Workers with no rows yet show NULL.

CREATE OR REPLACE VIEW public.ops_worker_status AS
WITH known_workers(worker_key, expected_interval_seconds, label) AS (
  VALUES
    ('email_worker_tick',         300,     'Email worker'),
    ('ai_suggestion_worker_tick', 1800,    'AI suggestions'),
    ('eis_submitter_tick',        900,     'EIS submitter (BIR e-invoicing)'),
    ('charge_due_reminders',      86400,   'Charge due reminders'),
    ('platform_fee_settlement',   2678400, 'Platform fee settlement')
),
heartbeat_agg AS (
  SELECT
    worker_key,
    MAX(recorded_at)                                      AS last_recorded_at,
    COUNT(*) FILTER (WHERE recorded_at > now() - interval '1 hour') AS runs_last_hour,
    COUNT(*) FILTER (WHERE recorded_at > now() - interval '24 hours') AS runs_last_day,
    (SELECT payload FROM public.ops_worker_heartbeats h2
       WHERE h2.worker_key = h.worker_key
       ORDER BY recorded_at DESC LIMIT 1) AS last_payload
  FROM public.ops_worker_heartbeats h
  GROUP BY worker_key
)
SELECT
  k.worker_key,
  k.label,
  k.expected_interval_seconds,
  ha.last_recorded_at,
  ha.runs_last_hour,
  ha.runs_last_day,
  ha.last_payload,
  CASE
    WHEN ha.last_recorded_at IS NULL THEN 'never_seen'
    WHEN ha.last_recorded_at < now() - (k.expected_interval_seconds * interval '3 seconds') THEN 'overdue'
    WHEN ha.last_recorded_at < now() - (k.expected_interval_seconds * interval '1.5 seconds') THEN 'slow'
    ELSE 'healthy'
  END AS health
FROM known_workers k
LEFT JOIN heartbeat_agg ha ON ha.worker_key = k.worker_key;

COMMENT ON VIEW public.ops_worker_status IS
  'Per-worker health summary for the operator runbook. health: healthy | slow | overdue | never_seen.';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.ops_worker_heartbeats', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Append-only heartbeat log written by every internal worker tick.',
   false),
  ('public.record_worker_heartbeat', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Insert helper for ops_worker_heartbeats.',
   false),
  ('public.ops_worker_status', 'view', 'userportal',
   ARRAY['userportal']::text[],
   'Per-worker health summary view (healthy | slow | overdue | never_seen).',
   false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- Smoke test
-- =====================================================================
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.ops_worker_status;
  RAISE NOTICE 'ops_worker_status: % registered workers', v_count;
END $$;


NOTIFY pgrst, 'reload schema';
