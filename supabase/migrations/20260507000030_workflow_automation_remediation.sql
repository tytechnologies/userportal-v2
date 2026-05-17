-- Workflow Automation Remediation + Stabilization.
--
-- Mig 24 (workflow_automation) rolled back entirely because its
-- `tasks_assignee_open_idx` referenced the non-existent column
-- `assigned_to_user_id` (canonical: `assignee_user_id`). Mig 25 only
-- re-issued the trigger function + cron — not the table additions,
-- views, or new columns those depend on.
--
-- This migration re-applies all the rolled-back pieces with correct
-- column names, plus stabilization adds for the discovery layer.
--
-- All idempotent — safe to re-run if partially applied.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.discovery_health;
--   DROP VIEW IF EXISTS public.pipeline_recommendations;
--   DROP VIEW IF EXISTS public.pipeline_alerts;
--   DROP TABLE IF EXISTS public.automation_task_templates;
--   ALTER TABLE public.tasks
--     DROP COLUMN IF EXISTS deal_id,
--     DROP COLUMN IF EXISTS auto_generated,
--     DROP COLUMN IF EXISTS last_reminder_sent_at;


-- =====================================================================
-- 1. tasks — additive columns (re-add what mig 24 rolled back)
-- =====================================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES public.deals(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS tasks_deal_idx
  ON public.tasks(deal_id) WHERE deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_due_reminder_idx
  ON public.tasks(due_at)
  WHERE due_at IS NOT NULL
    AND completed_at IS NULL
    AND last_reminder_sent_at IS NULL;

-- Canonical column name this time.
CREATE INDEX IF NOT EXISTS tasks_assignee_open_idx
  ON public.tasks(assignee_user_id, due_at)
  WHERE completed_at IS NULL;


-- =====================================================================
-- 2. automation_task_templates — re-create + re-seed
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.automation_task_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_event   text NOT NULL CHECK (trigger_event IN ('deal.stage_changed')),
  trigger_match   jsonb NOT NULL DEFAULT '{}'::jsonb,
  task_template   jsonb NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_task_templates_trigger_idx
  ON public.automation_task_templates(trigger_event)
  WHERE enabled = true;

DROP TRIGGER IF EXISTS set_automation_task_templates_updated_at
  ON public.automation_task_templates;
CREATE TRIGGER set_automation_task_templates_updated_at
  BEFORE UPDATE ON public.automation_task_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.automation_task_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_task_templates_select ON public.automation_task_templates;
CREATE POLICY automation_task_templates_select
  ON public.automation_task_templates FOR SELECT
  TO authenticated USING (true);

-- Re-seed rules. ON CONFLICT against (trigger_event, trigger_match,
-- task_template->>'title') would be ideal, but we don't have a unique
-- constraint shaped that way. Use a guarded INSERT instead.
INSERT INTO public.automation_task_templates (trigger_event, trigger_match, task_template, description)
SELECT * FROM (VALUES
  ('deal.stage_changed', '{"to_stage":"viewing_scheduled"}'::jsonb,
   '{"title":"Confirm viewing 24h before","description":"Send confirmation message to buyer.","due_offset_hours":24,"priority":"high"}'::jsonb,
   'Confirm viewing day-before'),
  ('deal.stage_changed', '{"to_stage":"viewing_scheduled"}'::jsonb,
   '{"title":"Prepare property for viewing","description":"Coordinate with seller / unit owner.","due_offset_hours":48,"priority":"normal"}'::jsonb,
   'Prep coordination'),
  ('deal.stage_changed', '{"to_stage":"viewing_completed"}'::jsonb,
   '{"title":"Post-viewing follow-up","description":"Reach out for buyer feedback within 24h.","due_offset_hours":24,"priority":"high"}'::jsonb,
   'Buyer follow-up'),
  ('deal.stage_changed', '{"to_stage":"negotiating"}'::jsonb,
   '{"title":"Document offer","description":"Capture price, terms, contingencies in deal notes.","due_offset_hours":48,"priority":"high"}'::jsonb,
   'Offer documentation'),
  ('deal.stage_changed', '{"to_stage":"reservation"}'::jsonb,
   '{"title":"Collect reservation fee","description":"Verify payment received and signed reservation form.","due_offset_hours":24,"priority":"high"}'::jsonb,
   'Reservation fee'),
  ('deal.stage_changed', '{"to_stage":"reservation"}'::jsonb,
   '{"title":"Verify buyer ID + KYC","description":"Confirm valid government ID + buyer profile complete.","due_offset_hours":72,"priority":"normal"}'::jsonb,
   'KYC verification'),
  ('deal.stage_changed', '{"to_stage":"documentation"}'::jsonb,
   '{"title":"Request LOI","description":"Letter of intent from buyer.","due_offset_hours":48,"priority":"high"}'::jsonb,
   'LOI request'),
  ('deal.stage_changed', '{"to_stage":"documentation"}'::jsonb,
   '{"title":"Request proof of payment","description":"Reservation/down-payment receipt.","due_offset_hours":48,"priority":"normal"}'::jsonb,
   'POP request'),
  ('deal.stage_changed', '{"to_stage":"documentation"}'::jsonb,
   '{"title":"Request government IDs","description":"Buyer + co-buyer (if any) IDs.","due_offset_hours":72,"priority":"normal"}'::jsonb,
   'IDs'),
  ('deal.stage_changed', '{"to_stage":"documentation"}'::jsonb,
   '{"title":"Coordinate contract signing","description":"Schedule contract review + signing meeting.","due_offset_hours":120,"priority":"high"}'::jsonb,
   'Contract'),
  ('deal.stage_changed', '{"to_stage":"closing"}'::jsonb,
   '{"title":"Verify final payment","description":"Confirm full payment cleared and recorded.","due_offset_hours":48,"priority":"high"}'::jsonb,
   'Final payment'),
  ('deal.stage_changed', '{"to_stage":"closing"}'::jsonb,
   '{"title":"Schedule turnover","description":"Coordinate keys + property turnover with seller.","due_offset_hours":120,"priority":"normal"}'::jsonb,
   'Turnover')
) AS new_rules(trigger_event, trigger_match, task_template, description)
WHERE NOT EXISTS (
  SELECT 1 FROM public.automation_task_templates t
   WHERE t.trigger_event = new_rules.trigger_event
     AND t.trigger_match = new_rules.trigger_match
     AND t.task_template->>'title' = new_rules.task_template->>'title'
);


-- =====================================================================
-- 3. pipeline_alerts — operator-side SLA / stale-state alerts
-- =====================================================================

CREATE OR REPLACE VIEW public.pipeline_alerts AS
SELECT *
  FROM (
    -- Inquiries unanswered > 24h
    SELECT
      'inquiry.unanswered.' || i.id::text                          AS key,
      'warning'                                                    AS severity,
      'inquiry'                                                    AS category,
      i.assigned_user_id                                           AS owner_user_id,
      'Inquiry unanswered for ' ||
        (EXTRACT(EPOCH FROM now() - i.created_at)::int / 3600) || 'h' AS title,
      'Sender: ' || i.sender_name                                  AS detail,
      jsonb_build_object(
        'inquiry_id', i.id,
        'listing_id', i.listing_id,
        'sender_name', i.sender_name,
        'hours_since_received', EXTRACT(EPOCH FROM now() - i.created_at)::int / 3600
      )                                                            AS metadata,
      i.created_at                                                 AS started_at
      FROM public.inquiries i
     WHERE i.status = 'new'
       AND i.assigned_user_id IS NOT NULL
       AND now() - i.created_at > interval '24 hours'

    UNION ALL

    -- Deals stuck in their current stage > 7 days
    SELECT
      'deal.stale.' || d.id::text,
      CASE
        WHEN now() - d.stage_entered_at > interval '14 days' THEN 'critical'
        ELSE 'warning'
      END,
      'deal',
      d.buyer_agent_user_id,
      'Deal stuck in ' || d.stage_key || ' for ' ||
        (EXTRACT(EPOCH FROM now() - d.stage_entered_at)::int / 86400) || 'd',
      COALESCE(d.title, 'Deal ' || d.id::text),
      jsonb_build_object(
        'deal_id', d.id,
        'listing_id', d.listing_id,
        'stage_key', d.stage_key,
        'days_in_stage', EXTRACT(EPOCH FROM now() - d.stage_entered_at)::int / 86400
      ),
      d.stage_entered_at
      FROM public.deals d
     WHERE d.closed_at IS NULL
       AND d.stage_key NOT IN ('closed_won', 'closed_lost')
       AND now() - d.stage_entered_at > interval '7 days'

    UNION ALL

    -- Viewings scheduled but unupdated past their end + 2h
    SELECT
      'viewing.unupdated.' || v.id::text,
      'warning',
      'viewing',
      v.attending_user_id,
      'Viewing not marked complete',
      'Scheduled ' || v.scheduled_at::text || '; status still "scheduled"',
      jsonb_build_object(
        'viewing_id', v.id,
        'deal_id', v.deal_id,
        'scheduled_at', v.scheduled_at
      ),
      v.scheduled_at
      FROM public.deal_viewings v
     WHERE v.status = 'scheduled'
       AND v.scheduled_at + (v.duration_minutes * interval '1 minute')
           + interval '2 hours' < now()

    UNION ALL

    -- Documentation-stage with too few docs
    SELECT
      'deal.docs_thin.' || d.id::text,
      'info',
      'deal',
      d.buyer_agent_user_id,
      'Documentation stage but only '
        || (SELECT count(*) FROM public.documents WHERE deal_id = d.id)::text
        || ' docs uploaded',
      COALESCE(d.title, 'Deal ' || d.id::text),
      jsonb_build_object(
        'deal_id', d.id,
        'listing_id', d.listing_id,
        'doc_count', (SELECT count(*) FROM public.documents WHERE deal_id = d.id)
      ),
      d.stage_entered_at
      FROM public.deals d
     WHERE d.closed_at IS NULL
       AND d.stage_key = 'documentation'
       AND (SELECT count(*) FROM public.documents WHERE deal_id = d.id) < 3
       AND now() - d.stage_entered_at > interval '3 days'

    UNION ALL

    -- Reservation deals open >30 days
    SELECT
      'deal.reservation_expired.' || d.id::text,
      'warning',
      'deal',
      d.buyer_agent_user_id,
      'Reservation older than 30 days — confirm or release',
      COALESCE(d.title, 'Deal ' || d.id::text),
      jsonb_build_object(
        'deal_id', d.id,
        'listing_id', d.listing_id,
        'days_in_reservation', EXTRACT(EPOCH FROM now() - d.stage_entered_at)::int / 86400
      ),
      d.stage_entered_at
      FROM public.deals d
     WHERE d.closed_at IS NULL
       AND d.stage_key = 'reservation'
       AND now() - d.stage_entered_at > interval '30 days'
  ) AS u
ORDER BY
  CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
  started_at DESC;

GRANT SELECT ON public.pipeline_alerts TO authenticated;


-- =====================================================================
-- 4. pipeline_recommendations — deterministic next-action hints
-- =====================================================================

CREATE OR REPLACE VIEW public.pipeline_recommendations AS
SELECT *
  FROM (
    SELECT
      d.id              AS deal_id,
      d.listing_id,
      d.buyer_agent_user_id,
      'suggest_advance_to_negotiating'                AS rule_key,
      'Move to negotiating?'                          AS title,
      'Viewing completed ' ||
        (EXTRACT(EPOCH FROM now() - d.stage_entered_at)::int / 86400)
        || ' days ago; if buyer is interested, advance the stage.' AS detail,
      jsonb_build_object('to_stage', 'negotiating')   AS suggested_action
      FROM public.deals d
     WHERE d.closed_at IS NULL
       AND d.stage_key = 'viewing_completed'
       AND now() - d.stage_entered_at > interval '3 days'

    UNION ALL

    SELECT
      d.id, d.listing_id, d.buyer_agent_user_id,
      'suggest_check_in_negotiation',
      'Check in on negotiation',
      'Negotiating for ' ||
        (EXTRACT(EPOCH FROM now() - d.stage_entered_at)::int / 86400)
        || ' days; check in to confirm offer is still active.',
      jsonb_build_object('action', 'create_followup_task')
      FROM public.deals d
     WHERE d.closed_at IS NULL
       AND d.stage_key = 'negotiating'
       AND now() - d.stage_entered_at > interval '7 days'

    UNION ALL

    SELECT
      d.id, d.listing_id, d.buyer_agent_user_id,
      'suggest_request_missing_docs',
      'Request missing documents',
      'Documentation stage but only '
        || (SELECT count(*) FROM public.documents WHERE deal_id = d.id)::text
        || ' docs attached. Common deal docs: LOI, IDs, proof of payment, contract.',
      jsonb_build_object(
        'doc_count', (SELECT count(*) FROM public.documents WHERE deal_id = d.id)
      )
      FROM public.deals d
     WHERE d.closed_at IS NULL
       AND d.stage_key = 'documentation'
       AND (SELECT count(*) FROM public.documents WHERE deal_id = d.id) < 4

    UNION ALL

    SELECT
      d.id, d.listing_id, d.buyer_agent_user_id,
      'suggest_advance_to_documentation',
      'Move to documentation?',
      'Reservation has been ' ||
        (EXTRACT(EPOCH FROM now() - d.stage_entered_at)::int / 86400)
        || ' days; if signed, move to documentation to track contracts.',
      jsonb_build_object('to_stage', 'documentation')
      FROM public.deals d
     WHERE d.closed_at IS NULL
       AND d.stage_key = 'reservation'
       AND now() - d.stage_entered_at > interval '7 days'
  ) AS r;

GRANT SELECT ON public.pipeline_recommendations TO authenticated;


-- =====================================================================
-- 5. Hot-path index for discovery segment queries
-- =====================================================================
--
-- listing_discovery_score's percent_rank window partitions by
-- (city_id, property_type) — and market_inventory_summary +
-- market_velocity GROUP BY the same. A composite covers both.
-- Partial index on live rows only — keeps it small.

CREATE INDEX IF NOT EXISTS listings_segment_live_idx
  ON public.listings(city_id, property_type)
  WHERE is_online = true AND deleted_at IS NULL;


-- =====================================================================
-- 6. discovery_health view — single-row freshness summary
-- =====================================================================
--
-- Surfaces MV refresh lag for the new intelligence layer. The ops
-- dashboard reads this to show "Discovery: fresh / stale" at a glance
-- without aggregating across governance_materialized_views per query.

CREATE OR REPLACE VIEW public.discovery_health AS
SELECT
  -- Quality scores: hourly cadence — 2h is the staleness threshold.
  (SELECT last_refresh_completed_at
     FROM public.governance_materialized_views
    WHERE view_name = 'public.mv_listing_quality_score') AS quality_last_refresh,
  (SELECT last_refresh_error
     FROM public.governance_materialized_views
    WHERE view_name = 'public.mv_listing_quality_score') AS quality_last_error,
  (SELECT consecutive_failures
     FROM public.governance_materialized_views
    WHERE view_name = 'public.mv_listing_quality_score') AS quality_consecutive_failures,

  -- Monthly trends: daily cadence — 26h staleness threshold.
  (SELECT last_refresh_completed_at
     FROM public.governance_materialized_views
    WHERE view_name = 'public.mv_market_monthly_trends') AS trends_last_refresh,
  (SELECT last_refresh_error
     FROM public.governance_materialized_views
    WHERE view_name = 'public.mv_market_monthly_trends') AS trends_last_error,

  -- Aggregate health flag — true when both MVs are within their
  -- expected refresh windows.
  (
    (SELECT last_refresh_completed_at FROM public.governance_materialized_views
      WHERE view_name = 'public.mv_listing_quality_score') > now() - interval '2 hours'
    AND
    (SELECT last_refresh_completed_at FROM public.governance_materialized_views
      WHERE view_name = 'public.mv_market_monthly_trends') > now() - interval '26 hours'
  ) AS healthy,

  -- Discovery score row count (for sanity check — 0 = empty view = MV problem).
  (SELECT count(*) FROM public.listing_discovery_score) AS discovery_row_count,

  now() AS evaluated_at;

GRANT SELECT ON public.discovery_health TO authenticated;

COMMENT ON VIEW public.discovery_health IS
  'Single-row freshness summary across the discovery MVs. healthy=true when quality MV refreshed in last 2h AND trends MV in last 26h. Read by /admin/operations to render a "Discovery: fresh" indicator.';


-- =====================================================================
-- 7. Governance — register the missing contracts
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.pipeline_recommendations', 'view', 'userportal', ARRAY['userportal'],
   'Deterministic next-action hints per deal. Mirror of pipeline_alerts but advisory.', false),
  ('public.discovery_health',         'view', 'userportal', ARRAY['userportal'],
   'Single-row MV freshness summary for the discovery layer.', false),
  ('public.automation_task_templates','table','userportal', ARRAY['userportal'],
   'Seeded rule registry powering the deals stage-transition trigger.', false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- 8. Auto-acknowledge the pipeline_alerts drift entry
-- =====================================================================
--
-- The drift_log entry that flagged this gap now resolves. Mark as
-- acknowledged so the dashboard stops shouting once the views exist.

UPDATE public.governance_drift_log
   SET acknowledged_at = now()
 WHERE contract_name = 'public.pipeline_alerts'
   AND drift_type    = 'missing_view'
   AND acknowledged_at IS NULL;


NOTIFY pgrst, 'reload schema';
