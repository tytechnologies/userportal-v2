-- Phase 1 of the workspace separation rollout.
-- Additive only: widens the system role enum to include `support`,
-- widens the org_role enum to include `broker` + `coordinator`, and
-- seeds the permission keys the new workspace surfaces will check.
--
-- DESIGN NOTES (so future migrations don't relitigate):
--   - Workspaces are layout shells (`/platform`, `/org`, `/me`); roles
--     decide what's visible inside them. This migration only widens the
--     domain — no UI / RLS / endpoint changes here.
--   - System role `support` = Housing Interactive staff who can view
--     platform surfaces read-only and operate triage/moderation, but
--     cannot administer billing, permissions, or org config.
--   - Org roles `broker` + `coordinator` are NEW values in the existing
--     CHECK; `senior_agent` is preserved (we do NOT rename) so existing
--     rows survive — admins can re-bind via UPDATE later if they want
--     to adopt the new vocabulary.
--   - All `INSERT … ON CONFLICT DO NOTHING` so re-runs are idempotent
--     and previously-bound permissions are never disturbed.
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql       (profiles.role + check)
--   20260430000003_permissions_rbac.sql        (permissions, role_permissions, has_permission)
--   20260507000026_brokerage_organizations.sql (organization_memberships.org_role)
--
-- ROLLBACK (manual, only if reverting this Phase 1 entirely — leaves
-- any rows that adopted the new values in violation, so re-bind first):
--   DELETE FROM public.role_permissions WHERE permission IN (
--     'support.access', 'support.impersonate',
--     'org.team.manage.team', 'org.team.manage.branch',
--     'org.deals.coordinate',
--     'leases.manage.team', 'leases.manage.branch', 'leases.manage.org'
--   );
--   DELETE FROM public.permissions WHERE name IN (
--     'support.access', 'support.impersonate',
--     'org.team.manage.team', 'org.team.manage.branch',
--     'org.deals.coordinate',
--     'leases.manage.team', 'leases.manage.branch', 'leases.manage.org'
--   );
--   ALTER TABLE public.role_permissions
--     DROP CONSTRAINT IF EXISTS role_permissions_role_check,
--     ADD CONSTRAINT role_permissions_role_check
--     CHECK (role IN ('admin', 'manager', 'agent'));
--   ALTER TABLE public.profiles
--     DROP CONSTRAINT IF EXISTS profiles_role_check,
--     ADD CONSTRAINT profiles_role_check
--     CHECK (role IN ('admin', 'manager', 'agent'));
--   ALTER TABLE public.organization_memberships
--     DROP CONSTRAINT IF EXISTS organization_memberships_org_role_check,
--     ADD CONSTRAINT organization_memberships_org_role_check
--     CHECK (org_role IN ('brokerage_owner','branch_manager','team_lead',
--                         'senior_agent','junior_agent','assistant'));


-- =====================================================================
-- 0. Hard preconditions — fail fast with a clear message if upstream
--    migrations were skipped (matches the drift-safe pattern from
--    20260508000004 etc.).
-- =====================================================================

DO $$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) THEN
    missing := missing || ' public.profiles';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'permissions'
  ) THEN
    missing := missing || ' public.permissions';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'role_permissions'
  ) THEN
    missing := missing || ' public.role_permissions';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organization_memberships'
  ) THEN
    missing := missing || ' public.organization_memberships';
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION
      'Missing required tables for 20260509000001 (workspace role taxonomy):%. Apply prerequisite migrations 20260429000006 + 20260430000003 + 20260507000026 first.',
      missing;
  END IF;
END $$;


-- =====================================================================
-- 1. Widen profiles.role to allow `support`
-- =====================================================================

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'manager', 'agent', 'support'));

COMMENT ON COLUMN public.profiles.role IS
  'System-tier role: admin (full platform), support (read-only triage/moderation), manager (team lead at platform tier), agent (default). Org-tier roles live separately in organization_memberships.org_role.';


-- =====================================================================
-- 2. Widen role_permissions.role to allow `support`
-- =====================================================================
--
-- The other system roles (admin/manager/agent) already pass the existing
-- CHECK; widening here is the prerequisite for binding `support.*`
-- permissions to the support role below.

ALTER TABLE public.role_permissions
  DROP CONSTRAINT IF EXISTS role_permissions_role_check;

ALTER TABLE public.role_permissions
  ADD CONSTRAINT role_permissions_role_check
  CHECK (role IN ('admin', 'manager', 'agent', 'support'));


-- =====================================================================
-- 3. Widen organization_memberships.org_role to allow `broker` + `coordinator`
-- =====================================================================
--
-- `senior_agent` is intentionally preserved — existing membership rows
-- continue to validate. New brokerages can adopt `broker` directly;
-- legacy brokerages can migrate via a one-shot UPDATE when ready.
--
-- `coordinator` is a new operational role between `agent` and
-- `team_lead` for deal-flow / viewing-coordination ops.

ALTER TABLE public.organization_memberships
  DROP CONSTRAINT IF EXISTS organization_memberships_org_role_check;

ALTER TABLE public.organization_memberships
  ADD CONSTRAINT organization_memberships_org_role_check
  CHECK (org_role IN (
    'brokerage_owner',
    'branch_manager',
    'team_lead',
    'broker',          -- NEW: senior producer tier (preferred name going forward)
    'senior_agent',    -- PRESERVED: legacy alias for `broker`
    'coordinator',     -- NEW: deal-flow / viewing-coordination operational role
    'junior_agent',
    'assistant'
  ));


-- =====================================================================
-- 4. Seed new permission rows
-- =====================================================================
--
-- Categories follow the convention from 20260430000003: `admin`,
-- `listings`, `contacts`, `activities`, `crm`, `property`, `platform`,
-- `support` (new), `org` (new).

INSERT INTO public.permissions (name, description, category) VALUES
  -- Support workspace (platform-staff read-only triage)
  ('support.access',
   'Open the platform support workspace (read-only triage of customer accounts)',
   'support'),
  ('support.impersonate',
   'View customer surfaces as a specific user for ticket triage (audited; no write actions)',
   'support'),

  -- Org-tier team management (granular scopes)
  ('org.team.manage.team',
   'Edit team-member rosters within your own team (team-lead scope)',
   'org'),
  ('org.team.manage.branch',
   'Edit team-member rosters across all teams in your branch (branch-manager scope)',
   'org'),

  -- Org-tier deal coordination
  ('org.deals.coordinate',
   'Schedule viewings, coordinate deal milestones, and reassign tasks within the org',
   'org'),

  -- Lease management scoping (today only `leases.manage` exists; add scoped variants)
  ('leases.manage.team',
   'Create / activate / terminate leases for tenants assigned to your team',
   'property'),
  ('leases.manage.branch',
   'Create / activate / terminate leases for any tenant in your branch',
   'property'),
  ('leases.manage.org',
   'Create / activate / terminate leases for any tenant in your organization',
   'property')
ON CONFLICT (name) DO NOTHING;


-- =====================================================================
-- 5. Default role bindings (additive — never disturbs existing rows)
-- =====================================================================

-- Admin: every new permission. Re-uses the same blanket pattern from
-- 20260430000003. ON CONFLICT keeps existing bindings intact.
INSERT INTO public.role_permissions (role, permission)
SELECT 'admin', name
FROM public.permissions
WHERE name IN (
  'support.access', 'support.impersonate',
  'org.team.manage.team', 'org.team.manage.branch',
  'org.deals.coordinate',
  'leases.manage.team', 'leases.manage.branch', 'leases.manage.org'
)
ON CONFLICT DO NOTHING;

-- Support: gets the support family + read-side activity perms. Cannot
-- write to listings/contacts/leases. The `users.manage` permission is
-- intentionally NOT granted — support staff cannot edit user roles.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('support', 'support.access'),
  ('support', 'support.impersonate'),
  ('support', 'admin.access'),         -- needed to load the platform shell
  ('support', 'listings.read.all'),
  ('support', 'contacts.read.all'),
  ('support', 'activities.read.all')
ON CONFLICT DO NOTHING;

-- Manager: gets branch-scoped lease manage + branch team manage by default.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('manager', 'leases.manage.team'),
  ('manager', 'leases.manage.branch'),
  ('manager', 'org.team.manage.team'),
  ('manager', 'org.team.manage.branch'),
  ('manager', 'org.deals.coordinate')
ON CONFLICT DO NOTHING;

-- Agent: gets team-scoped lease read-write (no branch/org scope) and
-- deal coordination on their own pipeline. Permissions remain a SOFT
-- gate — actual row visibility comes from RLS using membership scope.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('agent', 'org.deals.coordinate')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 6. Helper: resolve the user's effective org_role in a given org
-- =====================================================================
--
-- The client needs this to drive the OrgSecondaryNav filtering and
-- `useOrgPermission()` composable. SECURITY DEFINER + pinned search_path
-- per the same pattern as has_permission(). Bootstrap escape for the
-- Supabase SQL editor / service-role smoke tests.

CREATE OR REPLACE FUNCTION public.current_org_role(p_organization_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  -- Service-role / SQL editor escape: returns NULL (no org role) so
  -- the function is safe to call from smoke tests without authn.
  IF session_user IN ('postgres', 'supabase_admin', 'service_role')
     AND auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT m.org_role
  INTO v_role
  FROM public.organization_memberships m
  WHERE m.user_id = auth.uid()
    AND m.organization_id = p_organization_id
    AND m.status IN ('active', 'trial')
  ORDER BY
    -- If the user holds multiple roles in the same org (rare but
    -- allowed by the schema's UNIQUE constraint), return the most
    -- privileged one.
    CASE m.org_role
      WHEN 'brokerage_owner' THEN 1
      WHEN 'branch_manager'  THEN 2
      WHEN 'team_lead'       THEN 3
      WHEN 'broker'          THEN 4
      WHEN 'senior_agent'    THEN 4   -- legacy alias rank-equivalent to broker
      WHEN 'coordinator'     THEN 5
      WHEN 'junior_agent'    THEN 6
      WHEN 'assistant'       THEN 7
      ELSE 99
    END
  LIMIT 1;

  RETURN v_role;
END;
$$;

REVOKE ALL ON FUNCTION public.current_org_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_org_role(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_org_role(uuid) TO service_role;

COMMENT ON FUNCTION public.current_org_role(uuid) IS
  'Returns the calling user''s most-privileged active or trial org_role in the given organization, or NULL if not a member. Used by useOrgPermission() and OrgSecondaryNav filtering.';


-- =====================================================================
-- 7. Helper: list the user's active org memberships (for org switcher)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.my_org_memberships()
RETURNS TABLE (
  organization_id uuid,
  organization_name text,
  organization_slug text,
  org_role text,
  branch_id uuid,
  team_id uuid,
  status text,
  joined_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    o.name,
    o.slug,
    m.org_role,
    m.branch_id,
    m.team_id,
    m.status,
    m.joined_at
  FROM public.organization_memberships m
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.user_id = auth.uid()
    AND m.status IN ('active', 'trial')
  ORDER BY o.name;
$$;

REVOKE ALL ON FUNCTION public.my_org_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_org_memberships() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_org_memberships() TO service_role;

COMMENT ON FUNCTION public.my_org_memberships() IS
  'Returns one row per active/trial org membership for the calling user. Powers the org switcher in OrgShell + the workspace pill in the global header.';


-- =====================================================================
-- 8. Smoke tests (run by hand from the Supabase SQL editor; service-role
--    + auth.uid() IS NULL so the bootstrap escapes above kick in).
-- =====================================================================

DO $$
BEGIN
  -- Constraint widening took effect.
  PERFORM 1
  FROM information_schema.check_constraints
  WHERE constraint_name = 'profiles_role_check'
    AND check_clause LIKE '%support%';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profiles_role_check did not include `support` after migration';
  END IF;

  PERFORM 1
  FROM information_schema.check_constraints
  WHERE constraint_name = 'organization_memberships_org_role_check'
    AND check_clause LIKE '%broker%'
    AND check_clause LIKE '%coordinator%';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_memberships_org_role_check did not include broker + coordinator';
  END IF;

  -- Permission rows seeded.
  PERFORM 1 FROM public.permissions WHERE name = 'support.access';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support.access permission row missing after seed';
  END IF;
  PERFORM 1 FROM public.permissions WHERE name = 'org.deals.coordinate';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'org.deals.coordinate permission row missing after seed';
  END IF;

  -- Support role wired with the platform-shell-loading permission.
  PERFORM 1
  FROM public.role_permissions
  WHERE role = 'support' AND permission = 'admin.access';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support role missing admin.access binding (cannot load platform shell)';
  END IF;
END $$;
