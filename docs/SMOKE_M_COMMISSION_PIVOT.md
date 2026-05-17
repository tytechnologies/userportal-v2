# Smoke Tests — M (Commission-only Pivot)

Pasteable SQL for the Supabase SQL editor. Validates migrations
`20260507000058_remove_plans_subscriptions.sql` +
`20260507000059_platform_commission_rules.sql`.

---

## 1. Plan / subscription tables are gone

```sql
SELECT count(*) AS surviving
  FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('plans', 'plan_features', 'plan_prices',
                      'organization_subscriptions');
```

Expected: `surviving = 0`.

---

## 2. Entitlement RPCs are gone

```sql
SELECT count(*) AS surviving
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('org_has_feature', 'org_feature_limit',
                   'assign_default_plan_fn');
```

Expected: `surviving = 0`.

---

## 3. invoices.subscription_id retained but unconstrained

```sql
SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='invoices' AND column_name='subscription_id'
  ) AS column_present,
  EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname='invoices' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) ILIKE '%organization_subscriptions%'
  ) AS fk_present;
```

Expected: `column_present=true`, `fk_present=false`.

---

## 4. New schema governance contracts

```sql
SELECT contract_name, contract_type FROM public.governance_schema_contracts
 WHERE contract_name IN (
   'public.platform_commission_rules', 'public.platform_fee_charges'
 ) ORDER BY contract_name;
```

Expected: 2 rows.

---

## 5. Default rule seeded

```sql
SELECT default_pct, basis_kind, active FROM public.platform_commission_rules WHERE id = 1;
```

Expected: `default_pct=5.0000`, `basis_kind=percent_of_commission`, `active=true`.

---

## 6. Trigger fires on closed_won

```sql
DO $$
DECLARE
  v_listing_id bigint;
  v_user_id uuid;
  v_deal_id uuid;
  v_charge_count int;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_listing_id IS NULL OR v_user_id IS NULL THEN
    RAISE NOTICE 'SKIP: need 1 listing + 1 profile';
    RETURN;
  END IF;

  -- Create deal in inquiry_received with a buyer_agent + deal_value.
  INSERT INTO public.deals
    (listing_id, buyer_agent_user_id, stage_key, deal_value, currency, title, created_by)
  VALUES (v_listing_id, v_user_id, 'inquiry_received', 5000000, 'PHP', 'SMOKE M', v_user_id)
  RETURNING id INTO v_deal_id;

  -- Insert a deal_commission so percent_of_commission has a basis.
  INSERT INTO public.deal_commissions
    (deal_id, user_id, gross_amount, net_amount, currency, status)
  VALUES (v_deal_id, v_user_id, 250000, 250000, 'PHP', 'pending');

  -- Flip closed_won → trigger fires.
  UPDATE public.deals SET stage_key = 'closed_won', closed_won = true,
                          closed_at = now() WHERE id = v_deal_id;

  SELECT count(*) INTO v_charge_count
  FROM public.platform_fee_charges WHERE deal_id = v_deal_id;
  IF v_charge_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 platform_fee_charge, got %', v_charge_count;
  END IF;

  -- Re-flipping is no-op (UNIQUE prevents double).
  UPDATE public.deals SET closed_won = false WHERE id = v_deal_id;
  UPDATE public.deals SET closed_won = true WHERE id = v_deal_id;
  SELECT count(*) INTO v_charge_count
  FROM public.platform_fee_charges WHERE deal_id = v_deal_id;
  IF v_charge_count <> 1 THEN
    RAISE EXCEPTION 'expected still 1 platform_fee_charge after re-flip, got %', v_charge_count;
  END IF;

  -- Cleanup
  DELETE FROM public.platform_fee_charges WHERE deal_id = v_deal_id;
  DELETE FROM public.deal_commissions WHERE deal_id = v_deal_id;
  DELETE FROM public.deals WHERE id = v_deal_id;
  RAISE NOTICE 'OK: trigger fires once on closed_won transition (5%% of 250k = 12500 PHP = 1250000 centavos)';
END $$;
```

Expected: `OK: trigger fires once on closed_won transition ...`.

---

## 7. Computed amount math

```sql
DO $$
DECLARE
  v_listing_id bigint;
  v_user_id uuid;
  v_deal_id uuid;
  v_amount bigint;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_listing_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  INSERT INTO public.deals
    (listing_id, buyer_agent_user_id, stage_key, deal_value, currency, title, created_by)
  VALUES (v_listing_id, v_user_id, 'inquiry_received', 5000000, 'PHP', 'SMOKE M math', v_user_id)
  RETURNING id INTO v_deal_id;

  INSERT INTO public.deal_commissions
    (deal_id, user_id, gross_amount, net_amount, currency, status)
  VALUES (v_deal_id, v_user_id, 250000, 250000, 'PHP', 'pending');

  UPDATE public.deals SET closed_won = true WHERE id = v_deal_id;

  SELECT amount_minor INTO v_amount FROM public.platform_fee_charges
  WHERE deal_id = v_deal_id;

  -- 5% of 250,000 PHP = 12,500 PHP = 1,250,000 centavos
  IF v_amount <> 1250000 THEN
    RAISE EXCEPTION 'expected amount_minor=1250000, got %', v_amount;
  END IF;

  DELETE FROM public.platform_fee_charges WHERE deal_id = v_deal_id;
  DELETE FROM public.deal_commissions WHERE deal_id = v_deal_id;
  DELETE FROM public.deals WHERE id = v_deal_id;
  RAISE NOTICE 'OK: 5%% of 250k commission = 12500 PHP (1,250,000 centavos)';
END $$;
```

Expected: `OK: 5% of 250k commission = 12500 PHP (1,250,000 centavos)`.

---

## 8. Settlement run creates an invoice

```sql
DO $$
DECLARE
  v_listing_id bigint;
  v_user_id uuid;
  v_org_id uuid;
  v_deal_id uuid;
  v_run jsonb;
  v_charge_status text;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_listing_id IS NULL OR v_user_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  -- Need an org membership for the agent so settlement can find a billing target.
  INSERT INTO public.organizations (name, slug)
  VALUES ('SMOKE M settlement', 'smoke-m-' || extract(epoch from now())::bigint)
  RETURNING id INTO v_org_id;

  INSERT INTO public.organization_memberships
    (organization_id, user_id, org_role, status, joined_at)
  VALUES (v_org_id, v_user_id, 'brokerage_owner', 'active', now());

  INSERT INTO public.deals
    (listing_id, buyer_agent_user_id, stage_key, deal_value, currency, title, created_by)
  VALUES (v_listing_id, v_user_id, 'inquiry_received', 5000000, 'PHP', 'SMOKE M run', v_user_id)
  RETURNING id INTO v_deal_id;

  INSERT INTO public.deal_commissions
    (deal_id, user_id, gross_amount, net_amount, currency, status)
  VALUES (v_deal_id, v_user_id, 250000, 250000, 'PHP', 'pending');

  UPDATE public.deals SET closed_won = true WHERE id = v_deal_id;

  -- Run settlement.
  v_run := public.platform_fee_settlement_run(current_date);
  RAISE NOTICE 'settlement_run result: %', v_run;

  IF (v_run->>'invoices_created')::int < 1 THEN
    RAISE EXCEPTION 'expected ≥1 invoice created';
  END IF;

  SELECT status INTO v_charge_status FROM public.platform_fee_charges
  WHERE deal_id = v_deal_id;
  IF v_charge_status <> 'invoiced' THEN
    RAISE EXCEPTION 'expected charge status=invoiced, got %', v_charge_status;
  END IF;

  -- Cleanup
  DELETE FROM public.invoices WHERE organization_id = v_org_id;
  DELETE FROM public.platform_fee_charges WHERE deal_id = v_deal_id;
  DELETE FROM public.deal_commissions WHERE deal_id = v_deal_id;
  DELETE FROM public.deals WHERE id = v_deal_id;
  DELETE FROM public.billing_accounts WHERE organization_id = v_org_id;
  DELETE FROM public.organization_memberships WHERE organization_id = v_org_id;
  DELETE FROM public.organizations WHERE id = v_org_id;
  RAISE NOTICE 'OK: settlement_run creates invoice and flips charges to invoiced';
END $$;
```

Expected: notice with the run result and `OK: settlement_run creates invoice and flips charges to invoiced`.

---

## 9. RLS — agent sees own; admin sees all

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('platform_commission_rules', 'platform_fee_charges')
 ORDER BY tablename, policyname;
```

Expected:
- `platform_commission_rules`: select / modify
- `platform_fee_charges`: select / modify
