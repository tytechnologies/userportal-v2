-- Fix: every deal-create request 500s with
--   "new row violates row-level security policy for table
--    deal_stage_history"
-- because the BEFORE-INSERT trigger that stamps the initial stage row
-- runs with the calling user's privileges, and deal_stage_history has
-- RLS enabled with no INSERT policy for `authenticated`.
--
-- The original migration (20260507000021_deals_pipeline.sql) commented
-- "INSERT happens via the trigger; not exposed to authenticated." —
-- that's the right intent, but it requires the trigger function to
-- bypass RLS, which only happens when the function is SECURITY DEFINER
-- and owned by a role that's exempt from RLS (postgres). Without
-- SECURITY DEFINER the trigger inherits the caller's auth context and
-- gets blocked by the missing INSERT policy.
--
-- Same applies to the UPDATE branch — agents transitioning a stage
-- would hit the same RLS wall. So both branches need the elevated
-- privilege.
--
-- ROLLBACK: re-CREATE OR REPLACE without SECURITY DEFINER (which
-- re-opens the bug). Don't.

CREATE OR REPLACE FUNCTION public.deals_record_stage_history_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
    VALUES (NEW.id, NULL, NEW.stage_key, NEW.created_by);
  ELSIF TG_OP = 'UPDATE' AND NEW.stage_key IS DISTINCT FROM OLD.stage_key THEN
    INSERT INTO public.deal_stage_history (deal_id, from_stage, to_stage, changed_by)
    VALUES (NEW.id, OLD.stage_key, NEW.stage_key, auth.uid());
    NEW.stage_entered_at := now();
  END IF;
  RETURN NEW;
END;
$$;
