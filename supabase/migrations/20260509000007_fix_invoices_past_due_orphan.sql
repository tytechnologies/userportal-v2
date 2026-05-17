-- Hotfix: invoices_check_past_due_fn() references the
-- organization_subscriptions table, which migration
-- 20260507000058_remove_plans_subscriptions.sql dropped on 2026-05-08.
-- Result: the cron has been failing every night since 2026-05-08 with
-- "relation public.organization_subscriptions does not exist".
--
-- Two ways to clean this up:
--
--   A) Drop the cron + function entirely. Defensible since
--      subscriptions are gone and the invoice past_due timeline isn't
--      currently consumed anywhere.
--
--   B) Rewrite the function to keep the invoice-side flips
--      (invoices.status: open → past_due → uncollectible) and remove
--      the subscription-side cascade. Defensible since the invoices
--      table itself is still in use, and a daily flag is cheap.
--
-- Choosing B — the invoice past_due signal is still useful for
-- collections workflows even without a subscription concept. Switching
-- to A is a one-line change later if the team confirms invoices are
-- also obsolete.
--
-- Behavior change vs. the original:
--   - DROPPED: subscription auto-flip to past_due
--   - DROPPED: subscription auto-cancel after 14d uncollectible
--   - KEPT:    invoice flip open → past_due (overdue)
--   - KEPT:    invoice flip past_due → uncollectible (>14d overdue)

CREATE OR REPLACE FUNCTION public.invoices_check_past_due_fn()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flagged_past_due int;
  v_uncollectible    int;
  v_invoices_exists  boolean;
BEGIN
  -- Defense in depth — if migration 51's `invoices` table also gets
  -- dropped later, surface a clean no-op rather than a relation
  -- error from the function body. Cheap pg_class lookup.
  SELECT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'invoices' AND c.relkind = 'r'
  ) INTO v_invoices_exists;

  IF NOT v_invoices_exists THEN
    RETURN jsonb_build_object(
      'flagged_past_due', 0,
      'uncollectible',    0,
      'note',             'invoices table not present; cron is a no-op'
    );
  END IF;

  -- Flip overdue invoices to past_due. Subscription cascade dropped
  -- because organization_subscriptions no longer exists.
  WITH flipped AS (
    UPDATE public.invoices
       SET status = 'past_due'
     WHERE status = 'open'
       AND due_at IS NOT NULL
       AND due_at < now()
     RETURNING id
  )
  SELECT count(*) INTO v_flagged_past_due FROM flipped;

  -- Promote past_due → uncollectible after 14 days. Subscription
  -- cancel cascade dropped for the same reason.
  WITH uncollectible AS (
    UPDATE public.invoices
       SET status = 'uncollectible'
     WHERE status = 'past_due'
       AND due_at IS NOT NULL
       AND due_at < (now() - interval '14 days')
     RETURNING id
  )
  SELECT count(*) INTO v_uncollectible FROM uncollectible;

  RETURN jsonb_build_object(
    'flagged_past_due', coalesce(v_flagged_past_due, 0),
    'uncollectible',    coalesce(v_uncollectible, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.invoices_check_past_due_fn() TO authenticated;
