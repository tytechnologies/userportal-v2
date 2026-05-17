# Smoke Tests — C5 Rent + Dues + Payment Runs

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000057_rent_dues_charges.sql`.

---

## 1. Schema governance

```sql
SELECT contract_name FROM public.governance_schema_contracts
 WHERE contract_name IN (
   'public.rent_schedules', 'public.dues_schedules',
   'public.property_charges', 'public.payment_runs'
 ) ORDER BY contract_name;
```

Expected: 4 rows.

---

## 2. Permissions

```sql
SELECT name FROM public.permissions
 WHERE name IN ('rent.manage', 'dues.manage') ORDER BY name;
```

Expected: 2 rows.

---

## 3. charge_no auto-generated

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_charge_no text;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C5-NO')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.property_charges
    (kind, unit_id, billing_target, total_minor, status,
     charged_to_user_id)
  VALUES
    ('rent', v_unit_id, 'tenant', 1500000, 'open', v_user_id)
  RETURNING charge_no INTO v_charge_no;

  IF v_charge_no NOT LIKE 'PC-%' THEN
    RAISE EXCEPTION 'expected PC- prefix, got %', v_charge_no;
  END IF;

  DELETE FROM public.property_charges WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: charge_no auto-generated as %', v_charge_no;
END $$;
```

Expected: notice with PC-YYYY-NNNNNN.

---

## 4. property_charges_post_guard — append-only on issued

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_charge_id uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C5-PG')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.property_charges
    (kind, unit_id, billing_target, total_minor, status,
     charged_to_user_id)
  VALUES
    ('rent', v_unit_id, 'tenant', 1500000, 'open', v_user_id)
  RETURNING id INTO v_charge_id;

  -- Try to mutate total_minor on an issued charge — must fail.
  BEGIN
    UPDATE public.property_charges SET total_minor = 9999999 WHERE id = v_charge_id;
    RAISE EXCEPTION 'append-only enforcement FAILED — total_minor mutated';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%locked once issued%' THEN
      RAISE NOTICE 'OK: property_charges post_guard rejected mutation';
    ELSE RAISE; END IF;
  END;

  -- Mark paid (allowed transition).
  UPDATE public.property_charges
     SET status = 'paid', amount_paid_minor = 1500000 WHERE id = v_charge_id;

  IF (SELECT paid_at FROM public.property_charges WHERE id = v_charge_id) IS NULL THEN
    RAISE EXCEPTION 'paid_at not auto-stamped';
  END IF;

  DELETE FROM public.property_charges WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: paid_at auto-stamped on transition';
END $$;
```

Expected: two `OK:` notices.

---

## 5. generate_rent_charges — happy path

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_lease_id uuid;
  v_schedule_id uuid;
  v_result jsonb;
  v_charge_count int;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C5-RENT')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.leases
    (unit_id, rent_minor, effective_at, expires_at, status, created_by)
  VALUES (v_unit_id, 1500000, now() - interval '1 day', now() + interval '365 days', 'active', v_user_id)
  RETURNING id INTO v_lease_id;

  INSERT INTO public.lease_parties (lease_id, role, user_id, is_primary)
  VALUES (v_lease_id, 'landlord', v_user_id, true);

  INSERT INTO public.rent_schedules
    (lease_id, amount_minor, period, billing_day, next_due_at,
     status, auto_generate, created_by)
  VALUES
    (v_lease_id, 1500000, 'monthly', 15, current_date,
     'active', true, v_user_id)
  RETURNING id INTO v_schedule_id;

  v_result := public.generate_rent_charges(current_date);
  RAISE NOTICE 'generate_rent_charges result: %', v_result;

  SELECT count(*) INTO v_charge_count
  FROM public.property_charges
  WHERE rent_schedule_id = v_schedule_id;
  IF v_charge_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 charge from rent run, got %', v_charge_count;
  END IF;

  -- Re-running same day is idempotent (next_due_at advanced).
  v_result := public.generate_rent_charges(current_date);
  SELECT count(*) INTO v_charge_count
  FROM public.property_charges
  WHERE rent_schedule_id = v_schedule_id;
  IF v_charge_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 charge after re-run, got %', v_charge_count;
  END IF;

  DELETE FROM public.property_charges WHERE rent_schedule_id = v_schedule_id;
  DELETE FROM public.rent_schedules WHERE id = v_schedule_id;
  DELETE FROM public.lease_parties WHERE lease_id = v_lease_id;
  DELETE FROM public.leases WHERE id = v_lease_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: generate_rent_charges creates 1 charge and is idempotent';
END $$;
```

Expected: notices with the run result + `OK: generate_rent_charges creates 1 charge and is idempotent`.

---

## 6. CHECK — invalid period rejected

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_lease_id uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C5-CHK')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.leases
    (unit_id, rent_minor, effective_at, expires_at, status, created_by)
  VALUES (v_unit_id, 1500000, now() - interval '1 day', now() + interval '365 days', 'draft', v_user_id)
  RETURNING id INTO v_lease_id;

  -- billing_day=29 should fail.
  BEGIN
    INSERT INTO public.rent_schedules
      (lease_id, amount_minor, billing_day, next_due_at)
    VALUES (v_lease_id, 1500000, 29, current_date);
    RAISE EXCEPTION 'CHECK failed — billing_day=29 accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: billing_day CHECK (1..28) fired';
  END;

  DELETE FROM public.leases WHERE id = v_lease_id;
  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: `OK: billing_day CHECK (1..28) fired`.

---

## 7. record_property_charge_payment — idempotent

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_charge_id uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C5-PAY')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.property_charges
    (kind, unit_id, billing_target, total_minor, status,
     charged_to_user_id)
  VALUES
    ('rent', v_unit_id, 'tenant', 1500000, 'open', v_user_id)
  RETURNING id INTO v_charge_id;

  PERFORM public.record_property_charge_payment(v_charge_id, 1500000, NULL);
  IF (SELECT status FROM public.property_charges WHERE id = v_charge_id) <> 'paid' THEN
    RAISE EXCEPTION 'expected status=paid';
  END IF;

  -- Second call is idempotent.
  PERFORM public.record_property_charge_payment(v_charge_id, 1500000, NULL);

  DELETE FROM public.property_charges WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: record_property_charge_payment is idempotent';
END $$;
```

Expected: `OK: record_property_charge_payment is idempotent`.

---

## 8. RLS

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('rent_schedules', 'dues_schedules', 'property_charges', 'payment_runs')
 ORDER BY tablename, policyname;
```

Expected:
- `rent_schedules`: select / modify
- `dues_schedules`: select / modify
- `property_charges`: select / modify
- `payment_runs`: select only (writes are RPC-only)
