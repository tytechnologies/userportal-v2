-- Remediation: ensure the FK on activities.user_id → profiles.id exists
-- and that PostgREST sees it.
--
-- Symptom (server log):
--   "Could not find a relationship between 'activities' and 'profiles'
--    in the schema cache"
--
-- This error is PostgREST telling us the relational select
--   actor:profiles!user_id (id, full_name, email, avatar_url)
-- can't be resolved because the FK isn't in its schema cache. Two
-- root causes both produce this exact message:
--
--   1. The FK doesn't actually exist. The Phase-4 migration that
--      created `activities` used CREATE TABLE IF NOT EXISTS, which
--      skips creation if a legacy table existed first — same trap as
--      the permissions/role_permissions issue. The follow-up
--      `INSERT ... REFERENCES public.profiles(id)` on the column
--      definition was therefore never applied.
--
--   2. The FK exists but PostgREST hasn't picked it up. Schema cache
--      gets stale after migrations on hosted Supabase if the project
--      didn't restart automatically.
--
-- Both fixes are run unconditionally and idempotently:
--
--   1. ALTER TABLE ADD CONSTRAINT IF NOT EXISTS-style guard wrapped in
--      a DO block (PG doesn't support IF NOT EXISTS for ADD CONSTRAINT
--      until 16; we check pg_constraint manually).
--   2. NOTIFY pgrst, 'reload schema' — Supabase wires this directly to
--      PostgREST's reload listener.
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql  (creates activities)
--   20260429000001_create_profiles_table.sql  (creates profiles)

-- =====================================================================
-- 1. Ensure the FK exists
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'activities_user_id_fkey'
      AND conrelid = 'public.activities'::regclass
  ) THEN
    -- ON DELETE SET NULL: deleting a user shouldn't take their audit
    -- history with them — the audit row stays, just loses attribution.
    -- Same semantics the original Phase-4 migration intended.
    ALTER TABLE public.activities
      ADD CONSTRAINT activities_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- =====================================================================
-- 2. Force PostgREST to reload its schema cache
-- =====================================================================
--
-- This is the canonical fix for "Could not find a relationship between
-- X and Y in the schema cache" on Supabase. The PostgREST listener
-- subscribes to this NOTIFY channel and reloads its cache on the next
-- request.

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- 3. Sanity comment for future you
-- =====================================================================

COMMENT ON CONSTRAINT activities_user_id_fkey ON public.activities IS
  'FK to profiles.id. Required for PostgREST relational selects like actor:profiles!user_id (...). ON DELETE SET NULL preserves audit rows when a user is deleted.';
