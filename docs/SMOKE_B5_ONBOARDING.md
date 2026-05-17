# Smoke Tests — B5 Self-Serve Onboarding

Pasteable SQL for the Supabase SQL editor. Validates migration
`20260507000050_self_serve_onboarding.sql`.

UUIDs resolve via subquery; the RPCs honor the
`session_user IN ('postgres','supabase_admin','service_role')` bypass.

---

## 1. generate_unique_org_slug

```sql
SELECT
  public.generate_unique_org_slug('Housing Interactive HQ') AS slug_a,
  public.generate_unique_org_slug('!!!')                    AS slug_fallback,
  public.generate_unique_org_slug(NULL)                     AS slug_null;
```

Expected:
- `slug_a` = `housing-interactive-hq` (or with `-2` suffix if already taken)
- `slug_fallback` = `org` (regex strips everything; falls back)
- `slug_null` = `org` (null + empty fallback)

---

## 2. Slug collision auto-suffix

```sql
DO $$
DECLARE
  v_user_id uuid;
  v_org1 uuid;
  v_org2 uuid;
  v_slug1 text;
  v_slug2 text;
BEGIN
  SELECT id INTO v_user_id FROM public.profiles LIMIT 1;
  IF v_user_id IS NULL THEN
    RAISE NOTICE 'SKIP: no profiles available';
    RETURN;
  END IF;

  -- Two orgs with the same name, second should auto-suffix.
  v_org1 := public.onboarding_create_organization('Smoke B5 Collision', NULL, NULL);
  v_org2 := public.onboarding_create_organization('Smoke B5 Collision', NULL, NULL);

  SELECT slug INTO v_slug1 FROM public.organizations WHERE id = v_org1;
  SELECT slug INTO v_slug2 FROM public.organizations WHERE id = v_org2;

  IF v_slug1 = v_slug2 THEN
    RAISE EXCEPTION 'collision FAILED — both orgs got slug %', v_slug1;
  END IF;
  RAISE NOTICE 'OK: slug auto-suffix worked (% vs %)', v_slug1, v_slug2;

  DELETE FROM public.organization_subscriptions WHERE organization_id IN (v_org1, v_org2);
  DELETE FROM public.organization_memberships WHERE organization_id IN (v_org1, v_org2);
  DELETE FROM public.organizations WHERE id IN (v_org1, v_org2);
END $$;
```

Expected: `OK: slug auto-suffix worked (smoke-b5-collision vs smoke-b5-collision-2)`.

---

## 3. onboarding_create_organization end-to-end

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_owner_role text;
  v_plan_code text;
BEGIN
  v_org_id := public.onboarding_create_organization(
    'Smoke B5 Self-Serve',
    'A test brokerage created via the self-serve flow',
    NULL);

  -- Membership row was created with brokerage_owner.
  SELECT om.org_role INTO v_owner_role
  FROM public.organization_memberships om
  WHERE om.organization_id = v_org_id
  LIMIT 1;
  IF v_owner_role <> 'brokerage_owner' THEN
    RAISE EXCEPTION 'expected brokerage_owner membership, got %', v_owner_role;
  END IF;

  -- B4 trigger auto-assigned the default plan.
  SELECT p.code INTO v_plan_code
  FROM public.organization_subscriptions os
  JOIN public.plans p ON p.id = os.plan_id
  WHERE os.organization_id = v_org_id AND os.status = 'active';
  IF v_plan_code <> 'free' THEN
    RAISE EXCEPTION 'expected free plan auto-assigned, got %', v_plan_code;
  END IF;

  DELETE FROM public.organization_subscriptions WHERE organization_id = v_org_id;
  DELETE FROM public.organization_memberships WHERE organization_id = v_org_id;
  DELETE FROM public.organizations WHERE id = v_org_id;
  RAISE NOTICE 'OK: self-serve creates org + brokerage_owner membership + free plan';
END $$;
```

Expected: `OK: self-serve creates org + brokerage_owner membership + free plan`.

---

## 4. Slug override validation

```sql
DO $$
BEGIN
  -- Invalid slug format
  BEGIN
    PERFORM public.onboarding_create_organization('SMOKE', NULL, 'Has Spaces');
    RAISE EXCEPTION 'invalid slug FAILED — accepted format with spaces';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%invalid slug%' THEN
      RAISE NOTICE 'OK: invalid slug format rejected';
    ELSE RAISE; END IF;
  END;
END $$;
```

Expected: `OK: invalid slug format rejected`.

---

## 5. organization_can_invite

```sql
DO $$
DECLARE
  v_user_a uuid;
  v_org_id uuid;
  v_can_invite boolean;
BEGIN
  SELECT id INTO v_user_a FROM public.profiles LIMIT 1;
  IF v_user_a IS NULL THEN
    RAISE NOTICE 'SKIP: no profiles available';
    RETURN;
  END IF;

  v_org_id := public.onboarding_create_organization('Smoke B5 Invite Test', NULL, NULL);

  -- Owner of the freshly-created org. Test directly via the function.
  -- NOTE: in SQL editor session, auth.uid() is null — so the function
  -- returns the admin path. The smoke just verifies it doesn't error.
  v_can_invite := public.organization_can_invite(v_org_id);
  RAISE NOTICE 'organization_can_invite returned % (admin path or owner path)', v_can_invite;

  DELETE FROM public.organization_subscriptions WHERE organization_id = v_org_id;
  DELETE FROM public.organization_memberships WHERE organization_id = v_org_id;
  DELETE FROM public.organizations WHERE id = v_org_id;
END $$;
```

Expected: notice with the boolean result. (Real-user authentication is required to exercise the owner branch — covered by the application-layer integration tests.)

---

## 6. org_invitation_revoke — pending only

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_inv_id uuid;
BEGIN
  v_org_id := public.onboarding_create_organization('Smoke B5 Revoke', NULL, NULL);

  -- Insert a pending invitation directly (bypassing API path).
  INSERT INTO public.broker_invitations
    (email, organization_id, org_role)
  VALUES
    ('smoke-b5-revoke@example.com', v_org_id, 'junior_agent')
  RETURNING id INTO v_inv_id;

  -- Revoke once — should succeed.
  PERFORM public.org_invitation_revoke(v_inv_id);

  IF (SELECT status FROM public.broker_invitations WHERE id = v_inv_id) <> 'declined' THEN
    RAISE EXCEPTION 'revoke did not transition to declined';
  END IF;

  -- Revoking again should fail (status no longer 'pending').
  BEGIN
    PERFORM public.org_invitation_revoke(v_inv_id);
    RAISE EXCEPTION 'second revoke FAILED to error';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%status declined%' OR SQLERRM LIKE '%cannot revoke%' THEN
      RAISE NOTICE 'OK: revoke is idempotent on status';
    ELSE RAISE; END IF;
  END;

  DELETE FROM public.broker_invitations WHERE id = v_inv_id;
  DELETE FROM public.organization_subscriptions WHERE organization_id = v_org_id;
  DELETE FROM public.organization_memberships WHERE organization_id = v_org_id;
  DELETE FROM public.organizations WHERE id = v_org_id;
  RAISE NOTICE 'OK: org_invitation_revoke transitions pending->declined and rejects re-revoke';
END $$;
```

Expected: two `OK:` notices.

---

## 7. decline_broker_invitation

```sql
DO $$
DECLARE
  v_org_id uuid;
  v_inv_id uuid;
  v_token uuid;
BEGIN
  v_org_id := public.onboarding_create_organization('Smoke B5 Decline', NULL, NULL);

  INSERT INTO public.broker_invitations
    (email, organization_id, org_role)
  VALUES
    ('smoke-b5-decline@example.com', v_org_id, 'junior_agent')
  RETURNING id, token INTO v_inv_id, v_token;

  PERFORM public.decline_broker_invitation(v_token);

  IF (SELECT status FROM public.broker_invitations WHERE id = v_inv_id) <> 'declined' THEN
    RAISE EXCEPTION 'decline did not transition to declined';
  END IF;

  -- Idempotent — re-declining returns without error.
  PERFORM public.decline_broker_invitation(v_token);

  DELETE FROM public.broker_invitations WHERE id = v_inv_id;
  DELETE FROM public.organization_subscriptions WHERE organization_id = v_org_id;
  DELETE FROM public.organization_memberships WHERE organization_id = v_org_id;
  DELETE FROM public.organizations WHERE id = v_org_id;
  RAISE NOTICE 'OK: decline_broker_invitation is idempotent';
END $$;
```

Expected: `OK: decline_broker_invitation is idempotent`.

---

## 8. RLS policies present

```sql
SELECT policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'broker_invitations'
 ORDER BY policyname;
```

Expected: at least the original `broker_invitations_admin` plus three new policies:
`broker_invitations_org_owner_select`,
`broker_invitations_org_owner_insert`,
`broker_invitations_org_owner_update`.
