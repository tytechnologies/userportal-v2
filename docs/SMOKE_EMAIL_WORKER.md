# Smoke Tests — Email Worker

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000061_outbound_emails.sql`.

The actual `sendEmail()` in `server/utils/email.ts` is currently a
no-op stub — the worker will mark rows `sent` but no emails leave
the system. That's intentional: the queue records intent, transport
drops in later. Operator points a cron-runner at
`POST /api/internal/email-worker-tick` (with `EMAIL_WORKER_SECRET`
in the Authorization header) every 1–5 minutes.

---

## 1. Schema governance

```sql
SELECT contract_name FROM public.governance_schema_contracts
 WHERE contract_name = 'public.outbound_emails';
```

Expected: 1 row.

---

## 2. Permission seeded

```sql
SELECT name FROM public.permissions WHERE name = 'outbound_emails.manage';
SELECT role FROM public.role_permissions WHERE permission = 'outbound_emails.manage';
```

Expected: 1 permission row + admin role granted.

---

## 3. dedupe_key prevents duplicate enqueue

```sql
DO $$
DECLARE
  v_id_a uuid;
  v_id_b uuid;
BEGIN
  INSERT INTO public.outbound_emails
    (to_email, template_kind, subject, dedupe_key)
  VALUES
    ('smoke@example.com', 'envelope.invitation', 'SMOKE A', 'smoke-dedupe-1')
  RETURNING id INTO v_id_a;

  -- Same dedupe_key = unique violation
  BEGIN
    INSERT INTO public.outbound_emails
      (to_email, template_kind, subject, dedupe_key)
    VALUES
      ('smoke@example.com', 'envelope.invitation', 'SMOKE B', 'smoke-dedupe-1')
    RETURNING id INTO v_id_b;
    RAISE EXCEPTION 'UNIQUE failed — dedupe_key collision accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: dedupe_key UNIQUE blocked the duplicate enqueue';
  END;

  DELETE FROM public.outbound_emails WHERE dedupe_key = 'smoke-dedupe-1';
END $$;
```

Expected: `OK: dedupe_key UNIQUE blocked the duplicate enqueue`.

---

## 4. Email format CHECK rejects invalid addresses

```sql
DO $$
BEGIN
  BEGIN
    INSERT INTO public.outbound_emails
      (to_email, template_kind, subject)
    VALUES
      ('not-an-email', 'envelope.invitation', 'bad');
    RAISE EXCEPTION 'CHECK failed — invalid email accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: to_email format CHECK fired';
  END;
END $$;
```

Expected: `OK: to_email format CHECK fired`.

---

## 5. dequeue claims pending rows + marks them attempting

```sql
DO $$
DECLARE
  v_id uuid;
  v_claimed int;
  v_status text;
BEGIN
  INSERT INTO public.outbound_emails
    (to_email, template_kind, subject, dedupe_key)
  VALUES
    ('smoke@example.com', 'envelope.invitation', 'SMOKE dequeue', 'smoke-deq-1')
  RETURNING id INTO v_id;

  SELECT count(*) INTO v_claimed
  FROM public.outbound_email_dequeue(10);

  SELECT status INTO v_status FROM public.outbound_emails WHERE id = v_id;
  IF v_status <> 'attempting' THEN
    RAISE EXCEPTION 'expected status=attempting after dequeue, got %', v_status;
  END IF;

  -- Re-dequeue should NOT re-claim (still 'attempting').
  SELECT count(*) FILTER (WHERE id = v_id) INTO v_claimed
  FROM public.outbound_email_dequeue(10);
  IF v_claimed <> 0 THEN
    RAISE EXCEPTION 'dequeue re-claimed an attempting row';
  END IF;

  -- Cleanup
  DELETE FROM public.outbound_emails WHERE id = v_id;
  RAISE NOTICE 'OK: dequeue claims pending and skips attempting';
END $$;
```

Expected: `OK: dequeue claims pending and skips attempting`.

---

## 6. record_outcome — sent / failed-with-retry / failed-final

```sql
DO $$
DECLARE
  v_id uuid;
  v_attempts int;
  v_status text;
BEGIN
  -- max_attempts=2 to test the retry exhaust path
  INSERT INTO public.outbound_emails
    (to_email, template_kind, subject, max_attempts, dedupe_key)
  VALUES
    ('smoke@example.com', 'envelope.invitation', 'SMOKE retry', 2, 'smoke-retry-1')
  RETURNING id INTO v_id;

  -- First dequeue → attempting (attempts=1).
  PERFORM * FROM public.outbound_email_dequeue(1);

  -- Record failure → backs off to pending (attempts=1, scheduled_at advanced).
  PERFORM public.outbound_email_record_outcome(v_id, 'failed', 'simulated transient');
  SELECT status, attempts INTO v_status, v_attempts FROM public.outbound_emails WHERE id = v_id;
  IF v_status <> 'pending' OR v_attempts <> 1 THEN
    RAISE EXCEPTION 'expected pending+1, got %+%', v_status, v_attempts;
  END IF;

  -- Force-reschedule for immediate retry.
  UPDATE public.outbound_emails SET scheduled_at = now() - interval '1 minute' WHERE id = v_id;

  -- Second dequeue (attempts=2 = max) → attempting.
  PERFORM * FROM public.outbound_email_dequeue(1);

  -- Final failure (attempts=max) → status=failed permanently.
  PERFORM public.outbound_email_record_outcome(v_id, 'failed', 'final');
  SELECT status INTO v_status FROM public.outbound_emails WHERE id = v_id;
  IF v_status <> 'failed' THEN
    RAISE EXCEPTION 'expected status=failed after max retries, got %', v_status;
  END IF;

  DELETE FROM public.outbound_emails WHERE id = v_id;
  RAISE NOTICE 'OK: failed -> pending(retry) -> failed(final) lifecycle works';
END $$;
```

Expected: `OK: failed -> pending(retry) -> failed(final) lifecycle works`.

---

## 7. unstick sweep flips stale attempting back to pending

```sql
DO $$
DECLARE
  v_id uuid;
  v_unstuck int;
  v_status text;
BEGIN
  INSERT INTO public.outbound_emails
    (to_email, template_kind, subject, status, attempted_at, attempts, dedupe_key)
  VALUES
    ('smoke@example.com', 'envelope.invitation', 'SMOKE stuck',
     'attempting', now() - interval '15 minutes', 1, 'smoke-stuck-1')
  RETURNING id INTO v_id;

  v_unstuck := public.outbound_email_unstick();

  SELECT status INTO v_status FROM public.outbound_emails WHERE id = v_id;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'expected stale attempting -> pending, got %', v_status;
  END IF;

  DELETE FROM public.outbound_emails WHERE id = v_id;
  RAISE NOTICE 'OK: unstick sweep recovers stale attempting rows (count=%)', v_unstuck;
END $$;
```

Expected: `OK: unstick sweep recovers stale attempting rows (count=≥1)`.

---

## 8. RLS — only admin can SELECT

```sql
SELECT policyname, cmd
  FROM pg_policies
 WHERE schemaname='public' AND tablename='outbound_emails'
 ORDER BY policyname;
```

Expected: 1 policy (`outbound_emails_select`, cmd=SELECT). No INSERT/UPDATE/DELETE policies — writes via SECURITY DEFINER RPCs only.
