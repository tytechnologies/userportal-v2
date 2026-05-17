-- Tasks + deals audit columns.
--
-- Companion to mig 20260514000007 (which added created_by + updated_by
-- to contacts). The same audit-completeness story applies to the
-- other primary CRM tables.
--
-- This migration adds, on each table:
--   - public.tasks  — created_by (new) + updated_by (new)
--   - public.deals  — updated_by (new); created_by already existed
--
-- inquiries is intentionally OUT OF SCOPE — that table is fed by the
-- public website's anon endpoint as well as the portal, and the anon
-- path has no auth.uid() to stamp. `sender_user_id` already captures
-- "who submitted" for the rare authenticated-submitter case; there's
-- no equivalent of a CRM "who created this row" question for inquiries.
--
-- All adds are IF NOT EXISTS so envs that already have the columns
-- (e.g. from a later refactor) survive cleanly. Trigger functions
-- are idempotent via CREATE OR REPLACE; triggers via DROP-then-CREATE.
--
-- Caveat — `auth.uid()` returns NULL in the Supabase SQL editor
-- because the editor runs as `postgres`, not under an end-user JWT.
-- The DEFAULTs fire correctly for app-driven traffic (web requests
-- through the user-scoped supabase client) but appear to do nothing
-- when poked from the editor. Same caveat applies to the contacts
-- audit migration (20260514000007).
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS set_tasks_updated_by ON public.tasks;
--   DROP TRIGGER IF EXISTS set_deals_updated_by ON public.deals;
--   DROP FUNCTION IF EXISTS public.tasks_stamp_updated_by();
--   DROP FUNCTION IF EXISTS public.deals_stamp_updated_by();
--   ALTER TABLE public.tasks
--     DROP COLUMN IF EXISTS updated_by,
--     DROP COLUMN IF EXISTS created_by;
--   ALTER TABLE public.deals DROP COLUMN IF EXISTS updated_by;


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='tasks') THEN
    RAISE EXCEPTION 'Migration 20260514000008 requires public.tasks'
      USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='deals') THEN
    RAISE EXCEPTION 'Migration 20260514000008 requires public.deals'
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. public.tasks — created_by + updated_by
-- =====================================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.tasks
  ALTER COLUMN created_by SET DEFAULT auth.uid();

COMMENT ON COLUMN public.tasks.created_by IS
  'auth.uid() stamp at INSERT via DEFAULT. Clients NEVER pass this.';
COMMENT ON COLUMN public.tasks.updated_by IS
  'auth.uid() stamp at every UPDATE via tasks_stamp_updated_by trigger.';

CREATE OR REPLACE FUNCTION public.tasks_stamp_updated_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS set_tasks_updated_by ON public.tasks;
CREATE TRIGGER set_tasks_updated_by
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_stamp_updated_by();

-- Backfill — most CRM tables track owner_user_id or assignee_user_id;
-- tasks uses `owner_user_id` (the creator, per mig 20260501000009).
-- Plausible stand-in for created_by on pre-existing rows.
UPDATE public.tasks
   SET created_by = owner_user_id
 WHERE created_by IS NULL
   AND owner_user_id IS NOT NULL;


-- =====================================================================
-- 2. public.deals — updated_by (created_by already exists)
-- =====================================================================

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.deals.updated_by IS
  'auth.uid() stamp at every UPDATE via deals_stamp_updated_by trigger.';

CREATE OR REPLACE FUNCTION public.deals_stamp_updated_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS set_deals_updated_by ON public.deals;
CREATE TRIGGER set_deals_updated_by
  BEFORE UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_stamp_updated_by();


-- =====================================================================
-- 3. PostgREST schema cache
-- =====================================================================

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
-- 1) Columns + defaults landed.
-- SELECT table_name, column_name, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public'
--    AND ((table_name='tasks' AND column_name IN ('created_by','updated_by'))
--      OR (table_name='deals' AND column_name='updated_by'))
--  ORDER BY table_name, column_name;
-- Expect: tasks.created_by default = 'auth.uid()'; others null (triggers do work).
--
-- 2) Triggers registered.
-- SELECT tgname FROM pg_trigger
--  WHERE tgrelid IN ('public.tasks'::regclass, 'public.deals'::regclass)
--    AND tgname IN ('set_tasks_updated_by', 'set_deals_updated_by');
--
-- 3) App-side verification: create a task via POST /api/tasks, then
--    update it via PATCH. Both stamp fields land:
-- SELECT id, title, created_by, updated_by FROM public.tasks
--  ORDER BY created_at DESC LIMIT 1;
