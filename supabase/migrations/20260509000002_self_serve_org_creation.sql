-- Self-serve brokerage creation. Closes the launch-readiness gap where
-- a new user could sign up but had no path to actually create their
-- brokerage — org INSERT is service-role-only (mig 20260507000026), so
-- pre-this only the platform admin could provision orgs.
--
-- This RPC bootstraps a new organization AND seeds the caller as the
-- brokerage_owner active membership in one transaction. The caller
-- can then immediately invite teammates from /organization without
-- any platform-side handoff.
--
-- Anti-spam guards (defensive — UI gates this too):
--   - lifetime cap of 3 orgs per user (admins are exempted via
--     has_permission('admin.access'))
--   - slug regex matches the existing UNIQUE-validated shape
--   - slug uniqueness pre-checked for a clean error message
--
-- DEPENDS ON:
--   20260507000026_brokerage_organizations.sql (organizations,
--     organization_memberships, is_org_member, is_org_manager)
--   20260430000003_permissions_rbac.sql (has_permission)
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.create_organization_as_owner(text, text, text);


-- =====================================================================
-- 0. Hard preconditions
-- =====================================================================

DO $$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organizations'
  ) THEN
    missing := missing || ' public.organizations';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organization_memberships'
  ) THEN
    missing := missing || ' public.organization_memberships';
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION
      'Missing required tables for 20260509000002 (self-serve org creation):%. Apply 20260507000026 first.',
      missing;
  END IF;
END $$;


-- =====================================================================
-- 1. SECURITY DEFINER RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.create_organization_as_owner(
  p_name        text,
  p_slug        text,
  p_description text DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  name        text,
  slug        text,
  description text,
  created_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid;
  v_is_admin    boolean := false;
  v_lifetime    integer;
  v_new_org     public.organizations%ROWTYPE;
BEGIN
  -- Auth check. SECURITY DEFINER bypasses RLS, so we MUST gate manually.
  -- Smoke-test escape so SQL editor / service-role can run preflights:
  -- requires session_user IN admin set AND auth.uid() IS NULL.
  IF session_user IN ('postgres', 'supabase_admin', 'service_role')
     AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'create_organization_as_owner cannot be called from the SQL editor (no auth.uid())';
  END IF;

  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Validate inputs
  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN
    RAISE EXCEPTION 'Organization name must be at least 2 characters' USING ERRCODE = '22023';
  END IF;
  IF length(p_name) > 120 THEN
    RAISE EXCEPTION 'Organization name must be 120 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' THEN
    RAISE EXCEPTION 'Slug must be 2-64 lowercase alphanumerics + hyphens, no leading/trailing hyphen' USING ERRCODE = '22023';
  END IF;

  -- Anti-spam: lifetime cap. Admins exempt.
  v_is_admin := COALESCE(public.has_permission('admin.access'), false);
  IF NOT v_is_admin THEN
    SELECT count(*) INTO v_lifetime
    FROM public.organizations
    WHERE owner_user_id = v_user_id;
    IF v_lifetime >= 3 THEN
      RAISE EXCEPTION 'Lifetime brokerage creation limit reached (3). Contact support to add more.'
        USING ERRCODE = '53400';
    END IF;
  END IF;

  -- Slug uniqueness — pre-checked for a clean message; the DB UNIQUE
  -- index is the real guard.
  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'Slug "%" is already taken — pick a different one.', p_slug
      USING ERRCODE = '23505';
  END IF;

  -- Create the org. owner_user_id stamped as caller.
  INSERT INTO public.organizations (
    name, slug, owner_user_id, description, verified, branding
  )
  VALUES (
    trim(p_name),
    p_slug,
    v_user_id,
    NULLIF(trim(coalesce(p_description, '')), ''),
    false,
    '{}'::jsonb
  )
  RETURNING * INTO v_new_org;

  -- Bootstrap caller as brokerage_owner active membership. Without
  -- this, the org has no members and the org dashboard renders empty
  -- for the very person who just created it.
  INSERT INTO public.organization_memberships (
    organization_id, user_id, org_role, status, joined_at
  )
  VALUES (
    v_new_org.id,
    v_user_id,
    'brokerage_owner',
    'active',
    now()
  );

  -- Audit. log_activity signature: (action, entity, entity_id, metadata)
  -- per migration 20260429000006.
  PERFORM public.log_activity(
    p_action    := 'org.created_self_serve',
    p_entity    := 'organization',
    p_entity_id := v_new_org.id,
    p_metadata  := jsonb_build_object(
      'slug',           v_new_org.slug,
      'lifetime_count', COALESCE(v_lifetime, 0) + 1
    )
  );

  -- Return the row in a query-friendly shape
  id          := v_new_org.id;
  name        := v_new_org.name;
  slug        := v_new_org.slug;
  description := v_new_org.description;
  created_at  := v_new_org.created_at;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.create_organization_as_owner(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_organization_as_owner(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_organization_as_owner(text, text, text) TO service_role;

COMMENT ON FUNCTION public.create_organization_as_owner(text, text, text) IS
  'Self-serve brokerage creation. Authenticated user becomes brokerage_owner of the new org in a single transaction. Lifetime cap 3 per non-admin user.';


-- =====================================================================
-- 2. Slug availability check (for the onboarding form preview)
-- =====================================================================
--
-- Plain SELECTs on organizations are gated by RLS to org members
-- only — a brand-new user checking slug availability would always
-- see "available" because they can't see any rows. This function
-- exposes only a boolean and bypasses RLS via SECURITY DEFINER.
-- Slug is by design a public identifier (it appears in URLs), so
-- leaking taken/free status is not a concern.

CREATE OR REPLACE FUNCTION public.organization_slug_taken(p_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations WHERE slug = p_slug
  );
$$;

REVOKE ALL ON FUNCTION public.organization_slug_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organization_slug_taken(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.organization_slug_taken(text) TO service_role;


-- =====================================================================
-- 3. Smoke test
-- =====================================================================

DO $$
BEGIN
  PERFORM 1
  FROM information_schema.routines
  WHERE specific_schema = 'public'
    AND routine_name = 'create_organization_as_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_organization_as_owner() did not install';
  END IF;
END $$;
