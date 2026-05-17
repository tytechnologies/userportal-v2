-- Document Envelopes — multi-party e-signature state machine.
--
-- B3 of the post-audit roadmap. Layers an envelope artifact above
-- the existing document_drafts so a single contract can route to
-- multiple signers (sequential or parallel), capture signing
-- evidence (PNG / typed name / click-to-sign + IP + UA), and emit
-- an append-only audit certificate suitable for legally-significant
-- transactions.
--
-- Existing surfaces preserved:
--   - document_drafts                — kept; envelopes reference them.
--   - document_drafts/[id]/signature — still works for internal forms.
--   - shared_drafts                  — unchanged.
--
-- ROLLBACK:
--   SELECT cron.unschedule('envelopes_auto_expire_hourly');
--   DROP FUNCTION IF EXISTS public.envelopes_auto_expire_fn();
--   DROP FUNCTION IF EXISTS public.envelope_audit_certificate(uuid);
--   DROP FUNCTION IF EXISTS public.envelope_reminder_due_recipients();
--   DROP FUNCTION IF EXISTS public.envelope_void(uuid, text);
--   DROP FUNCTION IF EXISTS public.envelope_recipient_advance(uuid, text, jsonb, text, text, text);
--   DROP FUNCTION IF EXISTS public.envelope_send(uuid);
--   DROP FUNCTION IF EXISTS public.envelope_can_read(uuid);
--   DROP FUNCTION IF EXISTS public.envelope_can_write(uuid);
--   DROP TABLE IF EXISTS public.envelope_recipient_tokens;
--   DROP TABLE IF EXISTS public.envelope_audit_events;
--   DROP TABLE IF EXISTS public.envelope_documents;
--   DROP TABLE IF EXISTS public.envelope_recipients;
--   DROP TABLE IF EXISTS public.document_envelopes;
--   DELETE FROM public.role_permissions WHERE permission IN
--     ('envelopes.send', 'envelopes.void', 'envelopes.read.all');
--   DELETE FROM public.permissions WHERE name IN
--     ('envelopes.send', 'envelopes.void', 'envelopes.read.all');
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.document_envelopes',
--      'public.envelope_recipients',
--      'public.envelope_documents',
--      'public.envelope_audit_events',
--      'public.envelope_recipient_tokens');


-- =====================================================================
-- 1. document_envelopes — envelope artifact + lifecycle
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.document_envelopes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title                    text NOT NULL,
  -- Email-body / cover-message included with invitations. Free-form;
  -- the email worker substitutes recipient name + envelope link.
  message                  text,

  -- 'sequential' = signers invited one at a time in sequence order.
  -- 'parallel'   = all signers invited simultaneously.
  routing_kind             text NOT NULL DEFAULT 'sequential'
                                CHECK (routing_kind IN ('sequential', 'parallel')),

  status                   text NOT NULL DEFAULT 'draft'
                                CHECK (status IN
                                  ('draft', 'sent', 'in_progress',
                                   'completed', 'declined', 'voided', 'expired')),

  -- Lifecycle stamps.
  sent_at                  timestamptz,
  completed_at             timestamptz,
  declined_at              timestamptz,
  voided_at                timestamptz,
  void_reason              text,
  expires_at               timestamptz,

  -- Reminder policy. NULL = no reminders. Min 1 hour, max 30 days.
  reminder_interval_hours  int CHECK (reminder_interval_hours IS NULL
                                      OR reminder_interval_hours BETWEEN 1 AND 720),
  last_reminder_sent_at    timestamptz,

  -- Optional deal context.
  deal_id                  uuid REFERENCES public.deals(id) ON DELETE SET NULL,

  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_envelopes_creator_idx
  ON public.document_envelopes(created_by, created_at DESC)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_envelopes_deal_idx
  ON public.document_envelopes(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_envelopes_status_idx
  ON public.document_envelopes(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS document_envelopes_expires_idx
  ON public.document_envelopes(expires_at)
  WHERE status IN ('sent', 'in_progress') AND expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS set_document_envelopes_updated_at ON public.document_envelopes;
CREATE TRIGGER set_document_envelopes_updated_at
  BEFORE UPDATE ON public.document_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.document_envelopes IS
  'E-signature envelope. Routes one or more document_drafts to one or more recipients. status state machine: draft -> sent -> in_progress -> completed (or declined/voided/expired). All transitions audited via envelope_audit_events.';


-- =====================================================================
-- 2. envelope_recipients — multi-party signer roster
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.envelope_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id         uuid NOT NULL REFERENCES public.document_envelopes(id) ON DELETE CASCADE,

  -- Identity. Either a portal user OR an external email — at least
  -- one MUST be set (CHECK below). For portal users the user_id
  -- gates auth at sign time; for externals the recipient_token does.
  user_id             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  external_email      text,
  external_name       text,

  role                text NOT NULL DEFAULT 'signer'
                           CHECK (role IN ('signer', 'approver', 'viewer', 'cc')),

  -- For sequential routing. Lower sequence signs first; ties broken
  -- by created_at. Ignored when envelope.routing_kind='parallel'.
  sequence            int NOT NULL DEFAULT 0,

  -- Required vs optional. Optional recipients (typical for cc/viewer)
  -- don't gate envelope completion.
  required            boolean NOT NULL DEFAULT true,

  state               text NOT NULL DEFAULT 'pending'
                           CHECK (state IN
                             ('pending', 'invited', 'opened',
                              'signed', 'declined', 'skipped')),
  invited_at          timestamptz,
  opened_at           timestamptz,
  signed_at           timestamptz,
  declined_at         timestamptz,
  decline_reason      text,

  -- Signature evidence. Polymorphic jsonb shape:
  --   { kind: 'png'|'typed'|'click_to_sign',
  --     s3_key?: text,        -- when kind='png'
  --     name_typed?: text,    -- when kind='typed'
  --     consent_text?: text   -- when kind='click_to_sign' }
  signature_evidence  jsonb NOT NULL DEFAULT '{}'::jsonb,
  signed_from_ip      inet,
  signed_from_ua      text,

  notes               text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (user_id IS NOT NULL OR external_email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS envelope_recipients_envelope_idx
  ON public.envelope_recipients(envelope_id, sequence, created_at);
CREATE INDEX IF NOT EXISTS envelope_recipients_user_idx
  ON public.envelope_recipients(user_id, state)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_recipients_active_idx
  ON public.envelope_recipients(envelope_id, state, sequence)
  WHERE state IN ('pending', 'invited', 'opened');

DROP TRIGGER IF EXISTS set_envelope_recipients_updated_at ON public.envelope_recipients;
CREATE TRIGGER set_envelope_recipients_updated_at
  BEFORE UPDATE ON public.envelope_recipients
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 3. envelope_documents — link envelope <-> document_drafts
-- =====================================================================
--
-- Many-to-many: an envelope can carry multiple drafts, and (rarely)
-- a draft could appear in multiple envelopes (versions/amendments).
-- ON DELETE RESTRICT on document_draft_id stops a hard-delete of a
-- draft that's bound to an envelope — preserves signing evidence.

CREATE TABLE IF NOT EXISTS public.envelope_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id         uuid NOT NULL REFERENCES public.document_envelopes(id) ON DELETE CASCADE,
  document_draft_id   uuid NOT NULL REFERENCES public.document_drafts(id) ON DELETE RESTRICT,
  display_order       int  NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (envelope_id, document_draft_id)
);

CREATE INDEX IF NOT EXISTS envelope_documents_envelope_idx
  ON public.envelope_documents(envelope_id, display_order);
CREATE INDEX IF NOT EXISTS envelope_documents_draft_idx
  ON public.envelope_documents(document_draft_id);


-- =====================================================================
-- 4. envelope_audit_events — append-only certificate trail
-- =====================================================================
--
-- INSERT only via the RPC layer (RLS denies INSERT from authenticated
-- callers; SECURITY DEFINER RPCs do the writes). UPDATE / DELETE
-- denied entirely.

CREATE TABLE IF NOT EXISTS public.envelope_audit_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id         uuid NOT NULL REFERENCES public.document_envelopes(id) ON DELETE CASCADE,
  recipient_id        uuid REFERENCES public.envelope_recipients(id) ON DELETE SET NULL,

  -- Free-form text — operators can extend without migration.
  -- Documented kinds: 'created', 'sent', 'invited', 'opened',
  -- 'signed', 'declined', 'voided', 'expired', 'reminder_sent',
  -- 'recipient_added', 'recipient_removed'.
  event_kind          text NOT NULL,

  actor_user_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_email         text,
  actor_ip            inet,
  actor_ua            text,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  occurred_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS envelope_audit_events_envelope_idx
  ON public.envelope_audit_events(envelope_id, occurred_at);
CREATE INDEX IF NOT EXISTS envelope_audit_events_recipient_idx
  ON public.envelope_audit_events(recipient_id) WHERE recipient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelope_audit_events_kind_idx
  ON public.envelope_audit_events(event_kind, occurred_at DESC);

COMMENT ON TABLE public.envelope_audit_events IS
  'Append-only certificate trail. INSERT via RPC only; UPDATE and DELETE blocked. Each row captures actor identity, IP, UA, and free-form metadata at occurred_at.';


-- =====================================================================
-- 5. envelope_recipient_tokens — single-use external-signer keys
-- =====================================================================
--
-- 32 random bytes hex-encoded. Single-use for the SIGN action;
-- viewing / opening doesn't consume. SELECT blocked at the policy
-- layer — tokens leave the DB only at INSERT time (RPC return) and
-- travel via the email worker.

CREATE TABLE IF NOT EXISTS public.envelope_recipient_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id    uuid NOT NULL REFERENCES public.envelope_recipients(id) ON DELETE CASCADE,
  -- Lookup key for /api/public/envelope-sign/:token. UNIQUE prevents
  -- rare collision; gen_random_bytes(32) gives 256 bits of entropy.
  token           text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS envelope_recipient_tokens_recipient_idx
  ON public.envelope_recipient_tokens(recipient_id);
CREATE INDEX IF NOT EXISTS envelope_recipient_tokens_active_idx
  ON public.envelope_recipient_tokens(token)
  WHERE consumed_at IS NULL;


-- =====================================================================
-- 6. RLS helpers
-- =====================================================================

CREATE OR REPLACE FUNCTION public.envelope_can_read(p_envelope_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('envelopes.read.all')
    OR EXISTS (
      SELECT 1 FROM public.document_envelopes e
       WHERE e.id = p_envelope_id
         AND e.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.envelope_recipients r
       WHERE r.envelope_id = p_envelope_id
         AND r.user_id = auth.uid()
    );
$$;
GRANT EXECUTE ON FUNCTION public.envelope_can_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.envelope_can_write(p_envelope_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('envelopes.read.all')
    OR EXISTS (
      SELECT 1 FROM public.document_envelopes e
       WHERE e.id = p_envelope_id
         AND e.created_by = auth.uid()
    );
$$;
GRANT EXECUTE ON FUNCTION public.envelope_can_write(uuid) TO authenticated;


-- =====================================================================
-- 7. envelope_send — transition draft -> sent, generate tokens
-- =====================================================================

CREATE OR REPLACE FUNCTION public.envelope_send(p_envelope_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_envelope record;
  v_signer_count int;
  v_doc_count    int;
  v_default_expires timestamptz;
BEGIN
  IF NOT (
    public.envelope_can_write(p_envelope_id)
    OR public.has_permission('envelopes.send')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'envelope_send: permission denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_envelope FROM public.document_envelopes WHERE id = p_envelope_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'envelope_send: envelope % not found', p_envelope_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_envelope.status <> 'draft' THEN
    RAISE EXCEPTION 'envelope_send: envelope must be in draft status (got %)', v_envelope.status;
  END IF;

  SELECT count(*) INTO v_signer_count
  FROM public.envelope_recipients
  WHERE envelope_id = p_envelope_id AND role IN ('signer', 'approver');
  IF v_signer_count = 0 THEN
    RAISE EXCEPTION 'envelope_send: at least one signer or approver is required';
  END IF;

  SELECT count(*) INTO v_doc_count
  FROM public.envelope_documents
  WHERE envelope_id = p_envelope_id;
  IF v_doc_count = 0 THEN
    RAISE EXCEPTION 'envelope_send: at least one document is required';
  END IF;

  v_default_expires := coalesce(v_envelope.expires_at, now() + interval '30 days');

  -- Generate per-recipient tokens.
  INSERT INTO public.envelope_recipient_tokens (recipient_id, token, expires_at)
  SELECT
    r.id,
    encode(gen_random_bytes(32), 'hex'),
    v_default_expires
  FROM public.envelope_recipients r
  WHERE r.envelope_id = p_envelope_id;

  -- Mark envelope sent.
  UPDATE public.document_envelopes
     SET status     = 'sent',
         sent_at    = now(),
         expires_at = v_default_expires
   WHERE id = p_envelope_id;

  -- Invite recipients depending on routing_kind.
  IF v_envelope.routing_kind = 'parallel' THEN
    UPDATE public.envelope_recipients
       SET state = 'invited', invited_at = now()
     WHERE envelope_id = p_envelope_id
       AND state = 'pending';
  ELSE
    UPDATE public.envelope_recipients
       SET state = 'invited', invited_at = now()
     WHERE id IN (
       SELECT id FROM public.envelope_recipients
        WHERE envelope_id = p_envelope_id
          AND state = 'pending'
          AND role IN ('signer', 'approver')
        ORDER BY sequence ASC, created_at ASC
        LIMIT 1
     );
    -- Viewers / cc are invited immediately under both routing kinds.
    UPDATE public.envelope_recipients
       SET state = 'invited', invited_at = now()
     WHERE envelope_id = p_envelope_id
       AND state = 'pending'
       AND role IN ('viewer', 'cc');
  END IF;

  -- Audit.
  INSERT INTO public.envelope_audit_events
    (envelope_id, event_kind, actor_user_id, metadata)
  VALUES
    (p_envelope_id, 'sent', auth.uid(),
     jsonb_build_object('routing_kind', v_envelope.routing_kind,
                        'signer_count', v_signer_count,
                        'doc_count', v_doc_count));

  RETURN p_envelope_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.envelope_send(uuid) TO authenticated;


-- =====================================================================
-- 8. envelope_recipient_advance — sign / decline / open
-- =====================================================================

CREATE OR REPLACE FUNCTION public.envelope_recipient_advance(
  p_recipient_id   uuid,
  p_action         text,        -- 'sign' | 'decline' | 'open'
  p_evidence       jsonb DEFAULT '{}'::jsonb,
  p_ip             text  DEFAULT NULL,
  p_ua             text  DEFAULT NULL,
  p_decline_reason text  DEFAULT NULL,
  p_token          text  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recipient record;
  v_envelope  record;
  v_remaining int;
  v_advance_to_id uuid;
BEGIN
  SELECT * INTO v_recipient FROM public.envelope_recipients WHERE id = p_recipient_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'envelope_recipient_advance: recipient % not found', p_recipient_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Permission. Either the portal-user-recipient themselves, OR
  -- a service-role caller (token validated upstream).
  IF NOT (
    (v_recipient.user_id IS NOT NULL AND v_recipient.user_id = auth.uid())
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'envelope_recipient_advance: permission denied'
      USING ERRCODE = '42501';
  END IF;

  -- Token validation when caller passed one.
  IF p_token IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.envelope_recipient_tokens t
       WHERE t.recipient_id = p_recipient_id
         AND t.token = p_token
         AND t.consumed_at IS NULL
         AND t.expires_at > now()
    ) THEN
      RAISE EXCEPTION 'envelope_recipient_advance: invalid or consumed token';
    END IF;
  END IF;

  SELECT * INTO v_envelope FROM public.document_envelopes WHERE id = v_recipient.envelope_id;
  IF v_envelope.status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'envelope_recipient_advance: envelope is %, cannot advance', v_envelope.status;
  END IF;

  IF p_action = 'open' THEN
    IF v_recipient.state = 'invited' THEN
      UPDATE public.envelope_recipients
         SET state = 'opened', opened_at = now()
       WHERE id = p_recipient_id;
    END IF;
    INSERT INTO public.envelope_audit_events
      (envelope_id, recipient_id, event_kind, actor_user_id, actor_email, actor_ip, actor_ua)
    VALUES
      (v_recipient.envelope_id, p_recipient_id, 'opened',
       v_recipient.user_id, v_recipient.external_email,
       NULLIF(p_ip, '')::inet, p_ua);
    RETURN p_recipient_id;
  END IF;

  IF v_recipient.state NOT IN ('invited', 'opened') THEN
    RAISE EXCEPTION 'envelope_recipient_advance: recipient state must be invited/opened (got %)', v_recipient.state;
  END IF;

  IF p_action = 'sign' THEN
    UPDATE public.envelope_recipients
       SET state              = 'signed',
           signed_at          = now(),
           signature_evidence = COALESCE(p_evidence, '{}'::jsonb),
           signed_from_ip     = NULLIF(p_ip, '')::inet,
           signed_from_ua     = p_ua
     WHERE id = p_recipient_id;

    -- Mark token consumed.
    IF p_token IS NOT NULL THEN
      UPDATE public.envelope_recipient_tokens
         SET consumed_at = now()
       WHERE recipient_id = p_recipient_id AND token = p_token;
    END IF;

    INSERT INTO public.envelope_audit_events
      (envelope_id, recipient_id, event_kind, actor_user_id, actor_email, actor_ip, actor_ua, metadata)
    VALUES
      (v_recipient.envelope_id, p_recipient_id, 'signed',
       v_recipient.user_id, v_recipient.external_email,
       NULLIF(p_ip, '')::inet, p_ua,
       jsonb_build_object('evidence_kind', p_evidence->>'kind'));

    -- Bump envelope to in_progress on first signature.
    IF v_envelope.status = 'sent' THEN
      UPDATE public.document_envelopes
         SET status = 'in_progress'
       WHERE id = v_envelope.id;
    END IF;

    -- Sequential routing: invite the next pending signer.
    IF v_envelope.routing_kind = 'sequential' THEN
      SELECT id INTO v_advance_to_id
      FROM public.envelope_recipients
      WHERE envelope_id = v_recipient.envelope_id
        AND state = 'pending'
        AND role IN ('signer', 'approver')
      ORDER BY sequence ASC, created_at ASC
      LIMIT 1;

      IF v_advance_to_id IS NOT NULL THEN
        UPDATE public.envelope_recipients
           SET state = 'invited', invited_at = now()
         WHERE id = v_advance_to_id;

        INSERT INTO public.envelope_audit_events
          (envelope_id, recipient_id, event_kind, metadata)
        VALUES
          (v_recipient.envelope_id, v_advance_to_id, 'invited',
           jsonb_build_object('reason', 'sequential_advance'));
      END IF;
    END IF;

    -- Check completion: all required signers/approvers in 'signed'?
    SELECT count(*) INTO v_remaining
    FROM public.envelope_recipients
    WHERE envelope_id = v_recipient.envelope_id
      AND role IN ('signer', 'approver')
      AND required = true
      AND state <> 'signed';

    IF v_remaining = 0 THEN
      UPDATE public.document_envelopes
         SET status = 'completed', completed_at = now()
       WHERE id = v_recipient.envelope_id;

      INSERT INTO public.envelope_audit_events (envelope_id, event_kind)
      VALUES (v_recipient.envelope_id, 'completed');
    END IF;

    RETURN p_recipient_id;
  END IF;

  IF p_action = 'decline' THEN
    UPDATE public.envelope_recipients
       SET state          = 'declined',
           declined_at    = now(),
           decline_reason = p_decline_reason
     WHERE id = p_recipient_id;

    -- Decline by a required signer/approver kills the envelope.
    IF v_recipient.role IN ('signer', 'approver') AND v_recipient.required THEN
      UPDATE public.document_envelopes
         SET status = 'declined', declined_at = now()
       WHERE id = v_recipient.envelope_id;
    END IF;

    INSERT INTO public.envelope_audit_events
      (envelope_id, recipient_id, event_kind, actor_user_id, actor_email,
       actor_ip, actor_ua, metadata)
    VALUES
      (v_recipient.envelope_id, p_recipient_id, 'declined',
       v_recipient.user_id, v_recipient.external_email,
       NULLIF(p_ip, '')::inet, p_ua,
       jsonb_build_object('reason', p_decline_reason));

    -- Mark token consumed if one was used.
    IF p_token IS NOT NULL THEN
      UPDATE public.envelope_recipient_tokens
         SET consumed_at = now()
       WHERE recipient_id = p_recipient_id AND token = p_token;
    END IF;

    RETURN p_recipient_id;
  END IF;

  RAISE EXCEPTION 'envelope_recipient_advance: unknown action %', p_action;
END;
$$;

GRANT EXECUTE ON FUNCTION public.envelope_recipient_advance(uuid, text, jsonb, text, text, text, text) TO authenticated;


-- =====================================================================
-- 9. envelope_void — operator action
-- =====================================================================

CREATE OR REPLACE FUNCTION public.envelope_void(
  p_envelope_id uuid,
  p_reason      text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT (
    public.envelope_can_write(p_envelope_id)
    OR public.has_permission('envelopes.void')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'envelope_void: permission denied' USING ERRCODE = '42501';
  END IF;

  IF coalesce(p_reason, '') = '' THEN
    RAISE EXCEPTION 'envelope_void: void reason is required';
  END IF;

  SELECT status INTO v_status FROM public.document_envelopes WHERE id = p_envelope_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'envelope_void: envelope not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status IN ('completed', 'voided', 'expired', 'declined') THEN
    RAISE EXCEPTION 'envelope_void: envelope is in terminal status %', v_status;
  END IF;

  UPDATE public.document_envelopes
     SET status      = 'voided',
         voided_at   = now(),
         void_reason = p_reason
   WHERE id = p_envelope_id;

  INSERT INTO public.envelope_audit_events
    (envelope_id, event_kind, actor_user_id, metadata)
  VALUES
    (p_envelope_id, 'voided', auth.uid(),
     jsonb_build_object('reason', p_reason));

  -- Consume any outstanding tokens so they can't be replayed.
  UPDATE public.envelope_recipient_tokens t
     SET consumed_at = now()
    FROM public.envelope_recipients r
   WHERE r.envelope_id = p_envelope_id
     AND t.recipient_id = r.id
     AND t.consumed_at IS NULL;

  RETURN p_envelope_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.envelope_void(uuid, text) TO authenticated;


-- =====================================================================
-- 10. envelope_audit_certificate — exportable certificate payload
-- =====================================================================

CREATE OR REPLACE FUNCTION public.envelope_audit_certificate(p_envelope_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_envelope   jsonb;
  v_recipients jsonb;
  v_events     jsonb;
  v_documents  jsonb;
BEGIN
  IF NOT (
    public.envelope_can_read(p_envelope_id)
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'envelope_audit_certificate: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT to_jsonb(e) - 'created_by' INTO v_envelope
    FROM public.document_envelopes e WHERE e.id = p_envelope_id;
  IF v_envelope IS NULL THEN
    RAISE EXCEPTION 'envelope_audit_certificate: envelope not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'id', r.id,
    'role', r.role,
    'sequence', r.sequence,
    'required', r.required,
    'state', r.state,
    'identity', jsonb_build_object(
      'user_id', r.user_id,
      'external_email', r.external_email,
      'external_name', r.external_name
    ),
    'invited_at', r.invited_at,
    'opened_at', r.opened_at,
    'signed_at', r.signed_at,
    'declined_at', r.declined_at,
    'signature_evidence', r.signature_evidence,
    'signed_from_ip', host(r.signed_from_ip),
    'signed_from_ua', r.signed_from_ua
  ) ORDER BY r.sequence, r.created_at)
  INTO v_recipients
  FROM public.envelope_recipients r
  WHERE r.envelope_id = p_envelope_id;

  SELECT jsonb_agg(jsonb_build_object(
    'id', ed.id,
    'document_draft_id', ed.document_draft_id,
    'display_order', ed.display_order
  ) ORDER BY ed.display_order)
  INTO v_documents
  FROM public.envelope_documents ed
  WHERE ed.envelope_id = p_envelope_id;

  SELECT jsonb_agg(jsonb_build_object(
    'event_kind', a.event_kind,
    'occurred_at', a.occurred_at,
    'actor_user_id', a.actor_user_id,
    'actor_email', a.actor_email,
    'actor_ip', host(a.actor_ip),
    'actor_ua', a.actor_ua,
    'recipient_id', a.recipient_id,
    'metadata', a.metadata
  ) ORDER BY a.occurred_at)
  INTO v_events
  FROM public.envelope_audit_events a
  WHERE a.envelope_id = p_envelope_id;

  RETURN jsonb_build_object(
    'envelope', v_envelope,
    'recipients', coalesce(v_recipients, '[]'::jsonb),
    'documents', coalesce(v_documents, '[]'::jsonb),
    'events', coalesce(v_events, '[]'::jsonb),
    'generated_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.envelope_audit_certificate(uuid) TO authenticated;


-- =====================================================================
-- 11. envelope_reminder_due_recipients — for the email worker
-- =====================================================================

CREATE OR REPLACE FUNCTION public.envelope_reminder_due_recipients()
RETURNS TABLE (
  envelope_id  uuid,
  recipient_id uuid,
  recipient_email text,
  recipient_user_id uuid,
  recipient_name text,
  envelope_title text,
  invited_at timestamptz,
  reminder_interval_hours int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.id   AS envelope_id,
    r.id   AS recipient_id,
    coalesce(r.external_email,
             (SELECT p.email FROM public.profiles p WHERE p.id = r.user_id))
           AS recipient_email,
    r.user_id AS recipient_user_id,
    coalesce(r.external_name,
             (SELECT p.display_name FROM public.profiles p WHERE p.id = r.user_id))
           AS recipient_name,
    e.title AS envelope_title,
    r.invited_at,
    e.reminder_interval_hours
  FROM public.document_envelopes e
  JOIN public.envelope_recipients r ON r.envelope_id = e.id
  WHERE e.status IN ('sent', 'in_progress')
    AND e.reminder_interval_hours IS NOT NULL
    AND r.state IN ('invited', 'opened')
    AND r.invited_at IS NOT NULL
    AND r.invited_at + (e.reminder_interval_hours::text || ' hours')::interval <= now()
    AND (
      e.last_reminder_sent_at IS NULL
      OR e.last_reminder_sent_at + (e.reminder_interval_hours::text || ' hours')::interval <= now()
    );
$$;

GRANT EXECUTE ON FUNCTION public.envelope_reminder_due_recipients() TO authenticated;


-- =====================================================================
-- 12. envelopes_auto_expire_fn — hourly cron target
-- =====================================================================

CREATE OR REPLACE FUNCTION public.envelopes_auto_expire_fn()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  WITH expired AS (
    UPDATE public.document_envelopes
       SET status = 'expired'
     WHERE status IN ('sent', 'in_progress')
       AND expires_at IS NOT NULL
       AND expires_at <= now()
     RETURNING id
  ), audited AS (
    INSERT INTO public.envelope_audit_events (envelope_id, event_kind, metadata)
    SELECT id, 'expired', jsonb_build_object('reason', 'auto_expired_by_cron')
      FROM expired
    RETURNING envelope_id
  ), tokens_voided AS (
    UPDATE public.envelope_recipient_tokens t
       SET consumed_at = now()
      FROM public.envelope_recipients r
     WHERE r.envelope_id IN (SELECT envelope_id FROM audited)
       AND t.recipient_id = r.id
       AND t.consumed_at IS NULL
     RETURNING t.id
  )
  SELECT count(*) INTO v_count FROM audited;

  RETURN coalesce(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.envelopes_auto_expire_fn() TO authenticated;

-- Schedule hourly. cron extension is already enabled in this DB
-- (used by saved-search digest + workflow reminder crons).
DO $$
BEGIN
  -- Drop any prior schedule with the same name (idempotent re-apply).
  PERFORM cron.unschedule('envelopes_auto_expire_hourly')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'envelopes_auto_expire_hourly');

  PERFORM cron.schedule(
    'envelopes_auto_expire_hourly',
    '5 * * * *',
    $cron$ SELECT public.envelopes_auto_expire_fn(); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  -- pg_cron not installed in this environment — skip scheduling. The
  -- function exists; operators can call it manually or via an
  -- external scheduler.
  RAISE NOTICE 'envelopes_auto_expire: pg_cron not available; auto-expire schedule skipped';
END $$;


-- =====================================================================
-- 13. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('envelopes.send',     'Send a document envelope to recipients', 'documents'),
  ('envelopes.void',     'Void any envelope regardless of creator', 'documents'),
  ('envelopes.read.all', 'Read every envelope regardless of party', 'documents')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'envelopes.send'),
  ('admin',   'envelopes.void'),
  ('admin',   'envelopes.read.all'),
  ('manager', 'envelopes.send'),
  ('manager', 'envelopes.void')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 14. RLS
-- =====================================================================

ALTER TABLE public.document_envelopes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_envelopes_select ON public.document_envelopes;
CREATE POLICY document_envelopes_select ON public.document_envelopes FOR SELECT
  TO authenticated USING (public.envelope_can_read(id));

DROP POLICY IF EXISTS document_envelopes_insert ON public.document_envelopes;
CREATE POLICY document_envelopes_insert ON public.document_envelopes FOR INSERT
  TO authenticated WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS document_envelopes_update ON public.document_envelopes;
CREATE POLICY document_envelopes_update ON public.document_envelopes FOR UPDATE
  TO authenticated
  USING (public.envelope_can_write(id))
  WITH CHECK (public.envelope_can_write(id));

-- DELETE blocked. Use envelope_void.


ALTER TABLE public.envelope_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS envelope_recipients_select ON public.envelope_recipients;
CREATE POLICY envelope_recipients_select ON public.envelope_recipients FOR SELECT
  TO authenticated USING (public.envelope_can_read(envelope_id));

DROP POLICY IF EXISTS envelope_recipients_insert ON public.envelope_recipients;
CREATE POLICY envelope_recipients_insert ON public.envelope_recipients FOR INSERT
  TO authenticated WITH CHECK (public.envelope_can_write(envelope_id));

-- UPDATE/DELETE only when envelope still in draft. Application layer
-- can still call the RPC for state transitions on sent envelopes.
DROP POLICY IF EXISTS envelope_recipients_update ON public.envelope_recipients;
CREATE POLICY envelope_recipients_update ON public.envelope_recipients FOR UPDATE
  TO authenticated
  USING (
    public.envelope_can_write(envelope_id)
    AND EXISTS (SELECT 1 FROM public.document_envelopes
                 WHERE id = envelope_id AND status = 'draft')
  )
  WITH CHECK (
    public.envelope_can_write(envelope_id)
    AND EXISTS (SELECT 1 FROM public.document_envelopes
                 WHERE id = envelope_id AND status = 'draft')
  );

DROP POLICY IF EXISTS envelope_recipients_delete ON public.envelope_recipients;
CREATE POLICY envelope_recipients_delete ON public.envelope_recipients FOR DELETE
  TO authenticated
  USING (
    public.envelope_can_write(envelope_id)
    AND EXISTS (SELECT 1 FROM public.document_envelopes
                 WHERE id = envelope_id AND status = 'draft')
  );


ALTER TABLE public.envelope_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS envelope_documents_select ON public.envelope_documents;
CREATE POLICY envelope_documents_select ON public.envelope_documents FOR SELECT
  TO authenticated USING (public.envelope_can_read(envelope_id));

DROP POLICY IF EXISTS envelope_documents_insert ON public.envelope_documents;
CREATE POLICY envelope_documents_insert ON public.envelope_documents FOR INSERT
  TO authenticated
  WITH CHECK (
    public.envelope_can_write(envelope_id)
    AND EXISTS (SELECT 1 FROM public.document_envelopes
                 WHERE id = envelope_id AND status = 'draft')
  );

DROP POLICY IF EXISTS envelope_documents_delete ON public.envelope_documents;
CREATE POLICY envelope_documents_delete ON public.envelope_documents FOR DELETE
  TO authenticated
  USING (
    public.envelope_can_write(envelope_id)
    AND EXISTS (SELECT 1 FROM public.document_envelopes
                 WHERE id = envelope_id AND status = 'draft')
  );


ALTER TABLE public.envelope_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS envelope_audit_events_select ON public.envelope_audit_events;
CREATE POLICY envelope_audit_events_select ON public.envelope_audit_events FOR SELECT
  TO authenticated USING (public.envelope_can_read(envelope_id));

-- INSERT / UPDATE / DELETE all blocked from authenticated. RPCs
-- (SECURITY DEFINER) write the events; application code never inserts
-- directly.


ALTER TABLE public.envelope_recipient_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS envelope_recipient_tokens_select ON public.envelope_recipient_tokens;
CREATE POLICY envelope_recipient_tokens_select ON public.envelope_recipient_tokens FOR SELECT
  TO authenticated USING (public.has_permission('envelopes.read.all'));

-- INSERT / UPDATE / DELETE all blocked. Tokens are managed exclusively
-- via SECURITY DEFINER RPCs (envelope_send, envelope_recipient_advance,
-- envelope_void, envelopes_auto_expire_fn).


-- =====================================================================
-- 15. Schema governance contracts
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.document_envelopes',         'table', 'userportal',
   ARRAY['userportal']::text[], 'E-signature envelope artifact',           false),
  ('public.envelope_recipients',        'table', 'userportal',
   ARRAY['userportal']::text[], 'Multi-party signer roster',               false),
  ('public.envelope_documents',         'table', 'userportal',
   ARRAY['userportal']::text[], 'Envelope <-> document_drafts join',       false),
  ('public.envelope_audit_events',      'table', 'userportal',
   ARRAY['userportal']::text[], 'Append-only certificate trail',           false),
  ('public.envelope_recipient_tokens',  'table', 'userportal',
   ARRAY['userportal']::text[], 'Single-use external-signer keys',         false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
