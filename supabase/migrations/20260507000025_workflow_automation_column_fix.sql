-- Fix for 20260507000024 — wrong column name.
--
-- The original migration referenced public.tasks.assigned_to_user_id
-- in the trigger function and the reminder cron. The canonical
-- column (per 20260501000009_crm_tasks_notes_notifications) is
-- `assignee_user_id`. Postgres rejected with:
--   ERROR: 42703: column "assigned_to_user_id" does not exist
--
-- This migration:
--   1. Re-creates deals_apply_task_templates_fn with the right column
--   2. Re-schedules tasks_reminder_daily with the right column
--
-- The earlier migration's other objects (table additions, view
-- creates) succeed independently — the columns I added (deal_id,
-- auto_generated, last_reminder_sent_at) and the views
-- (pipeline_alerts, pipeline_recommendations) don't reference the
-- wrong column. Only the trigger + cron need fixing.
--
-- ROLLBACK:
--   Re-apply the (broken) 20260507000024 — but don't.

CREATE OR REPLACE FUNCTION public.deals_apply_task_templates_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  tpl RECORD;
  v_assignee uuid;
  v_due timestamptz;
BEGIN
  IF NEW.stage_key IS NOT DISTINCT FROM OLD.stage_key THEN
    RETURN NEW;
  END IF;

  IF NEW.stage_key IN ('closed_won', 'closed_lost') THEN
    RETURN NEW;
  END IF;

  v_assignee := COALESCE(NEW.buyer_agent_user_id, NEW.created_by);
  IF v_assignee IS NULL THEN
    RETURN NEW;
  END IF;

  FOR tpl IN
    SELECT id, task_template
      FROM public.automation_task_templates
     WHERE enabled = true
       AND trigger_event = 'deal.stage_changed'
       AND trigger_match->>'to_stage' = NEW.stage_key
  LOOP
    v_due := now() + ((tpl.task_template->>'due_offset_hours')::int * interval '1 hour');

    INSERT INTO public.tasks (
      title,
      description,
      due_at,
      assignee_user_id,        -- canonical column name (was the bug)
      deal_id,
      auto_generated,
      metadata
    )
    VALUES (
      tpl.task_template->>'title',
      tpl.task_template->>'description',
      v_due,
      v_assignee,
      NEW.id,
      true,
      jsonb_build_object(
        'template_id', tpl.id,
        'trigger_event', 'deal.stage_changed',
        'to_stage', NEW.stage_key,
        'priority', tpl.task_template->>'priority'
      )
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_apply_task_templates ON public.deals;
CREATE TRIGGER deals_apply_task_templates
  AFTER UPDATE OF stage_key ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_apply_task_templates_fn();


-- Re-schedule the reminder cron with the canonical column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed; tasks_reminder_daily NOT scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('tasks_reminder_daily')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'tasks_reminder_daily'
    );

  PERFORM cron.schedule(
    'tasks_reminder_daily',
    '0 7 * * *',
    $cmd$
      WITH due AS (
        SELECT id, title, due_at, assignee_user_id, deal_id, listing_id
          FROM public.tasks
         WHERE due_at IS NOT NULL
           AND due_at BETWEEN now() AND now() + interval '24 hours'
           AND completed_at IS NULL
           AND last_reminder_sent_at IS NULL
           AND assignee_user_id IS NOT NULL
         LIMIT 500
      ),
      inserted AS (
        INSERT INTO public.notifications (
          recipient_user_id, kind, title, body, href, metadata, created_at
        )
        SELECT
          assignee_user_id,
          'task.due_soon',
          'Task due within 24h: ' || title,
          'Due ' || to_char(due_at, 'Mon DD HH24:MI'),
          CASE WHEN deal_id IS NOT NULL THEN '/deals/' || deal_id::text
               ELSE '/tasks' END,
          jsonb_build_object('task_id', id, 'deal_id', deal_id),
          now()
          FROM due
        RETURNING (metadata->>'task_id')::uuid AS task_id
      )
      UPDATE public.tasks
         SET last_reminder_sent_at = now()
       WHERE id IN (SELECT task_id FROM inserted);
    $cmd$
  );
END $$;


NOTIFY pgrst, 'reload schema';
