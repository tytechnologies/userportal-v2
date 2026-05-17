-- Permission-layer RBAC. Replaces the role-name checks shipped in
-- 20260429000006_phase4_rbac_audit.sql with an indirection through a
-- catalog table + role↔permission join, gated by a single SECURITY
-- DEFINER function `public.has_permission(text)`.
--
-- Why this layer exists:
--   - The Phase-4 policies hard-coded role names ("admin", "manager",
--     "agent") into every USING/WITH CHECK clause. Granting an agent the
--     ability to view team listings required a SQL migration.
--   - With this layer, granting / revoking is a row in role_permissions.
--     The /admin UI in this repo writes to that table; RLS picks up the
--     change on the next request. Zero migrations to ship.
--
-- Backwards compatibility:
--   - Default seed mirrors current Phase-4 behavior exactly. Day 1, no
--     user sees a different set of rows than they did before this ran.
--   - `current_user_role()` and `current_user_team()` still exist —
--     `has_permission()` calls the former internally.
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql   (profiles.role/team_id, current_user_role)
--   20260430000002_contacts_rls.sql        (contacts RLS)
--
-- ROLLBACK (run by hand, top-to-bottom):
--   -- Restore Phase-4 policies — see 20260429000006.
--   DROP POLICY IF EXISTS ... ON public.listings;            -- (each new one)
--   DROP POLICY IF EXISTS ... ON public.contacts;
--   DROP POLICY IF EXISTS ... ON public.activities;
--   DROP POLICY IF EXISTS ... ON public.teams;
--   DROP FUNCTION IF EXISTS public.has_permission(text);
--   DROP TABLE IF EXISTS public.role_permissions;
--   DROP TABLE IF EXISTS public.permissions;

-- =====================================================================
-- 1. Catalog tables
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.permissions (
  name        text PRIMARY KEY,
  description text NOT NULL,
  category    text NOT NULL DEFAULT 'general',
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.permissions IS
  'Catalog of permission names. UI checkboxes are driven by SELECTs from this table; admins do not edit it directly today (would require a migration to add a new permission).';
COMMENT ON COLUMN public.permissions.name IS
  'Dotted identifier, e.g. listings.read.team. Stable — referenced by has_permission() calls in policies and by client code.';
COMMENT ON COLUMN public.permissions.category IS
  'Display group on the matrix UI: admin / listings / contacts / activities / teams.';

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role        text NOT NULL CHECK (role IN ('admin', 'manager', 'agent')),
  permission  text NOT NULL REFERENCES public.permissions(name) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON public.role_permissions(role);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission ON public.role_permissions(permission);

COMMENT ON TABLE public.role_permissions IS
  'Which permissions each role has. Single source of truth for has_permission(). Mutated by the /admin UI; RLS limits writes to admins.';

-- =====================================================================
-- 2. has_permission() — the only RPC RLS calls
-- =====================================================================
--
-- SECURITY DEFINER + pinned search_path: same pattern as
-- current_user_role(). Avoids RLS recursion on role_permissions
-- (policies on role_permissions cannot themselves call has_permission()
-- without infinite recursion — they use current_user_role() = 'admin'
-- as the bootstrap check).

CREATE OR REPLACE FUNCTION public.has_permission(permission_to_check text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.role_permissions rp
    WHERE rp.role = COALESCE(public.current_user_role(), 'agent')
      AND rp.permission = permission_to_check
  );
$$;

REVOKE ALL ON FUNCTION public.has_permission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(text) TO service_role;

COMMENT ON FUNCTION public.has_permission(text) IS
  'Returns true iff the calling user''s role has the named permission. The single check called by every Phase-4 RLS policy after this migration.';

-- =====================================================================
-- 3. Seed catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  -- Admin surface
  ('admin.access',           'Open the /admin panel',                       'admin'),
  ('users.manage',           'Edit user profiles and roles',                'admin'),
  ('teams.manage',           'Create / edit / delete teams',                'admin'),
  ('permissions.manage',     'Edit role-permission bindings',               'admin'),

  -- Listings
  ('listings.read.own',      'Read listings the user created',              'listings'),
  ('listings.read.team',     'Read listings created by team members',       'listings'),
  ('listings.read.all',      'Read every listing',                          'listings'),
  ('listings.write.own',     'Edit listings the user created',              'listings'),
  ('listings.write.team',    'Edit listings created by team members',       'listings'),
  ('listings.write.all',     'Edit every listing',                          'listings'),
  ('listings.delete',        'Hard-delete a listing (DELETE row)',          'listings'),

  -- Contacts
  ('contacts.read.own',      'Read contacts the user owns',                 'contacts'),
  ('contacts.read.team',     'Read contacts owned by team members',         'contacts'),
  ('contacts.read.all',      'Read every contact',                          'contacts'),
  ('contacts.write.own',     'Edit contacts the user owns',                 'contacts'),
  ('contacts.write.team',    'Edit contacts owned by team members',         'contacts'),
  ('contacts.write.all',     'Edit every contact',                          'contacts'),
  ('contacts.delete',        'Delete a contact',                            'contacts'),

  -- Audit log
  ('activities.read.own',    'Read your own activity log entries',          'activities'),
  ('activities.read.team',   'Read team members'' activity log entries',    'activities'),
  ('activities.read.all',    'Read every activity log entry',               'activities')
ON CONFLICT (name) DO NOTHING;

-- Default role bindings (mirror Phase-4 behavior).
INSERT INTO public.role_permissions (role, permission)
SELECT 'admin', name FROM public.permissions
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('manager', 'listings.read.own'),
  ('manager', 'listings.read.team'),
  ('manager', 'listings.write.own'),
  ('manager', 'listings.write.team'),
  ('manager', 'contacts.read.own'),
  ('manager', 'contacts.read.team'),
  ('manager', 'contacts.write.own'),
  ('manager', 'contacts.write.team'),
  ('manager', 'activities.read.own'),
  ('manager', 'activities.read.team')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('agent', 'listings.read.own'),
  ('agent', 'listings.write.own'),
  ('agent', 'contacts.read.own'),
  ('agent', 'contacts.write.own'),
  ('agent', 'activities.read.own')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 4. RLS on permissions + role_permissions themselves
-- =====================================================================
--
-- IMPORTANT: bootstrap with current_user_role() = 'admin' instead of
-- has_permission('permissions.manage'). If we used has_permission() here
-- and an admin accidentally revoked permissions.manage from themselves,
-- they could lock the entire admin pool out of the table forever. The
-- role-name fallback guarantees the role 'admin' always retains the
-- ability to fix the configuration.

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS permissions_select_authenticated ON public.permissions;
CREATE POLICY permissions_select_authenticated
  ON public.permissions FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS permissions_admin_write ON public.permissions;
CREATE POLICY permissions_admin_write
  ON public.permissions FOR ALL
  TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_select_authenticated ON public.role_permissions;
CREATE POLICY role_permissions_select_authenticated
  ON public.role_permissions FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS role_permissions_admin_write ON public.role_permissions;
CREATE POLICY role_permissions_admin_write
  ON public.role_permissions FOR ALL
  TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- =====================================================================
-- 5. profiles: admin can update everyone's role
-- =====================================================================
--
-- Phase-4 only allowed users to update their OWN profile (via the
-- 20260429000001 profiles_update_own policy). The /admin UI needs to
-- write profiles.role for other users — add a manager-bypass policy.
-- The two policies OR together: a row passes if EITHER matches.

DROP POLICY IF EXISTS profiles_admin_update ON public.profiles;
CREATE POLICY profiles_admin_update
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (public.has_permission('users.manage'))
  WITH CHECK (public.has_permission('users.manage'));

-- =====================================================================
-- 6. Rewrite Phase-4 RLS to use has_permission()
-- =====================================================================
--
-- Same logic as before, just routed through the permission name. Each
-- new policy is a 1:1 replacement for the corresponding old policy.

-- ----- LISTINGS -----

DROP POLICY IF EXISTS listings_select_role_scoped ON public.listings;
CREATE POLICY listings_select_role_scoped
  ON public.listings FOR SELECT
  TO authenticated
  USING (
    public.has_permission('listings.read.all')
    OR (
      public.has_permission('listings.read.team') AND (
        created_by IS NULL
        OR created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = listings.created_by
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR (
      public.has_permission('listings.read.own') AND (
        created_by IS NULL
        OR created_by = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS listings_insert_self ON public.listings;
CREATE POLICY listings_insert_self
  ON public.listings FOR INSERT
  TO authenticated
  WITH CHECK (
    (created_by = auth.uid() AND public.has_permission('listings.write.own'))
    OR public.has_permission('listings.write.all')
    OR public.has_permission('listings.write.team')
  );

DROP POLICY IF EXISTS listings_update_role_scoped ON public.listings;
CREATE POLICY listings_update_role_scoped
  ON public.listings FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('listings.write.all')
    OR (
      public.has_permission('listings.write.team') AND (
        created_by IS NULL
        OR created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = listings.created_by
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR (public.has_permission('listings.write.own') AND created_by = auth.uid())
  )
  WITH CHECK (
    public.has_permission('listings.write.all')
    OR (
      public.has_permission('listings.write.team') AND (
        created_by IS NULL
        OR created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = listings.created_by
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR (public.has_permission('listings.write.own') AND created_by = auth.uid())
  );

DROP POLICY IF EXISTS listings_delete_admin ON public.listings;
CREATE POLICY listings_delete_admin
  ON public.listings FOR DELETE
  TO authenticated
  USING (public.has_permission('listings.delete'));

-- ----- CONTACTS -----

DROP POLICY IF EXISTS contacts_select_role_scoped ON public.contacts;
CREATE POLICY contacts_select_role_scoped
  ON public.contacts FOR SELECT
  TO authenticated
  USING (
    public.has_permission('contacts.read.all')
    OR (
      public.has_permission('contacts.read.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = contacts.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR (public.has_permission('contacts.read.own') AND owner_user_id = auth.uid())
  );

DROP POLICY IF EXISTS contacts_insert_self ON public.contacts;
CREATE POLICY contacts_insert_self
  ON public.contacts FOR INSERT
  TO authenticated
  WITH CHECK (
    (owner_user_id = auth.uid() AND public.has_permission('contacts.write.own'))
    OR public.has_permission('contacts.write.all')
    OR public.has_permission('contacts.write.team')
  );

DROP POLICY IF EXISTS contacts_update_role_scoped ON public.contacts;
CREATE POLICY contacts_update_role_scoped
  ON public.contacts FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('contacts.write.all')
    OR (
      public.has_permission('contacts.write.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = contacts.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR (public.has_permission('contacts.write.own') AND owner_user_id = auth.uid())
  )
  WITH CHECK (
    public.has_permission('contacts.write.all')
    OR (
      public.has_permission('contacts.write.team') AND (
        owner_user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = contacts.owner_user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR (public.has_permission('contacts.write.own') AND owner_user_id = auth.uid())
  );

DROP POLICY IF EXISTS contacts_delete_role_scoped ON public.contacts;
CREATE POLICY contacts_delete_role_scoped
  ON public.contacts FOR DELETE
  TO authenticated
  USING (
    public.has_permission('contacts.delete') AND (
      public.has_permission('contacts.read.all')
      OR (
        public.has_permission('contacts.read.team') AND (
          owner_user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = contacts.owner_user_id
              AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
          )
        )
      )
      OR owner_user_id = auth.uid()
    )
  );

-- ----- ACTIVITIES (audit log) -----

DROP POLICY IF EXISTS activities_select_role_scoped ON public.activities;
CREATE POLICY activities_select_role_scoped
  ON public.activities FOR SELECT
  TO authenticated
  USING (
    public.has_permission('activities.read.all')
    OR (
      public.has_permission('activities.read.team') AND (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = activities.user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR (public.has_permission('activities.read.own') AND user_id = auth.uid())
  );

-- INSERT policy on activities is unchanged from Phase 4 (any authenticated
-- user can log AS THEMSELVES) because the log_activity RPC is the only
-- writer and it stamps user_id from auth.uid(). No permission check needed.

-- ----- TEAMS -----

DROP POLICY IF EXISTS teams_admin_write ON public.teams;
CREATE POLICY teams_admin_write
  ON public.teams FOR ALL
  TO authenticated
  USING (public.has_permission('teams.manage'))
  WITH CHECK (public.has_permission('teams.manage'));
