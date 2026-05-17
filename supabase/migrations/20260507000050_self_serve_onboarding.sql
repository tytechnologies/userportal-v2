-- Self-Serve Onboarding.
--
-- B5 of the post-audit roadmap. Lifts the admin-only gate on
-- broker_invitations so brokerage owners can invite teammates
-- without admin intervention, and adds the RPCs required for an
-- authenticated user to create their own organization.
--
-- broker_invitations (mig 20260507000038) is REUSED — same schema,
-- same /api/invitations/:token preview + accept endpoints. Only the
-- INSERT/SELECT/UPDATE policies are extended.
--
-- Existing surfaces preserved:
--   - broker_invitations table         — unchanged.
--   - broker_invitations_admin policy  — kept; new owner policy ORs onto it.
--   - /api/invitations/:token GET/accept endpoints — unchanged.
--   - /api/admin/organizations         — kept as platform-admin path.
--   - assign_default_plan trigger (B4) — fires on the new INSERT path,
--                                        auto-subscribes new orgs to free.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.org_invitation_revoke(uuid);
--   DROP FUNCTION IF EXISTS public.decline_broker_invitation(uuid);
--   DROP FUNCTION IF EXISTS public.onboarding_create_organization(text, text, text);
--   DROP FUNCTION IF EXISTS public.generate_unique_org_slug(text);
--   DROP FUNCTION IF EXISTS public.organization_can_invite(uuid);
--   DROP POLICY IF EXISTS broker_invitations_org_owner ON public.broker_invitations;


-- =====================================================================
-- 1. organization_can_invite — RLS helper
-- =====================================================================

CREATE OR REPLACE FUNCTION public.organization_can_invite(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
       WHERE om.organization_id = p_org_id
         AND om.user_id = auth.uid()
         AND om.status  = 'active'
         AND om.org_role IN ('brokerage_owner', 'branch_manager')
    );
$$;

GRANT EXECUTE ON FUNCTION public.organization_can_invite(uuid) TO authenticated;


-- =====================================================================
-- 2. Permissive RLS — org owners can manage their own invitations
-- =====================================================================
--
-- Postgres ORs permissive policies. The pre-existing admin policy
-- (broker_invitations_admin from mig 20260507000038) stays in place;
-- the new policy adds the org-owner scope on top.
--
-- SELECT: org owner sees invitations targeting their org.
-- INSERT: org owner can create invitations for their own org only;
--         invited_by is forced to auth.uid() to prevent spoofing.
-- UPDATE: org owner can revoke (status: pending -> declined) on own org.
--         Other column updates remain blocked from the owner path.

DROP POLICY IF EXISTS broker_invitations_org_owner_select ON public.broker_invitations;
CREATE POLICY broker_invitations_org_owner_select ON public.broker_invitations FOR SELECT
  TO authenticated
  USING (public.organization_can_invite(organization_id));

DROP POLICY IF EXISTS broker_invitations_org_owner_insert ON public.broker_invitations;
CREATE POLICY broker_invitations_org_owner_insert ON public.broker_invitations FOR INSERT
  TO authenticated
  WITH CHECK (
    public.organization_can_invite(organization_id)
    AND invited_by = auth.uid()
  );

DROP POLICY IF EXISTS broker_invitations_org_owner_update ON public.broker_invitations;
CREATE POLICY broker_invitations_org_owner_update ON public.broker_invitations FOR UPDATE
  TO authenticated
  USING (public.organization_can_invite(organization_id))
  WITH CHECK (public.organization_can_invite(organization_id));


-- =====================================================================
-- 3. generate_unique_org_slug — collision-safe slug
-- =====================================================================

CREATE OR REPLACE FUNCTION public.generate_unique_org_slug(p_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_base      text;
  v_candidate text;
  v_n         int := 1;
BEGIN
  -- Lowercase, dasherize non-alphanumerics, trim, cap at 50.
  v_base := lower(coalesce(p_name, ''));
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
  v_base := trim(both '-' from v_base);
  v_base := substring(v_base for 50);
  IF v_base = '' THEN v_base := 'org'; END IF;

  v_candidate := v_base;
  WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_candidate) LOOP
    v_n := v_n + 1;
    v_candidate := v_base || '-' || v_n::text;
    IF v_n > 1000 THEN
      RAISE EXCEPTION 'generate_unique_org_slug: cannot generate unique slug for %', p_name;
    END IF;
  END LOOP;

  RETURN v_candidate;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_unique_org_slug(text) TO authenticated;


-- =====================================================================
-- 4. onboarding_create_organization — self-serve org creation
-- =====================================================================
--
-- Authenticated user creates their own organization. Caller becomes
-- both organizations.owner_user_id AND a brokerage_owner membership
-- with status='active'. The B4 default-plan trigger fires AFTER
-- INSERT and auto-subscribes the org to 'free'.
--
-- Slug rules:
--   - p_slug_override (when provided) must match ^[a-z0-9-]+$ and
--     be unique. 23505 surfaces if taken.
--   - Otherwise generate_unique_org_slug derives from p_name.

CREATE OR REPLACE FUNCTION public.onboarding_create_organization(
  p_name           text,
  p_description    text DEFAULT NULL,
  p_slug_override  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_slug    text;
  v_org_id  uuid;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL
     AND session_user NOT IN ('postgres', 'supabase_admin', 'service_role')
  THEN
    RAISE EXCEPTION 'onboarding_create_organization: authentication required'
      USING ERRCODE = '42501';
  END IF;

  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'onboarding_create_organization: name is required';
  END IF;
  IF length(p_name) > 200 THEN
    RAISE EXCEPTION 'onboarding_create_organization: name too long (max 200)';
  END IF;

  IF p_slug_override IS NOT NULL THEN
    IF p_slug_override !~ '^[a-z0-9][a-z0-9-]{0,49}$' THEN
      RAISE EXCEPTION 'onboarding_create_organization: invalid slug format';
    END IF;
    IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = p_slug_override) THEN
      RAISE EXCEPTION 'onboarding_create_organization: slug % already taken', p_slug_override
        USING ERRCODE = '23505';
    END IF;
    v_slug := p_slug_override;
  ELSE
    v_slug := public.generate_unique_org_slug(p_name);
  END IF;

  INSERT INTO public.organizations (name, slug, description, owner_user_id)
  VALUES (trim(p_name), v_slug, p_description, v_user_id)
  RETURNING id INTO v_org_id;

  -- Owner membership. Status='active' so the owner can immediately
  -- act on the org (invite, manage). joined_at stamps now.
  INSERT INTO public.organization_memberships
    (organization_id, user_id, org_role, status, joined_at, invited_by)
  VALUES
    (v_org_id, v_user_id, 'brokerage_owner', 'active', now(), v_user_id);

  -- The B4 trigger has already inserted the default subscription
  -- (free plan). Belt-and-suspenders re-check in case the trigger
  -- failed silently — idempotent thanks to the partial unique index.
  INSERT INTO public.organization_subscriptions
    (organization_id, plan_id, status, effective_at, granted_reason, granted_by)
  SELECT
    v_org_id,
    p.id,
    'active',
    now(),
    'auto_default_self_serve',
    v_user_id
  FROM public.plans p
  WHERE p.is_default = true AND p.status = 'active'
  ON CONFLICT DO NOTHING;

  RETURN v_org_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.onboarding_create_organization(text, text, text) TO authenticated;


-- =====================================================================
-- 5. decline_broker_invitation — recipient declines
-- =====================================================================
--
-- Public-callable via service-role from /api/invitations/:token/decline.
-- Token-bearing == intended recipient (matches the existing accept
-- endpoint's trust model). No email match required for decline —
-- declining is a non-destructive action (the row is still
-- unaccepted; declined just records intent).

CREATE OR REPLACE FUNCTION public.decline_broker_invitation(p_token uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation record;
BEGIN
  SELECT id, status, expires_at, organization_id
    INTO v_invitation
  FROM public.broker_invitations
  WHERE token = p_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'decline_broker_invitation: token not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.status = 'accepted' THEN
    RAISE EXCEPTION 'decline_broker_invitation: invitation already accepted';
  END IF;
  IF v_invitation.status = 'declined' THEN
    -- Idempotent — already declined.
    RETURN v_invitation.id;
  END IF;
  IF v_invitation.status = 'expired' THEN
    RAISE EXCEPTION 'decline_broker_invitation: invitation expired';
  END IF;
  IF v_invitation.expires_at IS NOT NULL AND v_invitation.expires_at < now() THEN
    UPDATE public.broker_invitations
       SET status = 'expired'
     WHERE id = v_invitation.id AND status = 'pending';
    RAISE EXCEPTION 'decline_broker_invitation: invitation expired';
  END IF;

  UPDATE public.broker_invitations
     SET status      = 'declined',
         declined_at = now()
   WHERE id = v_invitation.id;

  RETURN v_invitation.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decline_broker_invitation(uuid) TO authenticated, anon;


-- =====================================================================
-- 6. org_invitation_revoke — owner revokes
-- =====================================================================
--
-- Brokerage owner cancels a pending invitation before it's accepted.
-- Records who revoked it. Status flows: pending -> declined.

CREATE OR REPLACE FUNCTION public.org_invitation_revoke(p_invitation_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation record;
BEGIN
  SELECT id, status, organization_id
    INTO v_invitation
  FROM public.broker_invitations
  WHERE id = p_invitation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_invitation_revoke: invitation not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.organization_can_invite(v_invitation.organization_id)
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'org_invitation_revoke: permission denied' USING ERRCODE = '42501';
  END IF;

  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'org_invitation_revoke: cannot revoke invitation in status %',
      v_invitation.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.broker_invitations
     SET status      = 'declined',
         declined_at = now(),
         notes       = coalesce(notes, '') ||
                       '[revoked by ' || auth.uid()::text || ' at ' || now()::text || ']'
   WHERE id = p_invitation_id;

  RETURN p_invitation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.org_invitation_revoke(uuid) TO authenticated;


NOTIFY pgrst, 'reload schema';
