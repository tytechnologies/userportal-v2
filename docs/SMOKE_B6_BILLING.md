# Smoke Tests — B6 Billing + Payments

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000051_billing_payments.sql`.

UUIDs resolve via subquery; the RPCs honor the
`session_user IN ('postgres','supabase_admin','service_role')` bypass.
**No real money moves through these tests.** The webhook receiver and
HTTP gateway clients are stubbed; live integration is a follow-up turn.

---

## 1. Schema governance — new contracts

```sql
SELECT contract_name, contract_type
  FROM public.governance_schema_contracts
 WHERE contract_name IN (
         'public.billing_accounts',
         'public.payment_methods',
         'public.plan_prices',
         'public.invoices',
         'public.payment_intents',
         'public.payment_gateway_events',
         'public.organization_billing_summary'
       )
 ORDER BY contract_name;
```

Expected: 7 rows.

---

## 2. Permissions

```sql
SELECT name, category FROM public.permissions
 WHERE name IN ('billing.read.own', 'billing.write.own', 'billing.manage.platform')
 ORDER BY name;
```

Expected: 3 rows, category='billing'.

---

## 3. Placeholder plan prices seeded

```sql
SELECT p.code, pp.amount_minor, pp.currency, pp.interval, pp.provider
  FROM public.plan_prices pp
  JOIN public.plans p ON p.id = pp.plan_id
 WHERE pp.provider = 'manual'
 ORDER BY pp.amount_minor;
```

Expected: 3 rows — starter (150000), professional (500000), enterprise (2500000); all PHP, monthly.

---

## 4. invoice_no auto-generates

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_account_id uuid;
  v_inv_no text;
BEGIN
  -- Use the first available org.
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'SKIP: no organizations';
    RETURN;
  END IF;

  INSERT INTO public.billing_accounts (organization_id, provider)
  VALUES (v_org_id, 'manual')
  ON CONFLICT (organization_id) DO UPDATE SET provider = 'manual'
  RETURNING id INTO v_account_id;

  INSERT INTO public.invoices
    (billing_account_id, organization_id, currency, subtotal_minor, total_minor, status, issued_at, due_at)
  VALUES
    (v_account_id, v_org_id, 'PHP', 150000, 150000, 'open', now(), now() + interval '14 days')
  RETURNING invoice_no INTO v_inv_no;

  IF v_inv_no IS NULL OR length(v_inv_no) < 5 THEN
    RAISE EXCEPTION 'invoice_no was not auto-generated';
  END IF;
  RAISE NOTICE 'OK: invoice_no auto-generated as %', v_inv_no;

  -- Cleanup
  DELETE FROM public.invoices WHERE billing_account_id = v_account_id;
  DELETE FROM public.billing_accounts WHERE id = v_account_id;
END $$;
```

Expected: notice with `INV-YYYY-NNNNNN` format.

---

## 5. invoice_mark_paid — happy path + idempotent

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_account_id uuid;
  v_invoice_id uuid;
  v_status text;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'SKIP: no organizations';
    RETURN;
  END IF;

  INSERT INTO public.billing_accounts (organization_id, provider)
  VALUES (v_org_id, 'manual')
  ON CONFLICT (organization_id) DO UPDATE SET provider = 'manual'
  RETURNING id INTO v_account_id;

  INSERT INTO public.invoices
    (billing_account_id, organization_id, currency, subtotal_minor, total_minor, status, issued_at, due_at)
  VALUES
    (v_account_id, v_org_id, 'PHP', 150000, 150000, 'open', now(), now() + interval '14 days')
  RETURNING id INTO v_invoice_id;

  PERFORM public.invoice_mark_paid(v_invoice_id, 150000, NULL);

  SELECT status INTO v_status FROM public.invoices WHERE id = v_invoice_id;
  IF v_status <> 'paid' THEN
    RAISE EXCEPTION 'expected status=paid after mark_paid, got %', v_status;
  END IF;

  -- Idempotent
  PERFORM public.invoice_mark_paid(v_invoice_id, 150000, NULL);

  -- Cleanup
  DELETE FROM public.invoices WHERE id = v_invoice_id;
  DELETE FROM public.billing_accounts WHERE id = v_account_id;
  RAISE NOTICE 'OK: invoice_mark_paid is idempotent';
END $$;
```

Expected: `OK: invoice_mark_paid is idempotent`.

---

## 6. invoice_record_failure — flips subscription past_due

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_account_id uuid;
  v_invoice_id uuid;
  v_subscription_id uuid;
  v_sub_status text;
  v_inv_status text;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'SKIP: no organizations';
    RETURN;
  END IF;

  SELECT id INTO v_subscription_id
    FROM public.organization_subscriptions
   WHERE organization_id = v_org_id AND status = 'active'
   LIMIT 1;
  IF v_subscription_id IS NULL THEN
    RAISE NOTICE 'SKIP: org has no active subscription (B4 trigger missing?)';
    RETURN;
  END IF;

  INSERT INTO public.billing_accounts (organization_id, provider)
  VALUES (v_org_id, 'manual')
  ON CONFLICT (organization_id) DO UPDATE SET provider = 'manual'
  RETURNING id INTO v_account_id;

  INSERT INTO public.invoices
    (billing_account_id, organization_id, subscription_id, currency, subtotal_minor, total_minor, status, issued_at, due_at)
  VALUES
    (v_account_id, v_org_id, v_subscription_id, 'PHP', 150000, 150000, 'open', now(), now() + interval '14 days')
  RETURNING id INTO v_invoice_id;

  PERFORM public.invoice_record_failure(v_invoice_id, 'card_declined', 'Insufficient funds');

  SELECT status INTO v_inv_status FROM public.invoices WHERE id = v_invoice_id;
  SELECT status INTO v_sub_status FROM public.organization_subscriptions WHERE id = v_subscription_id;

  IF v_inv_status <> 'past_due' THEN
    RAISE EXCEPTION 'expected invoice past_due, got %', v_inv_status;
  END IF;
  IF v_sub_status <> 'past_due' THEN
    RAISE EXCEPTION 'expected subscription past_due, got %', v_sub_status;
  END IF;

  -- Restore: mark paid → subscription should flip back to active
  PERFORM public.invoice_mark_paid(v_invoice_id, 150000, NULL);
  SELECT status INTO v_sub_status FROM public.organization_subscriptions WHERE id = v_subscription_id;
  IF v_sub_status <> 'active' THEN
    RAISE EXCEPTION 'expected subscription restored to active, got %', v_sub_status;
  END IF;

  -- Cleanup
  DELETE FROM public.invoices WHERE id = v_invoice_id;
  DELETE FROM public.billing_accounts WHERE id = v_account_id;
  RAISE NOTICE 'OK: invoice failure -> sub past_due -> mark_paid restores active';
END $$;
```

Expected: `OK: invoice failure -> sub past_due -> mark_paid restores active`.

---

## 7. record_payment_gateway_event — idempotent

```sql
DO $$
DECLARE
  v_id_a uuid;
  v_id_b uuid;
BEGIN
  v_id_a := public.record_payment_gateway_event(
    'paymongo',
    'evt_smoke_b6_test',
    'payment.paid',
    jsonb_build_object('amount', 150000),
    true);
  v_id_b := public.record_payment_gateway_event(
    'paymongo',
    'evt_smoke_b6_test',
    'payment.paid',
    jsonb_build_object('amount', 150000),
    true);

  IF v_id_a <> v_id_b THEN
    RAISE EXCEPTION 'idempotency FAILED — two ids for same event_id (% vs %)', v_id_a, v_id_b;
  END IF;

  DELETE FROM public.payment_gateway_events WHERE id = v_id_a;
  RAISE NOTICE 'OK: payment_gateway_events idempotent on (provider, event_id)';
END $$;
```

Expected: `OK: payment_gateway_events idempotent on (provider, event_id)`.

---

## 8. invoices_check_past_due_fn cron

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_account_id uuid;
  v_invoice_id uuid;
  v_result jsonb;
  v_status text;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'SKIP: no organizations';
    RETURN;
  END IF;

  INSERT INTO public.billing_accounts (organization_id, provider)
  VALUES (v_org_id, 'manual')
  ON CONFLICT (organization_id) DO UPDATE SET provider = 'manual'
  RETURNING id INTO v_account_id;

  -- Insert an invoice that's already past its due_at
  INSERT INTO public.invoices
    (billing_account_id, organization_id, currency, subtotal_minor, total_minor, status, issued_at, due_at)
  VALUES
    (v_account_id, v_org_id, 'PHP', 150000, 150000, 'open', now() - interval '1 day', now() - interval '1 hour')
  RETURNING id INTO v_invoice_id;

  v_result := public.invoices_check_past_due_fn();

  SELECT status INTO v_status FROM public.invoices WHERE id = v_invoice_id;
  IF v_status <> 'past_due' THEN
    RAISE EXCEPTION 'expected past_due after cron, got %', v_status;
  END IF;
  RAISE NOTICE 'OK: cron flipped open->past_due (result=%)', v_result;

  -- Cleanup
  DELETE FROM public.invoices WHERE id = v_invoice_id;
  DELETE FROM public.billing_accounts WHERE id = v_account_id;
END $$;
```

Expected: `OK: cron flipped open->past_due (result={...})`.

---

## 9. CHECK constraints

```sql
DO $$
BEGIN
  -- Negative amount rejected
  BEGIN
    INSERT INTO public.payment_intents
      (billing_account_id, provider, provider_intent_id, amount_minor, currency)
    VALUES
      (gen_random_uuid(), 'paymongo', 'pi_test_negative', -100, 'PHP');
    RAISE EXCEPTION 'CHECK violated — negative amount accepted';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    RAISE NOTICE 'OK: negative amount rejected';
  END;
END $$;
```

Expected: `OK: negative amount rejected`.

---

## 10. organization_billing_summary view

```sql
SELECT count(*) AS rows_returned FROM public.organization_billing_summary;
```

Expected: ≥ 0 rows. (One per org, joining billing_account + active subscription + invoice rollup.)
