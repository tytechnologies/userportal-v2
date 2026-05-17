# Smoke Tests — C3 Owners + Tenants + Statements

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000055_owners_tenants_statements.sql`.

---

## 1. Schema governance

```sql
SELECT contract_name, contract_type FROM public.governance_schema_contracts
 WHERE contract_name IN (
   'public.property_owners', 'public.unit_owners',
   'public.owner_statements', 'public.tenant_statements',
   'public.unit_current_owner'
 ) ORDER BY contract_name;
```

Expected: 5 rows.

---

## 2. property_owners identity dedupe

```sql
DO $$
DECLARE
  v_user_id uuid;
  v_a uuid;
BEGIN
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.property_owners (user_id, external_name)
  VALUES (v_user_id, 'SMOKE C3 owner') RETURNING id INTO v_a;

  BEGIN
    INSERT INTO public.property_owners (user_id, external_name)
    VALUES (v_user_id, 'SMOKE C3 owner duplicate');
    RAISE EXCEPTION 'UNIQUE failed — second property_owners row with same user_id accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: property_owners_user_id_uniq blocked the duplicate';
  END;

  DELETE FROM public.property_owners WHERE id = v_a;
END $$;
```

Expected: `OK: property_owners_user_id_uniq blocked the duplicate`.

---

## 3. register_unit_owner — atomic create-or-find

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_result_a jsonb;
  v_result_b jsonb;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number)
  VALUES (v_building_id, 'SMOKE-C3-OWN') RETURNING id INTO v_unit_id;

  v_result_a := public.register_unit_owner(
    v_unit_id,
    jsonb_build_object('user_id', v_user_id, 'external_name', 'A'),
    NULL,
    true);

  -- Re-register same identity — should reuse the same property_owners row.
  v_result_b := public.register_unit_owner(
    v_unit_id,
    jsonb_build_object('user_id', v_user_id),
    NULL,
    true);

  IF (v_result_a->>'owner_id') <> (v_result_b->>'owner_id') THEN
    RAISE EXCEPTION 'register_unit_owner created a duplicate owner row';
  END IF;
  RAISE NOTICE 'OK: register_unit_owner is idempotent on identity';

  -- Cleanup
  DELETE FROM public.unit_owners WHERE unit_id = v_unit_id;
  DELETE FROM public.property_owners WHERE id = (v_result_a->>'owner_id')::uuid;
  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: `OK: register_unit_owner is idempotent on identity`.

---

## 4. Single primary owner per unit

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_owner_a uuid;
  v_owner_b uuid;
  v_user_b_id uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles ORDER BY created_at LIMIT 1;
  SELECT id INTO v_user_b_id FROM public.profiles ORDER BY created_at OFFSET 1 LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL OR v_user_b_id IS NULL THEN
    RAISE NOTICE 'SKIP'; RETURN;
  END IF;

  INSERT INTO public.units (building_id, unit_number)
  VALUES (v_building_id, 'SMOKE-C3-PRIM') RETURNING id INTO v_unit_id;

  INSERT INTO public.property_owners (user_id, external_name)
  VALUES (v_user_id, 'A') RETURNING id INTO v_owner_a;
  INSERT INTO public.property_owners (user_id, external_name)
  VALUES (v_user_b_id, 'B') RETURNING id INTO v_owner_b;

  INSERT INTO public.unit_owners (unit_id, owner_id, is_primary)
  VALUES (v_unit_id, v_owner_a, true);

  BEGIN
    INSERT INTO public.unit_owners (unit_id, owner_id, is_primary)
    VALUES (v_unit_id, v_owner_b, true);
    RAISE EXCEPTION 'UNIQUE failed — second primary owner accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: unit_owners_one_primary_per_unit blocked second primary';
  END;

  DELETE FROM public.unit_owners WHERE unit_id = v_unit_id;
  DELETE FROM public.property_owners WHERE id IN (v_owner_a, v_owner_b);
  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: `OK: unit_owners_one_primary_per_unit blocked second primary`.

---

## 5. owner_statement_post_guard — issued is append-only

```sql
DO $$
DECLARE
  v_user_id uuid;
  v_owner_id uuid;
  v_stmt_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.property_owners (user_id, external_name)
  VALUES (v_user_id, 'SMOKE C3 stmt') RETURNING id INTO v_owner_id;

  INSERT INTO public.owner_statements
    (owner_id, period_start, period_end, currency,
     rent_collected_minor, net_disbursement_minor, status)
  VALUES
    (v_owner_id, now()::date - 30, now()::date - 1, 'PHP', 1500000, 1300000, 'draft')
  RETURNING id INTO v_stmt_id;

  -- Issue.
  UPDATE public.owner_statements SET status = 'issued' WHERE id = v_stmt_id;

  -- Try to mutate amount on issued — must fail.
  BEGIN
    UPDATE public.owner_statements SET rent_collected_minor = 9999999 WHERE id = v_stmt_id;
    RAISE EXCEPTION 'append-only enforcement FAILED — issued statement amount mutated';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%locked once issued%' THEN
      RAISE NOTICE 'OK: owner_statement post_guard rejected economic mutation';
    ELSE RAISE; END IF;
  END;

  -- Void with reason.
  UPDATE public.owner_statements
     SET status = 'void', void_reason = 'smoke test' WHERE id = v_stmt_id;

  DELETE FROM public.owner_statements WHERE owner_id = v_owner_id;
  DELETE FROM public.property_owners WHERE id = v_owner_id;
END $$;
```

Expected: `OK: owner_statement post_guard rejected economic mutation`.

---

## 6. statement_no auto-generated

```sql
DO $$
DECLARE
  v_user_id uuid;
  v_owner_id uuid;
  v_no text;
BEGIN
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.property_owners (user_id, external_name)
  VALUES (v_user_id, 'SMOKE C3 stmt no') RETURNING id INTO v_owner_id;

  INSERT INTO public.owner_statements
    (owner_id, period_start, period_end, status)
  VALUES (v_owner_id, now()::date - 1, now()::date, 'draft')
  RETURNING statement_no INTO v_no;

  IF v_no NOT LIKE 'OS-%' THEN
    RAISE EXCEPTION 'expected OS- prefix, got %', v_no;
  END IF;
  RAISE NOTICE 'OK: owner statement_no auto-generated as %', v_no;

  DELETE FROM public.owner_statements WHERE owner_id = v_owner_id;
  DELETE FROM public.property_owners WHERE id = v_owner_id;
END $$;
```

Expected: `OK: owner statement_no auto-generated as OS-YYYY-NNNNNN`.

---

## 7. tenant_statement post_guard

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_lease_id uuid;
  v_stmt_id uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number)
  VALUES (v_building_id, 'SMOKE-C3-TS') RETURNING id INTO v_unit_id;

  INSERT INTO public.leases
    (unit_id, rent_minor, effective_at, expires_at, status, created_by)
  VALUES (v_unit_id, 1500000, now() - interval '1 day', now() + interval '365 days', 'draft', v_user_id)
  RETURNING id INTO v_lease_id;

  INSERT INTO public.tenant_statements
    (lease_id, period_start, period_end, rent_billed_minor, balance_due_minor)
  VALUES (v_lease_id, now()::date - 30, now()::date - 1, 1500000, 1500000)
  RETURNING id INTO v_stmt_id;

  UPDATE public.tenant_statements SET status = 'issued' WHERE id = v_stmt_id;

  BEGIN
    UPDATE public.tenant_statements SET balance_due_minor = 0 WHERE id = v_stmt_id;
    RAISE EXCEPTION 'append-only enforcement FAILED for tenant_statements';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%locked once issued%' THEN
      RAISE NOTICE 'OK: tenant_statements post_guard rejected mutation';
    ELSE RAISE; END IF;
  END;

  -- Mark paid (allowed transition).
  UPDATE public.tenant_statements SET status = 'paid' WHERE id = v_stmt_id;
  IF (SELECT paid_at FROM public.tenant_statements WHERE id = v_stmt_id) IS NULL THEN
    RAISE EXCEPTION 'paid_at not auto-stamped';
  END IF;

  DELETE FROM public.tenant_statements WHERE lease_id = v_lease_id;
  DELETE FROM public.leases WHERE id = v_lease_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: tenant_statement issued -> paid auto-stamps paid_at';
END $$;
```

Expected: two `OK:` notices.

---

## 8. RLS policies

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('property_owners', 'unit_owners', 'owner_statements', 'tenant_statements')
 ORDER BY tablename, policyname;
```

Expected:
- `property_owners`: select / insert / update.
- `unit_owners`: select / modify.
- `owner_statements`: select / modify.
- `tenant_statements`: select / modify.

DELETE policies absent on all four → DELETE blocked at RLS layer.
