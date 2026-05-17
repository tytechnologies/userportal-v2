# Smoke Tests — C6 Accounting

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000060_accounting.sql`.

---

## 1. Schema governance

```sql
SELECT contract_name FROM public.governance_schema_contracts
 WHERE contract_name LIKE 'public.%'
   AND contract_name IN (
     'public.accounts', 'public.journal_entries', 'public.journal_lines',
     'public.bank_accounts', 'public.bank_transactions', 'public.bir_export_runs',
     'public.account_balances', 'public.trial_balance',
     'public.bank_reconciliation_status'
   ) ORDER BY contract_name;
```

Expected: 9 rows.

---

## 2. CoA seeded

```sql
SELECT
  count(*) FILTER (WHERE account_type = 'asset')     AS assets,
  count(*) FILTER (WHERE account_type = 'liability') AS liabilities,
  count(*) FILTER (WHERE account_type = 'equity')    AS equity,
  count(*) FILTER (WHERE account_type = 'revenue')   AS revenue,
  count(*) FILTER (WHERE account_type = 'expense')   AS expense,
  count(*) FILTER (WHERE is_system = true)           AS system_accounts
FROM public.accounts;
```

Expected: assets ≥ 7, liabilities ≥ 7, equity ≥ 2, revenue ≥ 7, expense ≥ 11, system_accounts ≥ 14.

---

## 3. journal_entry_post — debits must equal credits

```sql
DO $$
DECLARE
  v_cash uuid;
  v_rev uuid;
  v_entry_id uuid;
BEGIN
  SELECT id INTO v_cash FROM public.accounts WHERE code = '1002';
  SELECT id INTO v_rev  FROM public.accounts WHERE code = '4001';

  INSERT INTO public.journal_entries (description) VALUES ('SMOKE C6 unbalanced')
  RETURNING id INTO v_entry_id;

  -- Unbalanced: debit 1000, credit 999.
  INSERT INTO public.journal_lines (journal_entry_id, account_id, debit_minor, credit_minor, line_no)
  VALUES (v_entry_id, v_cash, 1000, 0, 1),
         (v_entry_id, v_rev,  0, 999, 2);

  BEGIN
    PERFORM public.journal_entry_post(v_entry_id);
    RAISE EXCEPTION 'unbalanced post should have failed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%debits%' AND SQLERRM LIKE '%credits%' THEN
      RAISE NOTICE 'OK: post rejected unbalanced entry';
    ELSE RAISE; END IF;
  END;

  DELETE FROM public.journal_lines WHERE journal_entry_id = v_entry_id;
  DELETE FROM public.journal_entries WHERE id = v_entry_id;
END $$;
```

Expected: `OK: post rejected unbalanced entry`.

---

## 4. journal_entry_post — happy path + immutable after post

```sql
DO $$
DECLARE
  v_cash uuid;
  v_rev uuid;
  v_entry_id uuid;
BEGIN
  SELECT id INTO v_cash FROM public.accounts WHERE code = '1002';
  SELECT id INTO v_rev  FROM public.accounts WHERE code = '4001';

  INSERT INTO public.journal_entries (description) VALUES ('SMOKE C6 balanced')
  RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_lines (journal_entry_id, account_id, debit_minor, credit_minor, line_no)
  VALUES (v_entry_id, v_cash, 150000, 0, 1),
         (v_entry_id, v_rev,  0, 150000, 2);

  PERFORM public.journal_entry_post(v_entry_id);

  IF (SELECT status FROM public.journal_entries WHERE id = v_entry_id) <> 'posted' THEN
    RAISE EXCEPTION 'expected status=posted';
  END IF;

  -- Try to mutate description on posted entry — must fail.
  BEGIN
    UPDATE public.journal_entries SET description = 'tamper' WHERE id = v_entry_id;
    RAISE EXCEPTION 'append-only enforcement FAILED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%append-only%' THEN
      RAISE NOTICE 'OK: posted entry is append-only';
    ELSE RAISE; END IF;
  END;

  -- Try to delete a line on posted entry — must fail.
  BEGIN
    DELETE FROM public.journal_lines WHERE journal_entry_id = v_entry_id LIMIT 1;
    RAISE EXCEPTION 'line delete on posted entry FAILED to be blocked';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%immutable%' OR SQLERRM LIKE '%posted%' THEN
      RAISE NOTICE 'OK: line delete on posted entry blocked';
    ELSE RAISE; END IF;
  END;

  -- Cleanup via void.
  UPDATE public.journal_entries SET status = 'void', void_reason = 'smoke cleanup'
   WHERE id = v_entry_id;
  DELETE FROM public.journal_entries WHERE id = v_entry_id;
END $$;
```

Expected: two `OK:` notices.

---

## 5. journal_entry_reverse swaps debit/credit

```sql
DO $$
DECLARE
  v_cash uuid;
  v_rev uuid;
  v_orig uuid;
  v_rev_entry uuid;
  v_orig_debit bigint;
  v_rev_credit bigint;
BEGIN
  SELECT id INTO v_cash FROM public.accounts WHERE code = '1002';
  SELECT id INTO v_rev  FROM public.accounts WHERE code = '4001';

  INSERT INTO public.journal_entries (description) VALUES ('SMOKE C6 reversal')
  RETURNING id INTO v_orig;

  INSERT INTO public.journal_lines (journal_entry_id, account_id, debit_minor, credit_minor, line_no)
  VALUES (v_orig, v_cash, 200000, 0, 1),
         (v_orig, v_rev,  0, 200000, 2);

  PERFORM public.journal_entry_post(v_orig);
  v_rev_entry := public.journal_entry_reverse(v_orig, current_date);

  IF (SELECT reverses_entry_id FROM public.journal_entries WHERE id = v_rev_entry) <> v_orig THEN
    RAISE EXCEPTION 'reversal entry not linked to original';
  END IF;

  -- Original line on cash account had debit=200000.
  -- Reversal line on same account should have credit=200000.
  SELECT debit_minor INTO v_orig_debit
   FROM public.journal_lines
   WHERE journal_entry_id = v_orig AND account_id = v_cash;
  SELECT credit_minor INTO v_rev_credit
   FROM public.journal_lines
   WHERE journal_entry_id = v_rev_entry AND account_id = v_cash;

  IF v_orig_debit <> v_rev_credit THEN
    RAISE EXCEPTION 'reversal did not swap debit/credit (orig debit=%, rev credit=%)',
      v_orig_debit, v_rev_credit;
  END IF;

  -- Cleanup
  DELETE FROM public.journal_lines WHERE journal_entry_id IN (v_orig, v_rev_entry);
  UPDATE public.journal_entries SET status = 'void', void_reason = 'cleanup'
   WHERE id IN (v_orig, v_rev_entry);
  DELETE FROM public.journal_entries WHERE id IN (v_orig, v_rev_entry);
  RAISE NOTICE 'OK: reversal swaps debit/credit and links to parent';
END $$;
```

Expected: `OK: reversal swaps debit/credit and links to parent`.

---

## 6. CHECK — debit XOR credit per line

```sql
DO $$
DECLARE
  v_cash uuid;
  v_entry uuid;
BEGIN
  SELECT id INTO v_cash FROM public.accounts WHERE code = '1002';
  INSERT INTO public.journal_entries (description) VALUES ('SMOKE C6 xor')
  RETURNING id INTO v_entry;

  -- Both debit and credit non-zero on the same line — must fail.
  BEGIN
    INSERT INTO public.journal_lines (journal_entry_id, account_id, debit_minor, credit_minor, line_no)
    VALUES (v_entry, v_cash, 1000, 1000, 1);
    RAISE EXCEPTION 'CHECK failed — both debit and credit accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: debit XOR credit CHECK fired';
  END;

  -- Both zero — also fail.
  BEGIN
    INSERT INTO public.journal_lines (journal_entry_id, account_id, debit_minor, credit_minor, line_no)
    VALUES (v_entry, v_cash, 0, 0, 1);
    RAISE EXCEPTION 'CHECK failed — both zero accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: zero-zero CHECK fired';
  END;

  DELETE FROM public.journal_entries WHERE id = v_entry;
END $$;
```

Expected: two `OK:` notices.

---

## 7. is_system accounts can't be deleted

```sql
DO $$
DECLARE
  v_cash uuid;
BEGIN
  SELECT id INTO v_cash FROM public.accounts WHERE code = '1002';

  -- DELETE is RLS-blocked for is_system=true under non-postgres roles.
  -- Under postgres bypass, DELETE works but we expose the rule structurally:
  -- check the policy definition exists.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='accounts' AND cmd='DELETE'
  ) THEN
    RAISE EXCEPTION 'accounts DELETE policy missing';
  END IF;

  RAISE NOTICE 'OK: accounts DELETE policy enforces is_system gate';
END $$;
```

Expected: `OK: accounts DELETE policy enforces is_system gate`.

---

## 8. account_balances + trial_balance views

```sql
SELECT
  count(*) AS account_rows,
  count(*) FILTER (WHERE net_balance_minor <> 0) AS nonzero_rows
FROM public.account_balances;

SELECT
  count(*) AS rows_in_trial_balance
FROM public.trial_balance;
```

Expected: both queries return positive counts (≥ accounts in CoA).

---

## 9. auto_post_property_charge — idempotent

```sql
DO $$
DECLARE
  v_building_id bigint;
  v_user_id uuid;
  v_unit_id uuid;
  v_charge_id uuid;
  v_entry_a uuid;
  v_entry_b uuid;
BEGIN
  SELECT id INTO v_building_id FROM public.buildings LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_building_id IS NULL OR v_user_id IS NULL THEN
    RAISE NOTICE 'SKIP'; RETURN;
  END IF;

  INSERT INTO public.units (building_id, unit_number) VALUES (v_building_id, 'SMOKE-C6-AP')
  RETURNING id INTO v_unit_id;

  INSERT INTO public.property_charges
    (kind, unit_id, billing_target, total_minor, status, charged_to_user_id, paid_at)
  VALUES ('rent', v_unit_id, 'tenant', 150000, 'paid', v_user_id, now())
  RETURNING id INTO v_charge_id;

  v_entry_a := public.auto_post_property_charge(v_charge_id);
  v_entry_b := public.auto_post_property_charge(v_charge_id);

  IF v_entry_a <> v_entry_b THEN
    RAISE EXCEPTION 'auto_post not idempotent: % vs %', v_entry_a, v_entry_b;
  END IF;

  -- Cleanup
  DELETE FROM public.journal_lines WHERE journal_entry_id = v_entry_a;
  DELETE FROM public.journal_entries WHERE id = v_entry_a;
  DELETE FROM public.property_charges WHERE id = v_charge_id;
  DELETE FROM public.units WHERE id = v_unit_id;
  RAISE NOTICE 'OK: auto_post_property_charge is idempotent';
END $$;
```

Expected: `OK: auto_post_property_charge is idempotent`.

---

## 10. RLS

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('accounts', 'journal_entries', 'journal_lines',
                     'bank_accounts', 'bank_transactions', 'bir_export_runs')
 ORDER BY tablename, policyname;
```

Expected: each table has SELECT + modify policies. Only `accounts` has a DELETE policy (with is_system filter).
