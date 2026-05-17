-- Remediation for 20260430000003_permissions_rbac.sql.
--
-- Symptom that drove this:
--   ERROR: column permissions.description does not exist
--
-- Root cause:
--   `CREATE TABLE IF NOT EXISTS public.permissions (...)` skipped table
--   creation because a legacy `permissions` table already existed in the
--   database (with just a `name` column). The follow-up
--   `INSERT INTO public.permissions (name, description, category)` then
--   referenced columns that didn't exist, the transaction rolled back,
--   and none of the policy rewrites in 20260430000003 took effect.
--
-- This migration is fully idempotent and safe to run regardless of what
-- state the prior migration left things in:
--   1. ALTER TABLE ADD COLUMN IF NOT EXISTS for every expected column on
--      both `permissions` and `role_permissions`.
--   2. Re-create has_permission() (CREATE OR REPLACE — no harm).
--   3. Re-seed catalog + bindings via INSERT ... ON CONFLICT DO NOTHING.
--   4. Re-apply RLS policies (DROP IF EXISTS + CREATE).
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql (current_user_role / current_user_team)
--
-- How to confirm it worked, post-apply:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'permissions';
--   -- Expect: name (text), description (text), category (text), created_at (timestamptz)
--
--   SELECT count(*) FROM public.permissions;        -- should be >= 21
--   SELECT count(*) FROM public.role_permissions;   -- should be > 0

-- =====================================================================
-- 1. Schema heal — additive ALTERs, every one IF NOT EXISTS
-- =====================================================================

-- Ensure base tables exist at all (in case the previous migration was
-- never even attempted).
CREATE TABLE IF NOT EXISTS public.permissions (
  name text PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role        text NOT NULL CHECK (role IN ('admin', 'manager', 'agent')),
  permission  text NOT NULL,
  PRIMARY KEY (role, permission)
);

-- Backfill missing columns on permissions.
ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS category    text;
ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now();

-- Default values for any rows seeded earlier without these columns.
UPDATE public.permissions
SET description = COALESCE(description, name),
    category    = COALESCE(category,    'general')
WHERE description IS NULL OR category IS NULL;

-- Now lock them down — these were intended NOT NULL in 20260430000003.
ALTER TABLE public.permissions
  ALTER COLUMN description SET NOT NULL;
ALTER TABLE public.permissions
  ALTER COLUMN category SET DEFAULT 'general';
ALTER TABLE public.permissions
  ALTER COLUMN category SET NOT NULL;

-- Backfill missing column on role_permissions.
ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Add the FK to permissions.name if missing. Wrapped because IF NOT
-- EXISTS isn't valid syntax for ADD CONSTRAINT in older PG versions.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'role_permissions_permission_fkey'
      AND conrelid = 'public.role_permissions'::regclass
  ) THEN
    ALTER TABLE public.role_permissions
      ADD CONSTRAINT role_permissions_permission_fkey
      FOREIGN KEY (permission) REFERENCES public.permissions(name)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_role_permissions_role
  ON public.role_permissions(role);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission
  ON public.role_permissions(permission);

COMMENT ON TABLE  public.permissions IS
  'Catalog of permission names. Seeded; admins do not edit directly today.';
COMMENT ON COLUMN public.permissions.name IS
  'Dotted identifier; referenced by has_permission() in RLS policies.';
COMMENT ON COLUMN public.permissions.category IS
  'Display group on the matrix UI: admin / listings / contacts / activities / teams.';
COMMENT ON TABLE  public.role_permissions IS
  'Which permissions each role has. Mutated by /admin UI; RLS limits writes to admins.';

-- =====================================================================
-- 2. has_permission() — re-create
-- =====================================================================

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

-- =====================================================================
-- 3. Seed catalog (idempotent — ON CONFLICT DO NOTHING)
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('admin.access',           'Open the /admin panel',                       'admin'),
  ('users.manage',           'Edit user profiles and roles',                'admin'),
  ('teams.manage',           'Create / edit / delete teams',                'admin'),
  ('permissions.manage',     'Edit role-permission bindings',               'admin'),

  ('listings.read.own',      'Read listings the user created',              'listings'),
  ('listings.read.team',     'Read listings created by team members',       'listings'),
  ('listings.read.all',      'Read every listing',                          'listings'),
  ('listings.write.own',     'Edit listings the user created',              'listings'),
  ('listings.write.team',    'Edit listings created by team members',       'listings'),
  ('listings.write.all',     'Edit every listing',                          'listings'),
  ('listings.delete',        'Hard-delete a listing (DELETE row)',          'listings'),

  ('contacts.read.own',      'Read contacts the user owns',                 'contacts'),
  ('contacts.read.team',     'Read contacts owned by team members',         'contacts'),
  ('contacts.read.all',      'Read every contact',                          'contacts'),
  ('contacts.write.own',     'Edit contacts the user owns',                 'contacts'),
  ('contacts.write.team',    'Edit contacts owned by team members',         'contacts'),
  ('contacts.write.all',     'Edit every contact',                          'contacts'),
  ('contacts.delete',        'Delete a contact',                            'contacts'),

  ('activities.read.own',    'Read your own activity log entries',          'activities'),
  ('activities.read.team',   'Read team members'' activity log entries',    'activities'),
  ('activities.read.all',    'Read every activity log entry',               'activities')
ON CONFLICT (name) DO UPDATE
  SET description = EXCLUDED.description,
      category    = EXCLUDED.category;

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
-- 4. RLS on permissions / role_permissions
-- =====================================================================

ALTER TABLE public.permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

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
-- 5. profiles policy (admin can update everyone)
-- =====================================================================

DROP POLICY IF EXISTS profiles_admin_update ON public.profiles;
CREATE POLICY profiles_admin_update
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (public.has_permission('users.manage'))
  WITH CHECK (public.has_permission('users.manage'));

-- =====================================================================
-- 6. Re-apply Phase-4 RLS rewrites (in case 20260430000003 rolled back)
-- =====================================================================
-- Same payloads as 20260430000003. Each is a 1:1 replacement for the
-- corresponding old policy; ordering doesn't matter because every CREATE
-- is preceded by a DROP IF EXISTS.

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

-- ----- ACTIVITIES -----
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

-- ----- TEAMS -----
DROP POLICY IF EXISTS teams_admin_write ON public.teams;
CREATE POLICY teams_admin_write
  ON public.teams FOR ALL
  TO authenticated
  USING (public.has_permission('teams.manage'))
  WITH CHECK (public.has_permission('teams.manage'));

-- =====================================================================
-- 7. Sanity: profiles SELECT is open to all authenticated
-- =====================================================================
-- Phase-4 already shipped this policy. Re-asserting it here defends
-- against the case where someone (a previous half-applied migration, a
-- dashboard tweak) dropped it. Without this, the /admin Users tab can
-- only see the current user's own row — which matches the symptom
-- you reported.

DROP POLICY IF EXISTS profiles_select_authenticated ON public.profiles;
CREATE POLICY profiles_select_authenticated
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);
