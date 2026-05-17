-- public.contacts: enable RLS + auto-stamp owner_user_id from auth.uid().
--
-- Until now this table had no RLS — any authenticated client could read or
-- mutate any row by id. Phase-4 RBAC locked down listings/activities;
-- contacts is the last gap.
--
-- Two-part design:
--   1. Set owner_user_id DEFAULT to auth.uid(). Clients no longer need to
--      send the column on INSERT — Postgres stamps it from the JWT. This
--      is the mechanism that enforces "DO NOT manually pass owner_user_id
--      from frontend" without breaking existing server endpoints that
--      still pass it explicitly (the explicit value still wins).
--   2. RLS policies that scope every operation to the owner, with the same
--      manager/admin escalation pattern as Phase 4 listings — managers see
--      teammates' contacts, admins see everything. current_user_role() and
--      current_user_team() come from 20260429000006_phase4_rbac_audit.sql.
--
-- DEPENDS ON:
--   20260429000001_create_profiles_table.sql       (profiles + auth trigger)
--   20260429000006_phase4_rbac_audit.sql           (current_user_role helper)
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS contacts_select_role_scoped ON public.contacts;
--   DROP POLICY IF EXISTS contacts_insert_self        ON public.contacts;
--   DROP POLICY IF EXISTS contacts_update_role_scoped ON public.contacts;
--   DROP POLICY IF EXISTS contacts_delete_role_scoped ON public.contacts;
--   ALTER TABLE public.contacts DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.contacts ALTER COLUMN owner_user_id DROP DEFAULT;

-- =====================================================================
-- 1. Auto-stamp owner_user_id from the calling user
-- =====================================================================
--
-- DEFAULT auth.uid() is evaluated by Postgres at INSERT time using the
-- session's JWT claim (`request.jwt.claim.sub`). For service-role inserts
-- there is no JWT, so DEFAULT yields NULL — which is what we want, the
-- server can pass the column explicitly when it needs to.
ALTER TABLE public.contacts
  ALTER COLUMN owner_user_id SET DEFAULT auth.uid();

COMMENT ON COLUMN public.contacts.owner_user_id IS
  'FK to profiles.id (= auth.users.id). Defaults to auth.uid() so authenticated clients never need to pass it on INSERT. RLS scopes every read/write to the owner (or manager/admin via Phase 4 helpers).';

-- =====================================================================
-- 2. Row Level Security
-- =====================================================================

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

-- SELECT: agents → own; managers → own + teammates; admins → all.
-- Mirrors the listings policy shape so the mental model stays consistent.
DROP POLICY IF EXISTS contacts_select_role_scoped ON public.contacts;
CREATE POLICY contacts_select_role_scoped
  ON public.contacts FOR SELECT
  TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR public.current_user_role() = 'manager' AND (
      owner_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = contacts.owner_user_id
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR owner_user_id = auth.uid()
  );

-- INSERT: any authenticated user can insert FOR THEMSELVES. Managers/admins
-- can insert with an explicit owner_user_id (e.g. seeding a row for an
-- agent on the team) but agents cannot land a row owned by anyone else.
DROP POLICY IF EXISTS contacts_insert_self ON public.contacts;
CREATE POLICY contacts_insert_self
  ON public.contacts FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid()
    OR public.current_user_role() IN ('admin', 'manager')
  );

-- UPDATE: same scope as SELECT, with WITH CHECK so an UPDATE cannot
-- transfer ownership to a row the caller wouldn't be allowed to write.
DROP POLICY IF EXISTS contacts_update_role_scoped ON public.contacts;
CREATE POLICY contacts_update_role_scoped
  ON public.contacts FOR UPDATE
  TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR public.current_user_role() = 'manager' AND (
      owner_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = contacts.owner_user_id
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR owner_user_id = auth.uid()
  )
  WITH CHECK (
    public.current_user_role() = 'admin'
    OR public.current_user_role() = 'manager' AND (
      owner_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = contacts.owner_user_id
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR owner_user_id = auth.uid()
  );

-- DELETE: agents can delete their own contacts; managers can delete on
-- their team; admins can delete anything. Hard delete is fine here —
-- contacts have FK references on listings (listings.contact_id) which
-- already use ON DELETE SET NULL or similar (verify in baseline schema).
DROP POLICY IF EXISTS contacts_delete_role_scoped ON public.contacts;
CREATE POLICY contacts_delete_role_scoped
  ON public.contacts FOR DELETE
  TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR public.current_user_role() = 'manager' AND (
      owner_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = contacts.owner_user_id
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR owner_user_id = auth.uid()
  );
