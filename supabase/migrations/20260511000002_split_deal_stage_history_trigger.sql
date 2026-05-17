-- Fix: deal-create still 500s after 20260511000001 with
--   "insert or update on table deal_stage_history violates foreign
--    key constraint deal_stage_history_deal_id_fkey"
--
-- The trigger was registered as BEFORE INSERT on public.deals — so it
-- fires before the new deal row is written, then tries to insert
-- (deal_id = NEW.id) into deal_stage_history. The FK
-- deal_stage_history.deal_id → deals(id) can't validate the parent
-- yet, and the whole transaction aborts.
--
-- We can't just flip the existing trigger to AFTER because the UPDATE
-- branch sets NEW.stage_entered_at — that only persists from a BEFORE
-- trigger. Two triggers with the same function, different timings:
--
--   AFTER INSERT  — deal exists by then; FK is satisfied
--   BEFORE UPDATE — stage transition; mutates NEW.stage_entered_at
--
-- The function already gates on TG_OP so each trigger executes only
-- its relevant branch.
--
-- ROLLBACK: re-create the unified BEFORE INSERT OR UPDATE trigger
-- (which re-opens the bug). Don't.

DROP TRIGGER IF EXISTS deals_record_stage_history ON public.deals;

CREATE TRIGGER deals_record_stage_history_insert
  AFTER INSERT ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_record_stage_history_fn();

CREATE TRIGGER deals_record_stage_history_update
  BEFORE UPDATE OF stage_key ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_record_stage_history_fn();
