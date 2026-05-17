# Smoke Tests — C2 Leases

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000054_leases.sql`. UUIDs resolve via subquery; the RPCs
honor the `session_user IN ('postgres','supabase_admin','service_role')` bypass.

---

## 1. Schema governance — new contracts

```sql
SELECT contract_name, contract_type FROM public.governance_schema_contracts
 WHERE contract_name IN (
   'public.leases', 'public.lease_parties', 'public.lease_active_summary'
 ) ORDER BY contract_name;
```

Expected: 3 rows.

---

## 2. unit_occupancy.lease_id FK constraint applied

```sql
SELECT
  conname,
  pg_get_constraintdef(c.oid) AS def
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
WHERE t.relname = 'unit_occupancy'
  AND c.contype = 'f'
  AND pg_get_constraintdef(c.oid) ILIKE '%leases%';
```

Expected: 1 row with `FOREIGN KEY (lease_id) REFERENCES leases(id) ON DELETE SET NULL`.

---

## 3. CHECK — expires_at > effective_at

```sql
DO $$
DECLARE
  v_unit_id uuid;
  v_building_id bigint;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  IF v_building_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C2-CHECK')
  RETURNING id INTO v_unit_id;

  BEGIN
    INSERT INTO public.leases
      (unit_id, rent_minor, effective_at, expires_at)
    VALUES
      (v_unit_id, 1500000, now() + interval '1 day', now());
    RAISE EXCEPTION 'CHECK failed — expires_at <= effective_at accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: CHECK rejects expires_at <= effective_at';
  END;

  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: `OK: CHECK rejects expires_at <= effective_at`.

---

## 4. Partial UNIQUE — one active lease per unit

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_unit_id uuid;
  v_lease1 uuid;
  v_lease2 uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  IF v_building_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C2-UNIQ')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.leases (unit_id, rent_minor, effective_at, expires_at, status)
  VALUES (v_unit_id, 1500000, now() - interval '1 day', now() + interval '365 days', 'active')
  RETURNING id INTO v_lease1;

  BEGIN
    INSERT INTO public.leases (unit_id, rent_minor, effective_at, expires_at, status)
    VALUES (v_unit_id, 1500000, now(), now() + interval '180 days', 'active')
    RETURNING id INTO v_lease2;
    RAISE EXCEPTION 'UNIQUE failed — second active lease accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: leases_one_active_per_unit blocked the duplicate';
  END;

  DELETE FROM public.leases WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: `OK: leases_one_active_per_unit blocked the duplicate`.

---

## 5. lease_activate — happy path

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_lease_id uuid;
  v_status text;
  v_occupancy_count int;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C2-ACT')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.leases
    (unit_id, rent_minor, effective_at, expires_at, status, created_by)
  VALUES
    (v_unit_id, 1500000, now() - interval '1 day', now() + interval '365 days', 'draft', v_user_id)
  RETURNING id INTO v_lease_id;

  -- Should fail without parties.
  BEGIN
    PERFORM public.lease_activate(v_lease_id);
    RAISE EXCEPTION 'activate succeeded without parties';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%landlord%' OR SQLERRM LIKE '%tenant%' THEN
      RAISE NOTICE 'OK: activate rejects lease without parties';
    ELSE RAISE; END IF;
  END;

  INSERT INTO public.lease_parties (lease_id, role, user_id, is_primary)
  VALUES (v_lease_id, 'landlord', v_user_id, true);
  INSERT INTO public.lease_parties (lease_id, role, external_name, is_primary)
  VALUES (v_lease_id, 'tenant', 'SMOKE C2 tenant', true);

  PERFORM public.lease_activate(v_lease_id);

  SELECT status INTO v_status FROM public.leases WHERE id = v_lease_id;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'expected status=active, got %', v_status;
  END IF;

  SELECT count(*) INTO v_occupancy_count
  FROM public.unit_occupancy WHERE lease_id = v_lease_id AND move_out_at IS NULL;
  IF v_occupancy_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 active occupancy row tied to lease, got %', v_occupancy_count;
  END IF;

  PERFORM public.lease_terminate(v_lease_id, 'smoke cleanup', now(), NULL);
  DELETE FROM public.unit_occupancy WHERE unit_id = v_unit_id;
  DELETE FROM public.leases WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: activate creates lease-bound occupancy and flips status';
END $$;
```

Expected: two `OK:` notices.

---

## 6. lease_terminate stamps move_out_at

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_lease_id uuid;
  v_move_out timestamptz;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C2-TERM')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.leases (unit_id, rent_minor, effective_at, expires_at, status, created_by)
  VALUES (v_unit_id, 1500000, now() - interval '1 day', now() + interval '365 days', 'draft', v_user_id)
  RETURNING id INTO v_lease_id;

  INSERT INTO public.lease_parties (lease_id, role, user_id, is_primary)
  VALUES (v_lease_id, 'landlord', v_user_id, true);
  INSERT INTO public.lease_parties (lease_id, role, external_name, is_primary)
  VALUES (v_lease_id, 'tenant', 'SMOKE C2 tenant', true);

  PERFORM public.lease_activate(v_lease_id);
  PERFORM public.lease_terminate(v_lease_id, 'smoke termination', now(), 50000);

  SELECT move_out_at INTO v_move_out FROM public.unit_occupancy WHERE lease_id = v_lease_id;
  IF v_move_out IS NULL THEN
    RAISE EXCEPTION 'lease_terminate did not stamp move_out_at on occupancy';
  END IF;

  DELETE FROM public.unit_occupancy WHERE unit_id = v_unit_id;
  DELETE FROM public.leases WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: lease_terminate stamps move_out_at on occupancy';
END $$;
```

Expected: `OK: lease_terminate stamps move_out_at on occupancy`.

---

## 7. lease_renew creates child + expires parent

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_parent_id uuid;
  v_child_id uuid;
  v_parent_status text;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C2-RENEW')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.leases (unit_id, rent_minor, effective_at, expires_at, status, created_by)
  VALUES (v_unit_id, 1500000, now() - interval '300 days', now() + interval '60 days', 'draft', v_user_id)
  RETURNING id INTO v_parent_id;

  INSERT INTO public.lease_parties (lease_id, role, user_id, is_primary)
  VALUES (v_parent_id, 'landlord', v_user_id, true);
  INSERT INTO public.lease_parties (lease_id, role, external_name, is_primary)
  VALUES (v_parent_id, 'tenant', 'SMOKE C2 tenant', true);

  PERFORM public.lease_activate(v_parent_id);

  v_child_id := public.lease_renew(
    v_parent_id,
    now() + interval '60 days',
    now() + interval '425 days',
    1700000,
    NULL);

  SELECT status INTO v_parent_status FROM public.leases WHERE id = v_parent_id;
  IF v_parent_status <> 'expired' THEN
    RAISE EXCEPTION 'expected parent status=expired after renew, got %', v_parent_status;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.leases WHERE id = v_child_id AND parent_lease_id = v_parent_id
  ) THEN
    RAISE EXCEPTION 'child lease not linked to parent';
  END IF;
  IF (SELECT count(*) FROM public.lease_parties WHERE lease_id = v_child_id) <> 2 THEN
    RAISE EXCEPTION 'parties not copied to child';
  END IF;

  DELETE FROM public.unit_occupancy WHERE unit_id = v_unit_id;
  DELETE FROM public.leases WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: lease_renew creates child and expires parent';
END $$;
```

Expected: `OK: lease_renew creates child and expires parent`.

---

## 8. RLS policies present

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('leases', 'lease_parties')
 ORDER BY tablename, policyname;
```

Expected: leases has SELECT/INSERT/UPDATE; lease_parties has SELECT/INSERT/DELETE.
DELETE on leases is **blocked** (no policy → use lease_terminate).
