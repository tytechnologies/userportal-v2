# Smoke Tests — B3 Document Envelopes

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000048_document_envelopes.sql`.

UUIDs resolve via subquery; the RPCs honor the
`session_user IN ('postgres','supabase_admin','service_role')` bypass.

---

## 1. Schema governance — new contracts

```sql
SELECT contract_name, contract_type
  FROM public.governance_schema_contracts
 WHERE contract_name IN (
         'public.document_envelopes',
         'public.envelope_recipients',
         'public.envelope_documents',
         'public.envelope_audit_events',
         'public.envelope_recipient_tokens'
       )
 ORDER BY contract_name;
```

Expected: 5 rows.

---

## 2. Permissions catalog

```sql
SELECT name, category
  FROM public.permissions
 WHERE name IN ('envelopes.send', 'envelopes.void', 'envelopes.read.all')
 ORDER BY name;
```

Expected: 3 rows.

```sql
SELECT role, permission
  FROM public.role_permissions
 WHERE permission IN ('envelopes.send', 'envelopes.void', 'envelopes.read.all')
 ORDER BY role, permission;
```

Expected: 5 rows — admin (3), manager (2).

---

## 3. envelope_send rejects invalid envelopes

```sql
DO $$
DECLARE
  v_user_id uuid;
  v_envelope_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_user_id IS NULL THEN
    RAISE NOTICE 'SKIP: no profiles available';
    RETURN;
  END IF;

  -- Empty envelope (no recipients, no documents) → must reject
  INSERT INTO public.document_envelopes (title, created_by)
  VALUES ('SMOKE B3 empty', v_user_id) RETURNING id INTO v_envelope_id;

  BEGIN
    PERFORM public.envelope_send(v_envelope_id);
    RAISE EXCEPTION 'envelope_send: should have rejected empty envelope';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%signer%' OR SQLERRM LIKE '%document%' THEN
      RAISE NOTICE 'OK: envelope_send rejected empty envelope (%)', SQLERRM;
    ELSE
      RAISE;
    END IF;
  END;

  DELETE FROM public.document_envelopes WHERE id = v_envelope_id;
END $$;
```

Expected: notice `OK: envelope_send rejected empty envelope (...)`.

---

## 4. End-to-end — sequential sign flow

```sql
DO $$
DECLARE
  v_user_a       uuid;
  v_user_b       uuid;
  v_envelope_id  uuid;
  v_draft_id     uuid;
  v_r1_id        uuid;
  v_r2_id        uuid;
  v_token_count  int;
  v_audit_count  int;
  v_status       text;
BEGIN
  SELECT id INTO v_user_a FROM public.profiles ORDER BY created_at LIMIT 1;
  SELECT id INTO v_user_b FROM public.profiles ORDER BY created_at OFFSET 1 LIMIT 1;
  SELECT id INTO v_draft_id FROM public.document_drafts LIMIT 1;
  IF v_user_a IS NULL OR v_user_b IS NULL OR v_draft_id IS NULL THEN
    RAISE NOTICE 'SKIP: need 2 profiles + 1 document_draft';
    RETURN;
  END IF;

  -- Build a sequential envelope with 2 signers + 1 doc
  INSERT INTO public.document_envelopes (title, routing_kind, created_by)
  VALUES ('SMOKE B3 sequential', 'sequential', v_user_a)
  RETURNING id INTO v_envelope_id;

  INSERT INTO public.envelope_recipients (envelope_id, user_id, role, sequence)
  VALUES (v_envelope_id, v_user_a, 'signer', 10)
  RETURNING id INTO v_r1_id;

  INSERT INTO public.envelope_recipients (envelope_id, user_id, role, sequence)
  VALUES (v_envelope_id, v_user_b, 'signer', 20)
  RETURNING id INTO v_r2_id;

  INSERT INTO public.envelope_documents (envelope_id, document_draft_id)
  VALUES (v_envelope_id, v_draft_id);

  -- Send
  PERFORM public.envelope_send(v_envelope_id);

  -- Tokens generated for every recipient
  SELECT count(*) INTO v_token_count
    FROM public.envelope_recipient_tokens t
    JOIN public.envelope_recipients r ON r.id = t.recipient_id
   WHERE r.envelope_id = v_envelope_id;
  IF v_token_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 tokens, got %', v_token_count;
  END IF;

  -- Sequential routing: only r1 invited, r2 still pending
  IF (SELECT state FROM public.envelope_recipients WHERE id = v_r1_id) <> 'invited'
     OR (SELECT state FROM public.envelope_recipients WHERE id = v_r2_id) <> 'pending'
  THEN
    RAISE EXCEPTION 'sequential routing: expected r1=invited, r2=pending';
  END IF;

  -- r1 signs
  PERFORM public.envelope_recipient_advance(
    v_r1_id, 'sign',
    jsonb_build_object('kind', 'typed', 'name_typed', 'Test A'),
    '127.0.0.1', 'smoke-ua', NULL, NULL);

  -- After r1 signs: envelope = in_progress, r2 = invited
  SELECT status INTO v_status FROM public.document_envelopes WHERE id = v_envelope_id;
  IF v_status <> 'in_progress' THEN
    RAISE EXCEPTION 'expected envelope status=in_progress after first sign, got %', v_status;
  END IF;
  IF (SELECT state FROM public.envelope_recipients WHERE id = v_r2_id) <> 'invited' THEN
    RAISE EXCEPTION 'sequential: r2 should be invited after r1 signs';
  END IF;

  -- r2 signs
  PERFORM public.envelope_recipient_advance(
    v_r2_id, 'sign',
    jsonb_build_object('kind', 'typed', 'name_typed', 'Test B'),
    '127.0.0.1', 'smoke-ua', NULL, NULL);

  -- Envelope should now be completed
  SELECT status INTO v_status FROM public.document_envelopes WHERE id = v_envelope_id;
  IF v_status <> 'completed' THEN
    RAISE EXCEPTION 'expected status=completed after both sign, got %', v_status;
  END IF;

  -- Audit events: created (none — manually inserted) + sent + invited (r2 advance) + signed × 2 + completed
  SELECT count(*) INTO v_audit_count
    FROM public.envelope_audit_events WHERE envelope_id = v_envelope_id;
  IF v_audit_count < 4 THEN
    RAISE EXCEPTION 'expected ≥4 audit events, got %', v_audit_count;
  END IF;
  RAISE NOTICE 'audit events recorded: %', v_audit_count;

  DELETE FROM public.document_envelopes WHERE id = v_envelope_id;
  RAISE NOTICE 'OK: sequential sign flow completed end-to-end';
END $$;
```

Expected: notices showing audit count + final OK.

---

## 5. Decline by required signer kills the envelope

```sql
DO $$
DECLARE
  v_user_a uuid;
  v_envelope_id uuid;
  v_draft_id uuid;
  v_r1_id uuid;
  v_status text;
BEGIN
  SELECT id INTO v_user_a FROM public.profiles ORDER BY created_at LIMIT 1;
  SELECT id INTO v_draft_id FROM public.document_drafts LIMIT 1;
  IF v_user_a IS NULL OR v_draft_id IS NULL THEN
    RAISE NOTICE 'SKIP: need profile + document_draft';
    RETURN;
  END IF;

  INSERT INTO public.document_envelopes (title, created_by)
  VALUES ('SMOKE B3 decline', v_user_a) RETURNING id INTO v_envelope_id;
  INSERT INTO public.envelope_recipients (envelope_id, user_id, role)
  VALUES (v_envelope_id, v_user_a, 'signer') RETURNING id INTO v_r1_id;
  INSERT INTO public.envelope_documents (envelope_id, document_draft_id)
  VALUES (v_envelope_id, v_draft_id);

  PERFORM public.envelope_send(v_envelope_id);

  PERFORM public.envelope_recipient_advance(
    v_r1_id, 'decline', '{}'::jsonb, NULL, NULL,
    'changed mind', NULL);

  SELECT status INTO v_status FROM public.document_envelopes WHERE id = v_envelope_id;
  IF v_status <> 'declined' THEN
    RAISE EXCEPTION 'expected envelope status=declined, got %', v_status;
  END IF;

  DELETE FROM public.document_envelopes WHERE id = v_envelope_id;
  RAISE NOTICE 'OK: required-signer decline transitioned envelope to declined';
END $$;
```

Expected: `OK: required-signer decline transitioned envelope to declined`.

---

## 6. envelope_void requires reason

```sql
DO $$
DECLARE
  v_user_a uuid;
  v_envelope_id uuid;
  v_draft_id uuid;
BEGIN
  SELECT id INTO v_user_a FROM public.profiles LIMIT 1;
  SELECT id INTO v_draft_id FROM public.document_drafts LIMIT 1;
  IF v_user_a IS NULL OR v_draft_id IS NULL THEN
    RAISE NOTICE 'SKIP: need profile + document_draft';
    RETURN;
  END IF;

  INSERT INTO public.document_envelopes (title, created_by)
  VALUES ('SMOKE B3 void', v_user_a) RETURNING id INTO v_envelope_id;
  INSERT INTO public.envelope_recipients (envelope_id, user_id, role)
  VALUES (v_envelope_id, v_user_a, 'signer');
  INSERT INTO public.envelope_documents (envelope_id, document_draft_id)
  VALUES (v_envelope_id, v_draft_id);

  PERFORM public.envelope_send(v_envelope_id);

  -- Empty reason rejected
  BEGIN
    PERFORM public.envelope_void(v_envelope_id, '');
    RAISE EXCEPTION 'envelope_void should have rejected empty reason';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%reason%' THEN
      RAISE NOTICE 'OK: empty void reason rejected';
    ELSE RAISE; END IF;
  END;

  -- Valid void
  PERFORM public.envelope_void(v_envelope_id, 'smoke test');

  IF NOT EXISTS (SELECT 1 FROM public.document_envelopes
                  WHERE id = v_envelope_id AND status = 'voided'
                    AND voided_at IS NOT NULL AND void_reason = 'smoke test') THEN
    RAISE EXCEPTION 'envelope_void did not set status/voided_at/void_reason';
  END IF;

  -- Outstanding tokens consumed
  IF EXISTS (
    SELECT 1 FROM public.envelope_recipient_tokens t
    JOIN public.envelope_recipients r ON r.id = t.recipient_id
    WHERE r.envelope_id = v_envelope_id AND t.consumed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'envelope_void left outstanding tokens unconsumed';
  END IF;

  DELETE FROM public.document_envelopes WHERE id = v_envelope_id;
  RAISE NOTICE 'OK: envelope_void enforces reason and consumes tokens';
END $$;
```

Expected: two `OK:` notices.

---

## 7. Append-only audit events

```sql
DO $$
DECLARE
  v_event_id uuid;
BEGIN
  SELECT id INTO v_event_id FROM public.envelope_audit_events LIMIT 1;
  IF v_event_id IS NULL THEN
    RAISE NOTICE 'SKIP: no audit events present yet';
    RETURN;
  END IF;

  -- DELETE blocked by RLS for authenticated; superuser bypass means
  -- the SQL editor CAN delete. Just verify no UPDATE policy exists.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='envelope_audit_events'
       AND cmd IN ('UPDATE', 'INSERT', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'envelope_audit_events should have NO UPDATE/INSERT/DELETE policies (RPC-only writes)';
  END IF;
  RAISE NOTICE 'OK: envelope_audit_events has SELECT-only RLS — writes are RPC-only';
END $$;
```

Expected: `OK: envelope_audit_events has SELECT-only RLS — writes are RPC-only`.

---

## 8. envelope_audit_certificate produces a structured payload

```sql
DO $$
DECLARE
  v_user_a uuid;
  v_envelope_id uuid;
  v_draft_id uuid;
  v_cert jsonb;
BEGIN
  SELECT id INTO v_user_a FROM public.profiles LIMIT 1;
  SELECT id INTO v_draft_id FROM public.document_drafts LIMIT 1;
  IF v_user_a IS NULL OR v_draft_id IS NULL THEN
    RAISE NOTICE 'SKIP: need profile + document_draft';
    RETURN;
  END IF;

  INSERT INTO public.document_envelopes (title, created_by)
  VALUES ('SMOKE B3 cert', v_user_a) RETURNING id INTO v_envelope_id;
  INSERT INTO public.envelope_recipients (envelope_id, user_id, role)
  VALUES (v_envelope_id, v_user_a, 'signer');
  INSERT INTO public.envelope_documents (envelope_id, document_draft_id)
  VALUES (v_envelope_id, v_draft_id);

  v_cert := public.envelope_audit_certificate(v_envelope_id);
  IF v_cert->'envelope' IS NULL THEN
    RAISE EXCEPTION 'certificate missing envelope field';
  END IF;
  IF v_cert->'recipients' IS NULL THEN
    RAISE EXCEPTION 'certificate missing recipients field';
  END IF;
  IF jsonb_array_length(v_cert->'recipients') <> 1 THEN
    RAISE EXCEPTION 'certificate recipients length expected 1, got %',
      jsonb_array_length(v_cert->'recipients');
  END IF;

  DELETE FROM public.document_envelopes WHERE id = v_envelope_id;
  RAISE NOTICE 'OK: envelope_audit_certificate returns structured payload';
END $$;
```

Expected: `OK: envelope_audit_certificate returns structured payload`.

---

## 9. Auto-expire function

```sql
DO $$
DECLARE
  v_user_a uuid;
  v_envelope_id uuid;
  v_draft_id uuid;
  v_expired_count int;
BEGIN
  SELECT id INTO v_user_a FROM public.profiles LIMIT 1;
  SELECT id INTO v_draft_id FROM public.document_drafts LIMIT 1;
  IF v_user_a IS NULL OR v_draft_id IS NULL THEN
    RAISE NOTICE 'SKIP: need profile + document_draft';
    RETURN;
  END IF;

  INSERT INTO public.document_envelopes
    (title, status, sent_at, expires_at, created_by)
  VALUES
    ('SMOKE B3 expire', 'sent', now() - interval '2 days',
     now() - interval '1 hour', v_user_a)
  RETURNING id INTO v_envelope_id;
  INSERT INTO public.envelope_recipients (envelope_id, user_id, role)
  VALUES (v_envelope_id, v_user_a, 'signer');
  INSERT INTO public.envelope_documents (envelope_id, document_draft_id)
  VALUES (v_envelope_id, v_draft_id);

  v_expired_count := public.envelopes_auto_expire_fn();

  IF (SELECT status FROM public.document_envelopes WHERE id = v_envelope_id) <> 'expired' THEN
    RAISE EXCEPTION 'auto-expire did not transition the envelope';
  END IF;

  DELETE FROM public.document_envelopes WHERE id = v_envelope_id;
  RAISE NOTICE 'OK: envelopes_auto_expire_fn flipped past-expiry envelopes (count=%)', v_expired_count;
END $$;
```

Expected: `OK: envelopes_auto_expire_fn flipped past-expiry envelopes (count=≥1)`.
