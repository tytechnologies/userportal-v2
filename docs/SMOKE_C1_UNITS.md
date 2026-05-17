# Smoke Tests — C1 Units + Occupancy

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000053_units_occupancy.sql`.

---

## 1. Schema governance — new contracts

```sql
SELECT contract_name, contract_type FROM public.governance_schema_contracts
 WHERE contract_name IN (
   'public.units', 'public.unit_occupancy',
   'public.unit_current_occupancy', 'public.unit_listing_history'
 ) ORDER BY contract_name;
```

Expected: 4 rows.

---

## 2. listings.unit_id column added

```sql
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'listings'
   AND column_name = 'unit_id';
```

Expected: 1 row, `data_type=uuid`, `is_nullable=YES`.

---

## 3. UNIQUE (building_id, unit_number)

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_unit_id     uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  IF v_building_id IS NULL THEN
    RAISE NOTICE 'SKIP: no buildings present';
    RETURN;
  END IF;

  INSERT INTO public.units (building_id, unit_number, unit_type, status)
  VALUES (v_building_id, 'SMOKE-C1-12B', 'studio', 'active')
  RETURNING id INTO v_unit_id;

  BEGIN
    INSERT INTO public.units (building_id, unit_number, unit_type, status)
    VALUES (v_building_id, 'SMOKE-C1-12B', '1br', 'active');
    RAISE EXCEPTION 'UNIQUE constraint FAILED — duplicate unit_number accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: UNIQUE (building_id, unit_number) blocked the duplicate';
  END;

  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: `OK: UNIQUE (building_id, unit_number) blocked the duplicate`.

---

## 4. CHECK constraints — orientation + occupant identity

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_unit_id     uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  IF v_building_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  -- orientation must be a valid compass code
  BEGIN
    INSERT INTO public.units (building_id, unit_number, orientation)
    VALUES (v_building_id, 'SMOKE-C1-CHECK', 'XYZ');
    RAISE EXCEPTION 'orientation CHECK failed to fire';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: orientation CHECK rejects invalid compass codes';
  END;

  INSERT INTO public.units (building_id, unit_number)
  VALUES (v_building_id, 'SMOKE-C1-OCC')
  RETURNING id INTO v_unit_id;

  -- occupancy without identity AND not a vacant-class kind
  BEGIN
    INSERT INTO public.unit_occupancy (unit_id, occupancy_kind)
    VALUES (v_unit_id, 'owner_occupied');
    RAISE EXCEPTION 'occupancy CHECK failed to fire — owner_occupied without identity accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: occupancy CHECK requires identity for owner_occupied';
  END;

  -- vacant doesn't need an occupant
  INSERT INTO public.unit_occupancy (unit_id, occupancy_kind, source)
  VALUES (v_unit_id, 'vacant', 'admin');

  DELETE FROM public.unit_occupancy WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
END $$;
```

Expected: two `OK:` notices.

---

## 5. unit_current_occupancy view returns most-recent open

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_unit_id     uuid;
  v_oc1         uuid;
  v_oc2         uuid;
  v_current     uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  IF v_building_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.units (building_id, unit_number)
  VALUES (v_building_id, 'SMOKE-C1-CUR')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.unit_occupancy (unit_id, occupancy_kind, source, move_in_at, move_out_at)
  VALUES (v_unit_id, 'vacant', 'admin', now() - interval '60 days', now() - interval '30 days')
  RETURNING id INTO v_oc1;

  INSERT INTO public.unit_occupancy (unit_id, occupancy_kind, source, move_in_at, occupant_external_name)
  VALUES (v_unit_id, 'owner_occupied', 'admin', now() - interval '29 days', 'SMOKE-C1 owner')
  RETURNING id INTO v_oc2;

  SELECT occupancy_id INTO v_current
  FROM public.unit_current_occupancy WHERE unit_id = v_unit_id;
  IF v_current <> v_oc2 THEN
    RAISE EXCEPTION 'unit_current_occupancy returned wrong row (got %, expected %)', v_current, v_oc2;
  END IF;

  DELETE FROM public.unit_occupancy WHERE unit_id = v_unit_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: unit_current_occupancy returns most-recent open row';
END $$;
```

Expected: `OK: unit_current_occupancy returns most-recent open row`.

---

## 6. listings.unit_id ON DELETE SET NULL

Confirm the FK behaviour: deleting a unit doesn't cascade-kill its listings.

```sql
SELECT
  conname,
  pg_get_constraintdef(c.oid) AS def
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
WHERE t.relname = 'listings'
  AND c.contype = 'f'
  AND pg_get_constraintdef(c.oid) ILIKE '%units%';
```

Expected: 1 row containing `ON DELETE SET NULL`.

---

## 7. Permission seeded

```sql
SELECT name, category FROM public.permissions WHERE name = 'units.manage';
```

Expected: 1 row.

```sql
SELECT role FROM public.role_permissions WHERE permission = 'units.manage' ORDER BY role;
```

Expected: at least admin and manager.

---

## 8. RLS policies

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('units', 'unit_occupancy')
 ORDER BY tablename, policyname;
```

Expected:
- `units`: select / insert / update (3 policies). No delete policy → DELETE blocked at RLS.
- `unit_occupancy`: select / insert / update (3 policies). No delete policy → append-only.
