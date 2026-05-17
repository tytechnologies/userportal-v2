-- Dedicated cancel_reason column on eis_submissions.
--
-- Previously the cancel endpoint appended "[CANCELLED] reason" to
-- response_notes, which mixed operator-side cancellation reasons in
-- with BIR-side response text. Splitting them out lets the UI render
-- each independently and keeps response_notes truly BIR-sourced.
--
-- The freeze trigger (migration 066) already allows status mutation
-- on submitted/accepted rows; we extend the allow-list to include
-- cancel_reason since cancellation is operator-driven not BIR-driven.
--
-- ROLLBACK:
--   ALTER TABLE public.eis_submissions DROP COLUMN IF EXISTS cancel_reason;
--   -- Restore the freeze trigger to the strict version (migration 066).

ALTER TABLE public.eis_submissions
  ADD COLUMN IF NOT EXISTS cancel_reason text;

COMMENT ON COLUMN public.eis_submissions.cancel_reason IS
  'Operator-supplied reason when status=cancelled. Set by /api/admin/eis-submissions/:id/cancel.';

-- Update the freeze trigger to allow cancel_reason mutation post-submit.
-- The cancel endpoint sets it AFTER the row may have moved through
-- submitted, so the trigger needs to permit it explicitly.
CREATE OR REPLACE FUNCTION public._eis_submissions_block_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('submitted', 'accepted') THEN
    IF NEW.payload      IS DISTINCT FROM OLD.payload      OR
       NEW.document_kind IS DISTINCT FROM OLD.document_kind OR
       NEW.reference_kind IS DISTINCT FROM OLD.reference_kind OR
       NEW.reference_id   IS DISTINCT FROM OLD.reference_id THEN
      RAISE EXCEPTION
        'eis_submissions row % is frozen (status=%); payload/refs cannot change',
        OLD.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
