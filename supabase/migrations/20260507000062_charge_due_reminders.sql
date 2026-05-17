-- Charge Due Reminders.
--
-- Daily cron that finds open property_charges due in 7/3/1/0 days
-- and enqueues 'charge.due_soon' outbound_emails. Idempotent via
-- dedupe_key='charge-reminder:<charge_id>:<window>' so each charge
-- nudges at most 4 times across the run-up to its due_at.
--
-- ROLLBACK:
--   SELECT cron.unschedule('property_charges_due_reminders_daily');
--   DROP FUNCTION IF EXISTS public.enqueue_due_charge_reminders();


CREATE OR REPLACE FUNCTION public.enqueue_due_charge_reminders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted int := 0;
BEGIN
  -- One INSERT per (charge, reminder_window) tuple. Recipient = the
  -- charged-to user (preferred) or the external email on the charge.
  -- Profile join provides email + display name when user_id set.
  WITH candidates AS (
    SELECT
      pc.id                                                           AS charge_id,
      pc.charge_no,
      pc.kind,
      pc.total_minor,
      pc.currency,
      pc.due_at,
      pc.charged_to_user_id,
      coalesce(p.email, pc.charged_to_external_email)                 AS to_email,
      coalesce(p.full_name, pc.charged_to_external_name)              AS to_name,
      (pc.due_at::date - current_date)                                AS days_until_due
    FROM public.property_charges pc
    LEFT JOIN public.profiles p ON p.id = pc.charged_to_user_id
    WHERE pc.status = 'open'
      AND pc.due_at IS NOT NULL
      AND (pc.due_at::date - current_date) IN (7, 3, 1, 0)
      AND coalesce(p.email, pc.charged_to_external_email) IS NOT NULL
  ),
  windowed AS (
    SELECT
      c.*,
      CASE c.days_until_due
        WHEN 7 THEN 'T-7d'
        WHEN 3 THEN 'T-3d'
        WHEN 1 THEN 'T-1d'
        WHEN 0 THEN 'T-0d'
      END AS reminder_window
    FROM candidates c
  ),
  inserted AS (
    INSERT INTO public.outbound_emails
      (to_email, to_name, recipient_user_id, template_kind, subject,
       template_input, dedupe_key, reference_kind, reference_id, max_attempts)
    SELECT
      w.to_email,
      w.to_name,
      w.charged_to_user_id,
      'charge.due_soon',
      'Reminder: ' || w.charge_no || ' due ' ||
        CASE w.reminder_window
          WHEN 'T-0d' THEN 'today'
          WHEN 'T-1d' THEN 'tomorrow'
          WHEN 'T-3d' THEN 'in 3 days'
          WHEN 'T-7d' THEN 'in 7 days'
        END,
      jsonb_build_object(
        'recipientName', w.to_name,
        'title',         w.charge_no,
        'body',
          w.kind || ' charge for ' || w.currency || ' ' ||
          to_char((w.total_minor::numeric / 100), 'FM999,999,999.00') ||
          ', due ' || to_char(w.due_at, 'YYYY-MM-DD'),
        'hrefAbsolute', NULL
      ),
      'charge-reminder:' || w.charge_id::text || ':' || w.reminder_window,
      'property_charge',
      w.charge_id::text,
      3
    FROM windowed w
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_inserted FROM inserted;

  RETURN jsonb_build_object('enqueued', coalesce(v_inserted, 0));
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_due_charge_reminders() TO authenticated;


-- Daily cron at 09:00 UTC (≈ 5 PM PH time — late afternoon nudge).
DO $$
BEGIN
  PERFORM cron.unschedule('property_charges_due_reminders_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'property_charges_due_reminders_daily');
  PERFORM cron.schedule(
    'property_charges_due_reminders_daily',
    '0 9 * * *',
    $cron$ SELECT public.enqueue_due_charge_reminders(); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'property_charges_due_reminders cron: pg_cron unavailable';
END $$;


NOTIFY pgrst, 'reload schema';
