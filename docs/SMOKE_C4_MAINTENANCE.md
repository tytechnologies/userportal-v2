# Smoke Tests — C4 Maintenance + Vendors + Work Orders

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000056_maintenance_vendors_work_orders.sql`.

---

## 1. Schema governance

```sql
SELECT contract_name, contract_type FROM public.governance_schema_contracts
 WHERE contract_name IN (
   'public.vendors', 'public.maintenance_requests', 'public.work_orders',
   'public.unit_open_maintenance', 'public.vendor_workload'
 ) ORDER BY contract_name;
```

Expected: 5 rows.

---

## 2. Permissions seeded

```sql
SELECT name FROM public.permissions
 WHERE name IN ('vendors.manage', 'maintenance.manage')
 ORDER BY name;
```

Expected: 2 rows.

---

## 3. request_no + work_order_no auto-generated

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_mr_no text;
  v_wo_no text;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C4-NO')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.maintenance_requests
    (unit_id, reported_by_user_id, title, category)
  VALUES (v_unit_id, v_user_id, 'leaky faucet', 'plumbing')
  RETURNING request_no INTO v_mr_no;
  IF v_mr_no NOT LIKE 'MR-%' THEN
    RAISE EXCEPTION 'expected MR- prefix, got %', v_mr_no;
  END IF;

  INSERT INTO public.work_orders (unit_id, title)
  VALUES (v_unit_id, 'fix leaky faucet')
  RETURNING work_order_no INTO v_wo_no;
  IF v_wo_no NOT LIKE 'WO-%' THEN
    RAISE EXCEPTION 'expected WO- prefix, got %', v_wo_no;
  END IF;

  DELETE FROM public.work_orders WHERE unit_id = v_unit_id;
  DELETE FROM public.maintenance_requests WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: numbers auto-generated (% / %)', v_mr_no, v_wo_no;
END $$;
```

Expected: notice with both numbers.

---

## 4. CHECK — reporter identity required

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_unit_id uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  IF v_building_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C4-CHK')
  RETURNING id INTO v_unit_id;

  BEGIN
    INSERT INTO public.maintenance_requests (unit_id, title, category)
    VALUES (v_unit_id, 'orphan request', 'plumbing');
    RAISE EXCEPTION 'CHECK failed — reporter-less request accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: reporter identity CHECK fired';
  END;

  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: `OK: reporter identity CHECK fired`.

---

## 5. maintenance_triage RPC — happy path + invalid transition

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_mr_id uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C4-TRG')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.maintenance_requests
    (unit_id, reported_by_user_id, title, category)
  VALUES (v_unit_id, v_user_id, 'no power', 'electrical')
  RETURNING id INTO v_mr_id;

  PERFORM public.maintenance_triage(v_mr_id, 'triaged', 'looks legit');

  IF (SELECT status FROM public.maintenance_requests WHERE id = v_mr_id) <> 'triaged' THEN
    RAISE EXCEPTION 'expected status=triaged after triage';
  END IF;

  -- Re-triage should reject (not in submitted)
  BEGIN
    PERFORM public.maintenance_triage(v_mr_id, 'triaged', 'oops');
    RAISE EXCEPTION 'second triage accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%submitted status%' THEN
      RAISE NOTICE 'OK: triage rejects double-triage';
    ELSE RAISE; END IF;
  END;

  DELETE FROM public.maintenance_requests WHERE id = v_mr_id;
  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: `OK: triage rejects double-triage`.

---

## 6. work_order_assign — vendor must be active

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_unit_id uuid;
  v_wo_id uuid;
  v_vendor_id uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  IF v_building_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C4-WOA')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.work_orders (unit_id, title) VALUES (v_unit_id, 'paint touchups')
  RETURNING id INTO v_wo_id;

  INSERT INTO public.vendors (name, kind, status) VALUES ('SMOKE C4 vendor', 'painting', 'archived')
  RETURNING id INTO v_vendor_id;

  -- Archived vendor → reject
  BEGIN
    PERFORM public.work_order_assign(v_wo_id, v_vendor_id, NULL);
    RAISE EXCEPTION 'archived vendor accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%not active%' THEN
      RAISE NOTICE 'OK: archived vendor rejected';
    ELSE RAISE; END IF;
  END;

  -- Activate and reassign
  UPDATE public.vendors SET status = 'active' WHERE id = v_vendor_id;
  PERFORM public.work_order_assign(v_wo_id, v_vendor_id, NULL);

  IF (SELECT status FROM public.work_orders WHERE id = v_wo_id) <> 'assigned' THEN
    RAISE EXCEPTION 'expected status=assigned';
  END IF;

  DELETE FROM public.work_orders WHERE id = v_wo_id;
  DELETE FROM public.vendors WHERE id = v_vendor_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: work_order_assign validates vendor active and flips status';
END $$;
```

Expected: two `OK:` notices.

---

## 7. unit_open_maintenance view rolls up

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_open_count int;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C4-VW')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.maintenance_requests
    (unit_id, reported_by_user_id, title, category, urgency)
  VALUES
    (v_unit_id, v_user_id, 'a', 'plumbing', 'emergency'),
    (v_unit_id, v_user_id, 'b', 'electrical', 'normal'),
    (v_unit_id, v_user_id, 'c', 'pest', 'low');

  SELECT open_count INTO v_open_count FROM public.unit_open_maintenance
  WHERE unit_id = v_unit_id;

  IF v_open_count <> 3 THEN
    RAISE EXCEPTION 'expected 3 open requests, got %', v_open_count;
  END IF;

  DELETE FROM public.maintenance_requests WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: unit_open_maintenance counts open requests correctly';
END $$;
```

Expected: `OK: unit_open_maintenance counts open requests correctly`.

---

## 8. RLS policies

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('vendors', 'maintenance_requests', 'work_orders')
 ORDER BY tablename, policyname;
```

Expected:
- `vendors`: select / modify
- `maintenance_requests`: select / insert / update
- `work_orders`: select / modify

DELETE not exposed on any table — consistent with the rest of the property stack.
