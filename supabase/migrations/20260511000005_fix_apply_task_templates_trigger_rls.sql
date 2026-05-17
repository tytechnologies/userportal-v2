-- Fix: deal stage transitions that match an automation_task_templates
-- rule will 500 with
--   "new row violates row-level security policy for table tasks"
-- once any rule is seeded.
--
-- Same bug class as 20260511000001 (deal_stage_history). The trigger
-- function `deals_apply_task_templates_fn` (defined in
-- 20260507000025) inserts into public.tasks without SECURITY DEFINER,
-- so it runs as the calling user. The tasks INSERT policy (from
-- 20260501000009) requires owner_user_id = auth.uid() OR
-- has_permission('tasks.write.all'). The trigger's INSERT doesn't
-- set owner_user_id — auto-generated tasks have no owner — so RLS
-- blocks every agent transition.
--
-- Same fix: mark the function SECURITY DEFINER so it runs as the
-- owning role (postgres) and bypasses RLS. The function still gates
-- which rules fire via the SELECT against automation_task_templates,
-- so this widens nothing the operator hasn't already approved by
-- enabling a template rule.
--
-- Untouched: the trigger registration in 20260507000025 — only the
-- function body needs to flip.
--
-- ROLLBACK: re-CREATE OR REPLACE without SECURITY DEFINER. Don't.

CREATE OR REPLACE FUNCTION public.deals_apply_task_templates_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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
      assignee_user_id,
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
