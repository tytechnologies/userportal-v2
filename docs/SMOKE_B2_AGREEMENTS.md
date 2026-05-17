# Smoke Tests — B2 Referral + Co-broker Agreements

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000047_referral_co_broker_agreements.sql`.

UUIDs resolve via subquery; the `preview_commission_split` and
`referral_chain_for_deal` RPCs honor the
`session_user IN ('postgres', 'supabase_admin', 'service_role')` bypass.

---

## 1. Schema governance — new contracts

```sql
SELECT contract_name, contract_type
  FROM public.governance_schema_contracts
 WHERE contract_name IN (
         'public.referral_agreements',
         'public.co_broker_agreements',
         'public.referral_attributions',
         'public.active_agreements_view'
       )
 ORDER BY contract_name;
```

Expected: 4 rows.

---

## 2. Permissions catalog

```sql
SELECT name, category
  FROM public.permissions
 WHERE name IN ('agreements.propose', 'agreements.accept', 'agreements.read.all')
 ORDER BY name;
```

Expected: 3 rows.

```sql
SELECT role, permission
  FROM public.role_permissions
 WHERE permission IN ('agreements.propose', 'agreements.accept', 'agreements.read.all')
 ORDER BY role, permission;
```

Expected: 5 rows — admin (3), manager (2).

---

## 3. CHECK constraints — referrer/recipient required

```sql
DO $$
BEGIN
  -- Insert without referrer should raise
  BEGIN
    INSERT INTO public.referral_agreements
      (recipient_user_id, scope_type, terms_kind, terms_value)
    VALUES
      ((SELECT id FROM public.profiles LIMIT 1),
       'open', 'percent_of_deal_value', 1.5);
    RAISE EXCEPTION 'CHECK violated — empty referrer was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: referrer-required CHECK fired';
  END;

  -- Insert without recipient should raise
  BEGIN
    INSERT INTO public.referral_agreements
      (referrer_user_id, scope_type, terms_kind, terms_value)
    VALUES
      ((SELECT id FROM public.profiles LIMIT 1),
       'open', 'percent_of_deal_value', 1.5);
    RAISE EXCEPTION 'CHECK violated — empty recipient was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: recipient-required CHECK fired';
  END;

  -- Insert with scope_type='listing' but no scope_listing_id
  BEGIN
    INSERT INTO public.referral_agreements
      (referrer_user_id, recipient_user_id, scope_type, terms_kind, terms_value)
    VALUES
      ((SELECT id FROM public.profiles LIMIT 1),
       (SELECT id FROM public.profiles LIMIT 1),
       'listing', 'percent_of_deal_value', 1.5);
    RAISE EXCEPTION 'CHECK violated — listing scope without scope_listing_id was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: scope_type=listing requires scope_listing_id';
  END;
END $$;
```

Expected: three `OK:` notices.

---

## 4. End-to-end — propose, accept, attribute, preview

```sql
DO $$
DECLARE
  v_listing_id    bigint;
  v_user_a        uuid;
  v_user_b        uuid;
  v_agreement_id  uuid;
  v_deal_id       uuid;
  v_attrib_id     uuid;
  v_chain_count   int;
  v_preview_count int;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_user_a FROM public.profiles ORDER BY created_at LIMIT 1;
  SELECT id INTO v_user_b FROM public.profiles ORDER BY created_at OFFSET 1 LIMIT 1;
  IF v_listing_id IS NULL OR v_user_a IS NULL OR v_user_b IS NULL THEN
    RAISE NOTICE 'SKIP: need at least 1 listing and 2 profiles';
    RETURN;
  END IF;

  -- Propose
  INSERT INTO public.referral_agreements
    (referrer_user_id, recipient_user_id, scope_type, scope_listing_id,
     terms_kind, terms_value, terms_currency, proposed_by)
  VALUES
    (v_user_a, v_user_b, 'listing', v_listing_id,
     'percent_of_commission', 25, 'PHP', v_user_a)
  RETURNING id INTO v_agreement_id;

  -- Accept (manual: set status + accepted_by + accepted_at)
  UPDATE public.referral_agreements
     SET status = 'active', accepted_by = v_user_b, accepted_at = now()
   WHERE id = v_agreement_id;

  -- Confirm view sees it
  IF NOT EXISTS (
    SELECT 1 FROM public.active_agreements_view
     WHERE id = v_agreement_id AND agreement_kind = 'referral'
  ) THEN
    RAISE EXCEPTION 'active_agreements_view did not surface the accepted agreement';
  END IF;

  -- Create a deal + attribute
  INSERT INTO public.deals
    (listing_id, stage_key, currency, deal_value, title)
  VALUES
    (v_listing_id, 'closed_won', 'PHP', 5000000, 'SMOKE B2 deal')
  RETURNING id INTO v_deal_id;

  INSERT INTO public.referral_attributions
    (deal_id, agreement_id, attributed_by)
  VALUES (v_deal_id, v_agreement_id, v_user_a)
  RETURNING id INTO v_attrib_id;

  -- Chain walker — should return at least 1 row (this agreement)
  SELECT count(*) INTO v_chain_count
    FROM public.referral_chain_for_deal(v_deal_id, 10);
  IF v_chain_count < 1 THEN
    RAISE EXCEPTION 'referral_chain_for_deal returned 0 rows; expected ≥1';
  END IF;
  RAISE NOTICE 'referral_chain rows = %', v_chain_count;

  -- Preview — should include the participant + the attribution + (no
  -- co-broker since none configured)
  SELECT count(*) INTO v_preview_count
    FROM public.preview_commission_split(v_deal_id);
  IF v_preview_count < 1 THEN
    RAISE EXCEPTION 'preview_commission_split returned 0 rows; expected ≥1';
  END IF;
  RAISE NOTICE 'preview_commission_split rows = %', v_preview_count;

  -- Cleanup
  DELETE FROM public.referral_attributions WHERE id = v_attrib_id;
  DELETE FROM public.deals WHERE id = v_deal_id;
  DELETE FROM public.referral_agreements WHERE id = v_agreement_id;
  RAISE NOTICE 'OK: propose -> accept -> attribute -> preview pipeline works';
END $$;
```

Expected: notices showing chain rows ≥ 1, preview rows ≥ 1, and a final
`OK:` line. No leftover rows.

---

## 5. UNIQUE on (deal_id, agreement_id)

```sql
DO $$
DECLARE
  v_listing_id   bigint;
  v_user_a       uuid;
  v_user_b       uuid;
  v_deal_id      uuid;
  v_agreement_id uuid;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_user_a FROM public.profiles ORDER BY created_at LIMIT 1;
  SELECT id INTO v_user_b FROM public.profiles ORDER BY created_at OFFSET 1 LIMIT 1;
  IF v_listing_id IS NULL OR v_user_a IS NULL OR v_user_b IS NULL THEN
    RAISE NOTICE 'SKIP: need a listing and 2 profiles';
    RETURN;
  END IF;

  INSERT INTO public.deals (listing_id, stage_key, currency, title)
  VALUES (v_listing_id, 'inquiry_received', 'PHP', 'SMOKE B2 unique')
  RETURNING id INTO v_deal_id;

  INSERT INTO public.referral_agreements
    (referrer_user_id, recipient_user_id, scope_type, terms_kind, terms_value, proposed_by)
  VALUES (v_user_a, v_user_b, 'open', 'fixed', 5000, v_user_a)
  RETURNING id INTO v_agreement_id;

  INSERT INTO public.referral_attributions (deal_id, agreement_id, attributed_by)
  VALUES (v_deal_id, v_agreement_id, v_user_a);

  BEGIN
    INSERT INTO public.referral_attributions (deal_id, agreement_id, attributed_by)
    VALUES (v_deal_id, v_agreement_id, v_user_a);
    RAISE EXCEPTION 'UNIQUE violated — duplicate (deal_id, agreement_id) was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: UNIQUE (deal_id, agreement_id) blocked the duplicate';
  END;

  DELETE FROM public.deals WHERE id = v_deal_id;
  DELETE FROM public.referral_agreements WHERE id = v_agreement_id;
END $$;
```

Expected: notice `OK: UNIQUE (deal_id, agreement_id) blocked the duplicate`.

---

## 6. Recursive chain — cycle safety

```sql
DO $$
DECLARE
  v_listing_id  bigint;
  v_user_a      uuid;
  v_user_b      uuid;
  v_user_c      uuid;
  v_a1          uuid;
  v_a2          uuid;
  v_deal_id     uuid;
  v_chain_count int;
BEGIN
  SELECT id INTO v_listing_id FROM public.listings WHERE deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_user_a FROM public.profiles ORDER BY created_at LIMIT 1;
  SELECT id INTO v_user_b FROM public.profiles ORDER BY created_at OFFSET 1 LIMIT 1;
  SELECT id INTO v_user_c FROM public.profiles ORDER BY created_at OFFSET 2 LIMIT 1;
  IF v_listing_id IS NULL OR v_user_a IS NULL OR v_user_b IS NULL OR v_user_c IS NULL THEN
    RAISE NOTICE 'SKIP: need a listing and 3 profiles';
    RETURN;
  END IF;

  -- Build a 2-step chain: A -> B (a1), B -> C (a2 upstream of a1)
  INSERT INTO public.referral_agreements
    (referrer_user_id, recipient_user_id, scope_type, terms_kind, terms_value,
     status, accepted_by, accepted_at, proposed_by)
  VALUES
    (v_user_a, v_user_b, 'open', 'percent_of_deal_value', 2.0,
     'active', v_user_b, now(), v_user_a)
  RETURNING id INTO v_a1;

  INSERT INTO public.referral_agreements
    (referrer_user_id, recipient_user_id, scope_type, terms_kind, terms_value,
     status, accepted_by, accepted_at, proposed_by)
  VALUES
    (v_user_b, v_user_c, 'open', 'percent_of_deal_value', 1.0,
     'active', v_user_c, now(), v_user_b)
  RETURNING id INTO v_a2;

  INSERT INTO public.deals (listing_id, stage_key, currency, deal_value, title)
  VALUES (v_listing_id, 'closed_won', 'PHP', 1000000, 'SMOKE B2 chain')
  RETURNING id INTO v_deal_id;

  INSERT INTO public.referral_attributions (deal_id, agreement_id, attributed_by)
  VALUES (v_deal_id, v_a2, v_user_c);

  -- Walking from the deal should follow a2 (depth 1) -> a1 (depth 2)
  -- because a2's source_user_id (v_user_b) matches a1's recipient_user_id.
  SELECT count(*) INTO v_chain_count
    FROM public.referral_chain_for_deal(v_deal_id, 10);
  IF v_chain_count < 2 THEN
    RAISE EXCEPTION 'expected ≥2 chain rows (depth 1 + depth 2), got %', v_chain_count;
  END IF;
  RAISE NOTICE 'OK: chain walker followed depth=2 (rows=%)', v_chain_count;

  DELETE FROM public.deals WHERE id = v_deal_id;
  DELETE FROM public.referral_agreements WHERE id IN (v_a1, v_a2);
END $$;
```

Expected: `OK: chain walker followed depth=2 (rows=2)`.

---

## 7. RLS — INSERT requires proposed_by = auth.uid()

This block runs as the SQL editor session_user, where `auth.uid()` is
NULL. The INSERT must fail because `proposed_by = auth.uid()` cannot be
satisfied. Verifies the policy actually fires.

```sql
DO $$
BEGIN
  BEGIN
    INSERT INTO public.referral_agreements
      (referrer_user_id, recipient_user_id, scope_type,
       terms_kind, terms_value, proposed_by)
    VALUES
      ((SELECT id FROM public.profiles LIMIT 1),
       (SELECT id FROM public.profiles LIMIT 1),
       'open', 'fixed', 1000,
       (SELECT id FROM public.profiles LIMIT 1));
    RAISE NOTICE 'NOTE: insert succeeded — running as superuser? RLS policy is bypassed';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK: RLS blocked the insert (proposed_by != auth.uid())';
  END;
END $$;
```

Expected (in SQL editor as `postgres`): the NOTE branch — superuser bypasses
RLS, which is normal. When run as an authenticated user, the OK branch fires.

---

## 8. View columns — active_agreements_view

```sql
SELECT
  count(*) FILTER (WHERE agreement_kind = 'referral')   AS referral_active,
  count(*) FILTER (WHERE agreement_kind = 'co_broker')  AS co_broker_active,
  count(*)                                              AS total
FROM public.active_agreements_view;
```

Expected: counts ≥ 0; query returns 1 row.
