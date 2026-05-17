-- Auto-hide reviews that hit a critical-mass of abuse reports.
--
-- Threshold: 3 distinct reporters → review.hidden_at = now().
-- Reasoning:
--   - 1-2 reports could be a single bad-faith reporter. We don't
--     auto-hide on that signal; admin moderates manually.
--   - 3 distinct reporters is rare for legitimate reviews and
--     common for genuinely problematic ones. Buys the admin time
--     before the review accrues views; admin can unhide after
--     review if it was a brigade.
--   - The unique (review_id, reporter_user_id) constraint already
--     guarantees "distinct reporters" — count(*) on review_reports
--     IS the distinct count.
--
-- The trigger fires AFTER INSERT on review_reports. The hidden_by
-- field is set to NULL (the system did this, not a person); the
-- hidden_reason carries a marker so admins reviewing the queue can
-- distinguish auto-hidden from manually-hidden.
--
-- Reversible: an admin can unhide via PATCH /api/reviews/:id with
-- hidden=false (which sets hidden_at=null). The reports queue still
-- shows the underlying flags so the admin can dismiss or escalate.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS review_reports_auto_hide
--     ON public.review_reports;
--   DROP FUNCTION IF EXISTS public.review_reports_auto_hide_fn();
--
-- DEPENDS ON: 20260507000018 (reviews + review_reports tables)


CREATE OR REPLACE FUNCTION public.review_reports_auto_hide_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open_count integer;
BEGIN
  -- Only check on transitions that ADD a new open report. Updates
  -- (e.g., admin flipping status to 'reviewed' or 'dismissed') don't
  -- change the trigger condition.
  IF TG_OP = 'INSERT' AND NEW.status = 'open' THEN
    SELECT count(*) INTO v_open_count
      FROM public.review_reports
     WHERE review_id = NEW.review_id
       AND status = 'open';

    IF v_open_count >= 3 THEN
      UPDATE public.reviews
         SET hidden_at = now(),
             hidden_reason = 'auto-hidden: ' || v_open_count
                          || ' open reports',
             hidden_by = NULL
       WHERE id = NEW.review_id
         AND hidden_at IS NULL;  -- don't clobber a manual hide
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS review_reports_auto_hide ON public.review_reports;
CREATE TRIGGER review_reports_auto_hide
  AFTER INSERT ON public.review_reports
  FOR EACH ROW EXECUTE FUNCTION public.review_reports_auto_hide_fn();

COMMENT ON FUNCTION public.review_reports_auto_hide_fn() IS
  'Auto-hides reviews when 3+ distinct reporters file open reports. hidden_by=NULL marks system action; hidden_reason carries the count. Reversible via admin PATCH.';

NOTIFY pgrst, 'reload schema';
