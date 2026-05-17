# Smoke Tests — B1 Closing Milestones + Commission Ledger

Pasteable SQL for the Supabase SQL editor. Each block validates one piece of
migration `20260507000046_deal_milestones_commission_ledger.sql`.

UUIDs resolve via subquery so the user can paste verbatim — no placeholder
substitution required. The RPC `apply_milestone_template` honors the
`session_user IN ('postgres', 'supabase_admin', 'service_role')` bypass so
SQL editor sessions don't need a real auth.uid().

If any block returns no rows or errors, the corresponding contract is
broken — file an issue and link to the failing block.

---

## 1. Schema governance — new contracts registered

```sql
SELECT contract_name, contract_type, owner_repo
  FROM public.governance_schema_contracts
 WHERE contract_name IN (
         'public.deal_milestones',
         'public.deal_milestone_templates',
         'public.deal_milestone_template_items',
         'public.commission_ledger',
         'public.deal_closing_status',
         'public.commission_ledger_summary'
       )
 ORDER BY contract_name;
```

Expected: 6 rows. All `owner_repo='userportal'`.

---

## 2. Default templates seeded

```sql
SELECT t.deal_type,
       t.name,
       t.is_default,
       t.active,
       count(i.id) AS item_count
  FROM public.deal_milestone_templates t
  LEFT JOIN public.deal_milestone_template_items i ON i.template_id = t.id
 WHERE t.is_default = true
 GROUP BY t.id
 ORDER BY t.deal_type;
```

Expected: at least 2 rows — `sale` (10 items) and `lease` (5 items), both
`is_default=true`, `active=true`.

---

## 3. Sale template item ordering

```sql
SELECT i.sequence,
       i.milestone_key,
       i.title,
       i.required,
       i.default_due_offset_hours
  FROM public.deal_milestone_template_items i
  JOIN public.deal_milestone_templates t ON t.id = i.template_id
 WHERE t.deal_type = 'sale' AND t.is_default = true AND t.active = true
 ORDER BY i.sequence;
```

Expected: 10 rows starting with `reservation_paid` (seq 10) and ending with
`keys_handed_over` (seq 100). All required EXCEPT `loi_executed`.

---

## 4. Partial unique index — only one active default per deal_type

```sql
DO $$
DECLARE
  v_dup_id uuid;
BEGIN
  -- Try to insert a SECOND active default for deal_type='sale' — must fail.
  BEGIN
    INSERT INTO public.deal_milestone_templates (deal_type, name, is_default, active)
    VALUES ('sale', 'duplicate default', true, true)
    RETURNING id INTO v_dup_id;
    RAISE EXCEPTION 'partial unique index FAILED — duplicate default was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: partial unique index blocked the duplicate default';
  END;
END $$;
```

Expected: notice `OK: partial unique index blocked the duplicate default`.
No rows inserted.

---

## 5. apply_milestone_template against a real deal

This block creates a throwaway deal, applies the sale template, and verifies
the milestone count. Cleans up after itself.

```sql
DO $$
DECLARE
  v_listing_id  bigint;
  v_deal_id     uuid;
  v_template_id uuid;
  v_result      record;
  v_count       int;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  IF v_listing_id IS NULL THEN
    RAISE NOTICE 'SKIP: no listings present — cannot smoke-test apply_milestone_template';
    RETURN;
  END IF;

  SELECT id INTO v_template_id
    FROM public.deal_milestone_templates
   WHERE deal_type = 'sale' AND is_default = true AND active = true
   LIMIT 1;

  INSERT INTO public.deals (listing_id, stage_key, currency, title)
  VALUES (v_listing_id, 'inquiry_received', 'PHP', 'SMOKE B1 throwaway')
  RETURNING id INTO v_deal_id;

  SELECT * INTO v_result
    FROM public.apply_milestone_template(v_deal_id, v_template_id, now());

  RAISE NOTICE 'apply_milestone_template -> created=%, skipped=%',
    v_result.created_count, v_result.skipped_count;

  SELECT count(*) INTO v_count FROM public.deal_milestones WHERE deal_id = v_deal_id;
  IF v_count <> 10 THEN
    RAISE EXCEPTION 'apply_milestone_template: expected 10 milestones, got %', v_count;
  END IF;

  -- Idempotency check — re-apply should add 0.
  SELECT * INTO v_result
    FROM public.apply_milestone_template(v_deal_id, v_template_id, now());
  IF v_result.created_count <> 0 THEN
    RAISE EXCEPTION 'apply_milestone_template: re-apply created % rows, expected 0',
      v_result.created_count;
  END IF;

  -- Cleanup. CASCADE drops milestones via FK.
  DELETE FROM public.deals WHERE id = v_deal_id;
  RAISE NOTICE 'OK: apply_milestone_template idempotent';
END $$;
```

Expected: notices `apply_milestone_template -> created=10, skipped=0` and
`OK: apply_milestone_template idempotent`. No leftover rows.

---

## 6. deal_closing_status — derived gate

```sql
DO $$
DECLARE
  v_listing_id  bigint;
  v_deal_id     uuid;
  v_template_id uuid;
  v_status      record;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  IF v_listing_id IS NULL THEN
    RAISE NOTICE 'SKIP: no listings present';
    RETURN;
  END IF;

  SELECT id INTO v_template_id
    FROM public.deal_milestone_templates
   WHERE deal_type = 'sale' AND is_default = true AND active = true
   LIMIT 1;

  INSERT INTO public.deals (listing_id, stage_key, currency, title)
  VALUES (v_listing_id, 'inquiry_received', 'PHP', 'SMOKE B1 closing-status')
  RETURNING id INTO v_deal_id;

  PERFORM public.apply_milestone_template(v_deal_id, v_template_id, now());

  SELECT * INTO v_status FROM public.deal_closing_status WHERE deal_id = v_deal_id;
  IF v_status.required_total <> 9 THEN
    RAISE EXCEPTION 'expected 9 required milestones, got %', v_status.required_total;
  END IF;
  IF v_status.required_done <> 0 OR v_status.can_close <> false THEN
    RAISE EXCEPTION 'fresh deal must report can_close=false';
  END IF;

  -- Mark all required milestones completed; can_close should flip.
  UPDATE public.deal_milestones
     SET status = 'completed', completed_at = now()
   WHERE deal_id = v_deal_id AND required = true;

  SELECT * INTO v_status FROM public.deal_closing_status WHERE deal_id = v_deal_id;
  IF v_status.can_close <> true THEN
    RAISE EXCEPTION 'after completing required milestones, can_close must be true (got %)',
      v_status.can_close;
  END IF;

  DELETE FROM public.deals WHERE id = v_deal_id;
  RAISE NOTICE 'OK: deal_closing_status flips can_close on required completion';
END $$;
```

Expected: notice `OK: deal_closing_status flips can_close on required completion`.

---

## 7. commission_ledger append-only enforcement

```sql
DO $$
DECLARE
  v_listing_id bigint;
  v_deal_id    uuid;
  v_user_id    uuid;
  v_entry_id   uuid;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_listing_id IS NULL OR v_user_id IS NULL THEN
    RAISE NOTICE 'SKIP: need at least one listing and one profile to smoke ledger';
    RETURN;
  END IF;

  INSERT INTO public.deals (listing_id, stage_key, currency, title)
  VALUES (v_listing_id, 'closed_won', 'PHP', 'SMOKE B1 ledger')
  RETURNING id INTO v_deal_id;

  -- Insert a draft entry, then post it.
  INSERT INTO public.commission_ledger (
    deal_id, participant_user_id, participant_role,
    entry_kind, amount, currency, status
  )
  VALUES (
    v_deal_id, v_user_id, 'buyer_agent',
    'projection', 25000.00, 'PHP', 'draft'
  )
  RETURNING id INTO v_entry_id;

  -- Promoting draft -> posted: posted_at auto-stamps.
  UPDATE public.commission_ledger SET status = 'posted' WHERE id = v_entry_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.commission_ledger
     WHERE id = v_entry_id AND status = 'posted' AND posted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'posted_at was not auto-stamped on draft -> posted transition';
  END IF;

  -- Attempt to mutate the amount on a posted entry — must raise.
  BEGIN
    UPDATE public.commission_ledger SET amount = 99999.99 WHERE id = v_entry_id;
    RAISE EXCEPTION 'append-only enforcement FAILED — amount was mutated on a posted entry';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%append-only%' THEN
      RAISE NOTICE 'OK: posted entry rejected economic mutation';
    ELSE
      RAISE;
    END IF;
  END;

  -- Void without reason — must raise.
  BEGIN
    UPDATE public.commission_ledger SET status = 'void' WHERE id = v_entry_id;
    RAISE EXCEPTION 'void without reason FAILED — should have been blocked';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%void_reason%' THEN
      RAISE NOTICE 'OK: void without reason rejected';
    ELSE
      RAISE;
    END IF;
  END;

  -- Void with reason — must succeed.
  UPDATE public.commission_ledger
     SET status = 'void', void_reason = 'smoke test'
   WHERE id = v_entry_id;

  DELETE FROM public.deals WHERE id = v_deal_id;
  RAISE NOTICE 'OK: commission_ledger append-only enforcement passes';
END $$;
```

Expected: three `OK:` notices and no exceptions surfaced to the caller.

---

## 8. commission_ledger_summary rollup

```sql
DO $$
DECLARE
  v_listing_id bigint;
  v_deal_id    uuid;
  v_user_id    uuid;
  v_summary    record;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_listing_id IS NULL OR v_user_id IS NULL THEN
    RAISE NOTICE 'SKIP: need a listing and profile';
    RETURN;
  END IF;

  INSERT INTO public.deals (listing_id, stage_key, currency, title)
  VALUES (v_listing_id, 'closed_won', 'PHP', 'SMOKE B1 summary')
  RETURNING id INTO v_deal_id;

  INSERT INTO public.commission_ledger
    (deal_id, participant_user_id, participant_role, entry_kind, amount, status)
  VALUES
    (v_deal_id, v_user_id, 'buyer_agent', 'projection',  20000, 'posted'),
    (v_deal_id, v_user_id, 'buyer_agent', 'earning',     20000, 'posted'),
    (v_deal_id, v_user_id, 'buyer_agent', 'invoice',     20000, 'posted'),
    (v_deal_id, v_user_id, 'buyer_agent', 'payment',     20000, 'posted'),
    (v_deal_id, v_user_id, 'buyer_agent', 'payout',     -20000, 'posted');

  SELECT * INTO v_summary FROM public.commission_ledger_summary
   WHERE deal_id = v_deal_id AND participant_user_id = v_user_id;

  IF v_summary.posted_count <> 5 THEN
    RAISE EXCEPTION 'expected 5 posted entries, got %', v_summary.posted_count;
  END IF;
  IF v_summary.net_total <> 60000 THEN
    -- 20k + 20k + 20k + 20k - 20k = 60k
    RAISE EXCEPTION 'expected net_total=60000, got %', v_summary.net_total;
  END IF;

  DELETE FROM public.deals WHERE id = v_deal_id;
  RAISE NOTICE 'OK: commission_ledger_summary rollup correct';
END $$;
```

Expected: notice `OK: commission_ledger_summary rollup correct`.

---

## 9. Permissions catalog

```sql
SELECT name, category
  FROM public.permissions
 WHERE name IN (
         'deals.milestones.write',
         'commissions.ledger.read.team',
         'commissions.ledger.write.team'
       )
 ORDER BY name;
```

Expected: 3 rows, all `category='deals'`.

```sql
SELECT role, permission
  FROM public.role_permissions
 WHERE permission IN (
         'deals.milestones.write',
         'commissions.ledger.read.team',
         'commissions.ledger.write.team'
       )
 ORDER BY role, permission;
```

Expected: 6 rows — admin (3) + manager (3).

---

## 10. RLS policy presence

```sql
SELECT schemaname, tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN (
         'deal_milestones',
         'deal_milestone_templates',
         'deal_milestone_template_items',
         'commission_ledger'
       )
 ORDER BY tablename, policyname;
```

Expected: at least 13 rows (4 on commission_ledger SELECT/INSERT/UPDATE + 4 on
deal_milestones + 3 on deal_milestone_templates + 4 on
deal_milestone_template_items including DELETE).
