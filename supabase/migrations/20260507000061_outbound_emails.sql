-- Outbound Emails — queue + worker dequeue.
--
-- Bridge between in-app notifications (which already cover internal
-- portal users via notify()) and the external-recipient sends needed
-- for B3 envelope signers, B5 broker invitations, M platform-fee
-- invoice notices, and C3/C5 statement / charge reminders that go
-- to agent / tenant / owner email addresses regardless of whether
-- they have a portal account.
--
-- Queue → worker pattern:
--   1. Application code calls enqueueOutboundEmail() helper, which
--      inserts a row with status='pending'.
--   2. Cron-driven worker (POST /api/internal/email-worker-tick)
--      calls outbound_email_dequeue() to claim a batch via
--      FOR UPDATE SKIP LOCKED.
--   3. Worker renders + sends via the existing email.ts.
--   4. Worker calls outbound_email_record_outcome() to record success/failure.
--
-- The actual sendEmail() in email.ts remains a no-op stub until a
-- real provider lands; the queue still fills + records intent so
-- ops sees what's happening.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.outbound_email_record_outcome(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.outbound_email_dequeue(int);
--   DROP FUNCTION IF EXISTS public.outbound_email_unstick();
--   DROP TABLE IF EXISTS public.outbound_emails;
--   DELETE FROM public.role_permissions WHERE permission = 'outbound_emails.manage';
--   DELETE FROM public.permissions WHERE name = 'outbound_emails.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.outbound_emails';


-- =====================================================================
-- 1. outbound_emails — queue table
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.outbound_emails (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  to_email            text NOT NULL CHECK (to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  to_name             text,
  recipient_user_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Documented kinds: 'envelope.invitation', 'envelope.completed',
  -- 'envelope.declined', 'platform_fee.invoice_issued',
  -- 'org.invitation_sent', 'statement.tenant_issued',
  -- 'statement.owner_issued', 'charge.due_soon'.
  template_kind       text NOT NULL,
  subject             text NOT NULL,
  -- Template-specific render input. Worker calls renderEmail(template_kind, ...).
  template_input      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Lifecycle.
  status              text NOT NULL DEFAULT 'pending'
                           CHECK (status IN
                             ('pending', 'attempting', 'sent',
                              'failed', 'skipped', 'cancelled')),

  attempts            int NOT NULL DEFAULT 0,
  max_attempts        int NOT NULL DEFAULT 3,

  scheduled_at        timestamptz NOT NULL DEFAULT now(),
  attempted_at        timestamptz,  -- last attempt
  sent_at             timestamptz,
  failed_at           timestamptz,
  failure_reason      text,

  -- Provenance.
  reference_kind      text,         -- 'envelope', 'platform_fee_settlement', etc.
  reference_id        text,
  -- UNIQUE for idempotent enqueue per logical event.
  dedupe_key          text UNIQUE,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_emails_status_idx
  ON public.outbound_emails(status, scheduled_at)
  WHERE status IN ('pending', 'attempting');
CREATE INDEX IF NOT EXISTS outbound_emails_recipient_idx
  ON public.outbound_emails(to_email, status);
CREATE INDEX IF NOT EXISTS outbound_emails_reference_idx
  ON public.outbound_emails(reference_kind, reference_id)
  WHERE reference_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_outbound_emails_updated_at ON public.outbound_emails;
CREATE TRIGGER set_outbound_emails_updated_at
  BEFORE UPDATE ON public.outbound_emails
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.outbound_emails IS
  'External-recipient email queue. UNIQUE(dedupe_key) for idempotent enqueue. Worker uses FOR UPDATE SKIP LOCKED to claim batches without contention.';


-- =====================================================================
-- 2. outbound_email_dequeue — worker claim
-- =====================================================================
--
-- Returns up to p_batch_size pending rows. Atomically marks them
-- 'attempting' and increments attempts so a crash mid-send is
-- visible (max_attempts gates retries). FOR UPDATE SKIP LOCKED
-- partitions the batch across concurrent workers.

CREATE OR REPLACE FUNCTION public.outbound_email_dequeue(p_batch_size int DEFAULT 50)
RETURNS TABLE (
  id              uuid,
  to_email        text,
  to_name         text,
  template_kind   text,
  subject         text,
  template_input  jsonb,
  attempts        int,
  reference_kind  text,
  reference_id    text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Service-role only.
  IF session_user NOT IN ('postgres', 'supabase_admin', 'service_role')
     AND NOT public.has_permission('outbound_emails.manage')
  THEN
    RAISE EXCEPTION 'outbound_email_dequeue: permission denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT oe.id
    FROM public.outbound_emails oe
    WHERE oe.status = 'pending'
      AND oe.scheduled_at <= now()
      AND oe.attempts < oe.max_attempts
    ORDER BY oe.scheduled_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbound_emails oe
     SET status        = 'attempting',
         attempts      = oe.attempts + 1,
         attempted_at  = now()
   FROM claimed
   WHERE oe.id = claimed.id
   RETURNING oe.id, oe.to_email, oe.to_name, oe.template_kind, oe.subject,
             oe.template_input, oe.attempts, oe.reference_kind, oe.reference_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.outbound_email_dequeue(int) TO authenticated;


-- =====================================================================
-- 3. outbound_email_record_outcome — worker callback
-- =====================================================================

CREATE OR REPLACE FUNCTION public.outbound_email_record_outcome(
  p_id              uuid,
  p_status          text,        -- 'sent' | 'failed' | 'skipped'
  p_failure_reason  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  IF session_user NOT IN ('postgres', 'supabase_admin', 'service_role')
     AND NOT public.has_permission('outbound_emails.manage')
  THEN
    RAISE EXCEPTION 'outbound_email_record_outcome: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('sent', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'outbound_email_record_outcome: invalid status %', p_status;
  END IF;

  SELECT id, attempts, max_attempts, status INTO v_row
  FROM public.outbound_emails WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outbound_email_record_outcome: row not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'attempting' THEN
    -- Idempotent on already-finalized.
    RETURN p_id;
  END IF;

  IF p_status = 'sent' THEN
    UPDATE public.outbound_emails
       SET status         = 'sent',
           sent_at        = now(),
           failure_reason = NULL
     WHERE id = p_id;
  ELSIF p_status = 'skipped' THEN
    UPDATE public.outbound_emails
       SET status         = 'skipped',
           failure_reason = p_failure_reason
     WHERE id = p_id;
  ELSE  -- 'failed'
    -- Backoff: scheduled_at = now() + (attempts^2) minutes.
    -- After max_attempts, status stays 'failed' permanently.
    IF v_row.attempts >= v_row.max_attempts THEN
      UPDATE public.outbound_emails
         SET status         = 'failed',
             failed_at      = now(),
             failure_reason = p_failure_reason
       WHERE id = p_id;
    ELSE
      UPDATE public.outbound_emails
         SET status         = 'pending',
             scheduled_at   = now() + ((v_row.attempts * v_row.attempts) || ' minutes')::interval,
             failure_reason = p_failure_reason
       WHERE id = p_id;
    END IF;
  END IF;

  RETURN p_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.outbound_email_record_outcome(uuid, text, text) TO authenticated;


-- =====================================================================
-- 4. outbound_email_unstick — defensive sweep
-- =====================================================================
--
-- Flips 'attempting' rows older than 10 min back to 'pending'. Handles
-- worker crashes between dequeue and record_outcome.

CREATE OR REPLACE FUNCTION public.outbound_email_unstick()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  WITH unstuck AS (
    UPDATE public.outbound_emails
       SET status = 'pending'
     WHERE status = 'attempting'
       AND attempted_at < now() - interval '10 minutes'
       AND attempts < max_attempts
     RETURNING id
  )
  SELECT count(*) INTO v_count FROM unstuck;
  RETURN coalesce(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.outbound_email_unstick() TO authenticated;

-- Schedule the unstick sweep every 10 minutes.
DO $$
BEGIN
  PERFORM cron.unschedule('outbound_email_unstick_10min')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'outbound_email_unstick_10min');
  PERFORM cron.schedule(
    'outbound_email_unstick_10min',
    '*/10 * * * *',
    $cron$ SELECT public.outbound_email_unstick(); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'outbound_email cron: pg_cron unavailable; skipping schedule';
END $$;


-- =====================================================================
-- 5. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('outbound_emails.manage', 'Read + retry outbound email queue', 'platform')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'outbound_emails.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 6. RLS
-- =====================================================================

ALTER TABLE public.outbound_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_emails_select ON public.outbound_emails;
CREATE POLICY outbound_emails_select ON public.outbound_emails FOR SELECT
  TO authenticated
  USING (
    public.has_permission('outbound_emails.manage')
    OR public.has_permission('admin.access')
  );

-- INSERT/UPDATE blocked from authenticated. Helper function (TS) uses
-- service-role admin client; SECURITY DEFINER RPCs handle worker writes.


-- =====================================================================
-- 7. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.outbound_emails', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'External-recipient email queue + worker dequeue', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
