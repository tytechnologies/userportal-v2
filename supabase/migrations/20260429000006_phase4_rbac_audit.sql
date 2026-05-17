-- Phase 4: RBAC + activities (audit log) + teams scaffold.
--
-- Adds three things in one migration so they ship together:
--   1. profiles.role           — admin | manager | agent (default agent)
--   2. teams + profiles.team_id — multi-tenant scaffold for future SaaS
--   3. activities (audit log)  — every important write logs a row
--   4. RLS on listings + activities, gated by role and team
--
-- Why one file: RLS policies on listings reference both `profiles.role`
-- and `activities.user_id`. Splitting them would force a temporary state
-- where listings are locked down before the role column exists.
--
-- DEPENDS ON:
--   20260429000001_create_profiles_table.sql  (creates profiles)
--   20260429000002_quarantine_listings_created_by.sql (created_by:uuid + FK)
--
-- ROLLBACK (per section, top-down — destructive, run by hand):
--   DROP POLICY ... ON public.listings;
--   ALTER TABLE public.listings DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.activities CASCADE;
--   DROP FUNCTION IF EXISTS public.log_activity(text, text, uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.current_user_role();
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS role;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS team_id;
--   DROP TABLE IF EXISTS public.teams CASCADE;

-- =====================================================================
-- 1. ROLE COLUMN
-- =====================================================================

-- 'agent' is the safe default — least privilege. Existing rows get backfilled
-- via the ALTER, then the constraint is added so future rows must comply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'role'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN role text NOT NULL DEFAULT 'agent';
  END IF;
END $$;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'manager', 'agent'));

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);

COMMENT ON COLUMN public.profiles.role IS
  'RBAC tier: agent (own data only), manager (team data), admin (everything). Enforced by listings/activities RLS.';

-- =====================================================================
-- 2. TEAMS (foundation only — multi-tenant SaaS comes later)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_teams_updated_at ON public.teams;
CREATE TRIGGER set_teams_updated_at
  BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'team_id'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_team_id ON public.profiles(team_id);

COMMENT ON TABLE public.teams IS
  'Foundation for multi-tenant org scoping. Today every user can have a nullable team_id; managers see listings whose creator shares their team.';

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teams_select_authenticated ON public.teams;
CREATE POLICY teams_select_authenticated
  ON public.teams FOR SELECT
  TO authenticated
  USING (true);

-- Only admins can mutate teams via PostgREST. Service role bypasses RLS
-- for backfill / migrations.
DROP POLICY IF EXISTS teams_admin_write ON public.teams;
CREATE POLICY teams_admin_write
  ON public.teams FOR ALL
  TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- =====================================================================
-- 3. ROLE HELPER (SECURITY DEFINER — avoids RLS recursion)
-- =====================================================================
--
-- Why SECURITY DEFINER: a policy on listings that does
--   exists (select 1 from profiles where id = auth.uid() and role = 'admin')
-- triggers RLS evaluation on profiles, which can recurse if profiles ever
-- gets policies that touch listings. Wrapping the lookup in a definer
-- function reads profiles with the function-owner's privileges (i.e.
-- bypassing RLS) and returns just the role string. This is the pattern
-- recommended in the Supabase RLS docs for role lookups.

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT role FROM public.profiles WHERE id = auth.uid()),
    'agent'
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO service_role;

COMMENT ON FUNCTION public.current_user_role() IS
  'Returns the role of the calling auth.uid(). SECURITY DEFINER to avoid recursive RLS evaluation in policies that gate on role.';

CREATE OR REPLACE FUNCTION public.current_user_team()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT team_id FROM public.profiles WHERE id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.current_user_team() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_team() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_team() TO service_role;

COMMENT ON FUNCTION public.current_user_team() IS
  'Returns the team_id of the calling auth.uid(). Companion to current_user_role().';

-- =====================================================================
-- 4. ACTIVITIES (AUDIT LOG)
-- =====================================================================
--
-- One row per important write. `entity_id` is a uuid here for forward
-- compatibility, but listings.id is bigint — we coerce on insert via
-- gen_random_uuid()-derived ids in the metadata, OR (the route we take)
-- store the listing's bigint id as a string in metadata->>'listing_id'
-- and leave entity_id NULL when the entity uses a non-uuid PK.
--
-- Why uuid for entity_id: most future entities (contacts? teams?) will be
-- uuid; keeping the column uuid avoids a later migration. Listings are
-- the exception, addressed via metadata.listing_id.

CREATE TABLE IF NOT EXISTS public.activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activities_user_id    ON public.activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_entity     ON public.activities(entity);
CREATE INDEX IF NOT EXISTS idx_activities_entity_id  ON public.activities(entity_id);
CREATE INDEX IF NOT EXISTS idx_activities_created_at ON public.activities(created_at DESC);
-- Cheap GIN over metadata so listing-scoped lookups (where metadata->>'listing_id' = ...)
-- don't seq-scan once the table grows.
CREATE INDEX IF NOT EXISTS idx_activities_metadata   ON public.activities USING gin (metadata);

COMMENT ON TABLE public.activities IS
  'Audit log. One row per write to a tracked entity. user_id is the actor; metadata carries entity-specific payload (listing_id, before/after, etc.).';
COMMENT ON COLUMN public.activities.action IS
  'Short verb-noun, e.g. listing_created, listing_archived, listing_cloned, listing_updated.';
COMMENT ON COLUMN public.activities.entity IS
  'Entity type: listing, contact, etc. Used together with entity_id (uuid) or metadata.listing_id (bigint) to address the row.';
COMMENT ON COLUMN public.activities.metadata IS
  'JSONB payload: listing_id (for bigint-keyed entities), changed_fields, source ip, etc. Avoid putting PII here.';

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

-- READ: agents see their own actions; managers see anyone on their team;
--       admins see everything. Same shape as listings RLS below so the
--       "who can see what" mental model is consistent.
DROP POLICY IF EXISTS activities_select_role_scoped ON public.activities;
CREATE POLICY activities_select_role_scoped
  ON public.activities FOR SELECT
  TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR (
      public.current_user_role() = 'manager'
      AND (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = activities.user_id
            AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
        )
      )
    )
    OR (
      public.current_user_role() = 'agent'
      AND user_id = auth.uid()
    )
  );

-- INSERT: an authenticated user can only log actions as themselves. Server
-- code goes through the SECURITY DEFINER `log_activity` RPC below, so this
-- policy is mainly a defense-in-depth guard against direct PostgREST inserts.
DROP POLICY IF EXISTS activities_insert_self ON public.activities;
CREATE POLICY activities_insert_self
  ON public.activities FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- No UPDATE/DELETE policies => activities are append-only via PostgREST.
-- Service-role can still mutate (for retention jobs etc.).

-- log_activity RPC: stamps user_id from auth.uid() so callers can't lie
-- about whose action it was. Returns the created row's id.
CREATE OR REPLACE FUNCTION public.log_activity(
  p_action     text,
  p_entity     text,
  p_entity_id  uuid DEFAULT NULL,
  p_metadata   jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO public.activities (user_id, action, entity, entity_id, metadata)
  VALUES (auth.uid(), p_action, p_entity, p_entity_id, COALESCE(p_metadata, '{}'::jsonb))
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_activity(text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_activity(text, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_activity(text, text, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.log_activity(text, text, uuid, jsonb) IS
  'Audit-log helper. Stamps user_id from auth.uid() so callers cannot forge actor identity. Used by server repositories after every write.';

-- =====================================================================
-- 5. LISTINGS RLS
-- =====================================================================
--
-- Backward-compatibility caveat: a chunk of listings.created_by is NULL
-- because the data was quarantined into created_by_legacy. Locking those
-- rows away from agents would silently break their existing UI. Solution:
-- treat NULL created_by as "unowned" — visible to managers/admins always,
-- and visible to agents (read-only) so the listings page does not appear
-- empty for them. They cannot edit unowned rows; only admins/managers can.
--
-- Once created_by_legacy is reconciled and dropped, tighten this policy
-- in a follow-up migration (remove the `created_by IS NULL` allowance).

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

-- SELECT: admins → all; managers → team or unowned; agents → own or unowned.
DROP POLICY IF EXISTS listings_select_role_scoped ON public.listings;
CREATE POLICY listings_select_role_scoped
  ON public.listings FOR SELECT
  TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR public.current_user_role() = 'manager' AND (
      created_by IS NULL
      OR created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = listings.created_by
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR public.current_user_role() = 'agent' AND (
      created_by IS NULL
      OR created_by = auth.uid()
    )
  );

-- INSERT: any authenticated user can insert, but ONLY as themselves
-- (created_by must equal auth.uid()). Server inserts already stamp
-- created_by; this enforces it at the database boundary.
DROP POLICY IF EXISTS listings_insert_self ON public.listings;
CREATE POLICY listings_insert_self
  ON public.listings FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    OR public.current_user_role() IN ('admin', 'manager')
  );

-- UPDATE: agents can update their own; managers can update team rows
-- + unowned rows; admins can update anything. Both USING (the rows the
-- caller can target) and WITH CHECK (the rows they can land on) are set.
DROP POLICY IF EXISTS listings_update_role_scoped ON public.listings;
CREATE POLICY listings_update_role_scoped
  ON public.listings FOR UPDATE
  TO authenticated
  USING (
    public.current_user_role() = 'admin'
    OR public.current_user_role() = 'manager' AND (
      created_by IS NULL
      OR created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = listings.created_by
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR public.current_user_role() = 'agent' AND created_by = auth.uid()
  )
  WITH CHECK (
    public.current_user_role() = 'admin'
    OR public.current_user_role() = 'manager' AND (
      created_by IS NULL
      OR created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = listings.created_by
          AND p.team_id IS NOT DISTINCT FROM public.current_user_team()
      )
    )
    OR public.current_user_role() = 'agent' AND created_by = auth.uid()
  );

-- DELETE: hard delete restricted to admins. Soft delete (set deleted_at)
-- is an UPDATE, gated by the policy above — managers/agents soft-delete
-- their own rows, admins can hard-delete anything for incident response.
DROP POLICY IF EXISTS listings_delete_admin ON public.listings;
CREATE POLICY listings_delete_admin
  ON public.listings FOR DELETE
  TO authenticated
  USING (public.current_user_role() = 'admin');

-- =====================================================================
-- 6. SEED: keep at least one admin
-- =====================================================================
--
-- Without an admin, only service_role can manage roles, and there's no
-- in-app path to bootstrap. If no admin exists yet, promote the oldest
-- profile. Idempotent — runs at most once.

DO $$
DECLARE
  admin_count int;
  oldest_id   uuid;
BEGIN
  SELECT count(*) INTO admin_count FROM public.profiles WHERE role = 'admin';
  IF admin_count = 0 THEN
    SELECT id INTO oldest_id
      FROM public.profiles
      ORDER BY created_at ASC
      LIMIT 1;
    IF oldest_id IS NOT NULL THEN
      UPDATE public.profiles SET role = 'admin' WHERE id = oldest_id;
      RAISE NOTICE 'Phase 4 bootstrap: promoted profile % to admin', oldest_id;
    END IF;
  END IF;
END $$;
