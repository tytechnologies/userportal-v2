-- Add `metadata jsonb` to public.tasks.
--
-- Why this is needed:
--   • DealTasksPanel.vue selects `metadata` to surface auto-generated
--     badge tooltips ("auto-created when deal moved to <stage>") and
--     a high-priority chip. Without the column, PostgREST returns
--     400 on every load of the deal page's tasks panel.
--   • deals_apply_task_templates_fn (mig 20260507000024 + the
--     remediation in 20260507000025/30) already INSERTs into
--     `metadata` when materializing a task from automation_task_templates.
--     The function would 23502 (or "column does not exist") on a fresh
--     DB without this column — silently wedging the auto-task pipeline.
--
-- ROLLBACK:
--   ALTER TABLE public.tasks DROP COLUMN IF EXISTS metadata;
--   NOTIFY pgrst, 'reload schema';
--
-- Additive-only — no data movement, no constraint changes, no
-- existing-column edits. Safe to apply on a populated database.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.tasks.metadata IS
  'Free-form structured payload. Auto-tasks (auto_generated=true) carry { template_id, to_stage, priority } so the UI can render origin/priority badges; manual tasks default to {}.';

-- Refresh PostgREST schema cache so the column is queryable in the
-- same deployment without a process restart.
NOTIFY pgrst, 'reload schema';
