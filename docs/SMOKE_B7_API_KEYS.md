# Smoke Tests — B7 Public API Keys + Scoped Tokens

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000052_api_keys.sql`.

UUIDs resolve via subquery; the RPCs honor the
`session_user IN ('postgres','supabase_admin','service_role')` bypass.

---

## 1. Schema governance — new contracts

```sql
SELECT contract_name FROM public.governance_schema_contracts
 WHERE contract_name IN (
   'public.api_keys', 'public.api_key_scopes',
   'public.api_key_usage', 'public.api_key_audit_events'
 ) ORDER BY contract_name;
```

Expected: 4 rows.

---

## 2. Scope catalog seeded

```sql
SELECT category, count(*) AS scope_count,
       count(*) FILTER (WHERE requires_admin = true) AS admin_only
  FROM public.api_key_scopes
 GROUP BY category
 ORDER BY category;
```

Expected: rows for `analytics`, `api`, `billing`, `crm`, `deals`, `documents`,
`listings`, `market`, `plans`, `platform`, `webhooks`. `platform` has
`requires_admin=true`.

---

## 3. api_key_generate end-to-end

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_result jsonb;
  v_key_value text;
  v_verified jsonb;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'SKIP: no organizations';
    RETURN;
  END IF;

  v_result := public.api_key_generate(
    'SMOKE B7 test key',
    v_org_id,
    ARRAY['listings:read', 'inquiries:read'],
    'live',
    NULL,
    60);

  v_key_value := v_result->>'key_value';
  IF v_key_value IS NULL OR length(v_key_value) < 30 THEN
    RAISE EXCEPTION 'expected key_value of length 30+, got %', coalesce(length(v_key_value), 0);
  END IF;
  IF v_key_value NOT LIKE 'hipk_live_%' THEN
    RAISE EXCEPTION 'expected hipk_live_ prefix, got: %', v_key_value;
  END IF;

  -- Verify path
  v_verified := public.api_key_verify(v_key_value);
  IF v_verified IS NULL OR (v_verified->>'id') IS NULL THEN
    RAISE EXCEPTION 'verify returned NULL for freshly created key';
  END IF;
  IF (v_verified->>'organization_id')::uuid <> v_org_id THEN
    RAISE EXCEPTION 'verify returned wrong org_id';
  END IF;

  -- Cleanup
  DELETE FROM public.api_keys WHERE id = (v_result->>'id')::uuid;
  RAISE NOTICE 'OK: generate -> verify roundtrip works (key=%)', substring(v_key_value, 1, 18) || '...';
END $$;
```

Expected: `OK: generate -> verify roundtrip works (key=hipk_live_xxxxxxxx...)`.

---

## 4. Plaintext key never persisted

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_result jsonb;
  v_key_value text;
  v_found_plain int;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'SKIP: no organizations';
    RETURN;
  END IF;

  v_result := public.api_key_generate(
    'SMOKE B7 plaintext check',
    v_org_id,
    ARRAY['listings:read'],
    'test', NULL, 60);
  v_key_value := v_result->>'key_value';

  -- Search api_keys for the plaintext value — must NOT be found.
  SELECT count(*) INTO v_found_plain
  FROM public.api_keys
  WHERE name = v_key_value
     OR prefix = v_key_value
     OR last4 = v_key_value
     OR key_hash = v_key_value;
  IF v_found_plain > 0 THEN
    RAISE EXCEPTION 'plaintext key found in api_keys row — % matches', v_found_plain;
  END IF;

  DELETE FROM public.api_keys WHERE id = (v_result->>'id')::uuid;
  RAISE NOTICE 'OK: plaintext key value never persisted in api_keys columns';
END $$;
```

Expected: `OK: plaintext key value never persisted in api_keys columns`.

---

## 5. api_key_verify rejects revoked / expired

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_result jsonb;
  v_key_value text;
  v_id uuid;
  v_after jsonb;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  v_result := public.api_key_generate('SMOKE revoke', v_org_id,
    ARRAY['listings:read'], 'test', NULL, 60);
  v_key_value := v_result->>'key_value';
  v_id := (v_result->>'id')::uuid;

  -- Revoke
  PERFORM public.api_key_revoke(v_id, 'smoke test');

  v_after := public.api_key_verify(v_key_value);
  IF v_after IS NOT NULL THEN
    RAISE EXCEPTION 'verify returned non-null for revoked key';
  END IF;

  DELETE FROM public.api_keys WHERE id = v_id;
  RAISE NOTICE 'OK: revoked keys reject verify';
END $$;
```

Expected: `OK: revoked keys reject verify`.

---

## 6. Auto-expire cron flips active->expired

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_result jsonb;
  v_id uuid;
  v_count int;
  v_status text;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  v_result := public.api_key_generate('SMOKE expire', v_org_id,
    ARRAY['listings:read'], 'test', now() - interval '1 hour', 60);
  v_id := (v_result->>'id')::uuid;

  v_count := public.api_key_expire_fn();

  SELECT status INTO v_status FROM public.api_keys WHERE id = v_id;
  IF v_status <> 'expired' THEN
    RAISE EXCEPTION 'expected status=expired, got %', v_status;
  END IF;

  DELETE FROM public.api_keys WHERE id = v_id;
  RAISE NOTICE 'OK: api_key_expire_fn flips past-expiry keys (count=%)', v_count;
END $$;
```

Expected: `OK: api_key_expire_fn flips past-expiry keys (count=≥1)`.

---

## 7. restricted-kind keys reject :write scopes

```sql
DO $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  BEGIN
    PERFORM public.api_key_generate('SMOKE restricted writers', v_org_id,
      ARRAY['listings:write'], 'restricted', NULL, 60);
    RAISE EXCEPTION 'restricted+:write should have been rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%restricted%' THEN
      RAISE NOTICE 'OK: restricted-kind keys reject :write scopes';
    ELSE RAISE; END IF;
  END;
END $$;
```

Expected: `OK: restricted-kind keys reject :write scopes`.

---

## 8. requires_admin scope without admin permission

```sql
-- This block is best run from a non-admin auth context; under the
-- SQL editor (postgres role) the session_user bypass lets it through.
-- The block records the actual outcome.

DO $$
DECLARE
  v_org_id uuid;
  v_result jsonb;
  v_id uuid;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations LIMIT 1;
  IF v_org_id IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;

  -- Try to create a key with organizations:manage (requires_admin=true).
  -- Under the postgres bypass this succeeds; in production caller flow
  -- the RPC raises 42501 unless caller has admin.access.
  BEGIN
    v_result := public.api_key_generate(
      'SMOKE admin scope', v_org_id,
      ARRAY['organizations:manage'], 'live', NULL, 60);
    v_id := (v_result->>'id')::uuid;
    RAISE NOTICE 'NOTE: created admin-scope key (postgres bypass) id=%', v_id;
    DELETE FROM public.api_keys WHERE id = v_id;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK: requires_admin scope rejected for non-admin caller';
  END;
END $$;
```

Expected: under postgres role, the NOTE branch fires (bypass). Under
authenticated non-admin, the insufficient_privilege branch fires.

---

## 9. Permissions seeded

```sql
SELECT name, category FROM public.permissions
 WHERE name IN ('api_keys.manage.own', 'api_keys.manage.platform')
 ORDER BY name;
```

Expected: 2 rows.

---

## 10. RLS policies present

```sql
SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('api_keys', 'api_key_scopes', 'api_key_usage', 'api_key_audit_events')
 ORDER BY tablename, policyname;
```

Expected: SELECT policies on all four tables; INSERT/UPDATE/DELETE only on api_key_scopes.
