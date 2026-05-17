-- Lock down anon access to public.profiles.
--
-- 000007 added `profiles_select_public TO anon USING (true)` so the
-- public website could join listings → profiles for the agent card.
-- That policy + table-level GRANT exposed every column on the row to
-- anyone with the anon key — including email, contact, home_phone,
-- notes, role, team_id. PII leak.
--
-- Fix: drop the broad anon policy, drop the anon table-level GRANT,
-- and expose a `public_profiles` view with only the columns the
-- website needs (id, full_name, avatar_url, role).
--
-- The website join changes from:
--     listings.select('*, creator:profiles(full_name, avatar_url)')
-- to:
--     listings.select('*, creator:public_profiles(full_name, avatar_url)')
--
-- Authenticated users keep full profile read via the existing
-- `profiles_select_authenticated` policy — admin tooling, contact
-- pickers, share modals, etc. all keep working.
--
-- DEPENDS ON:
--   20260501000007 (which we're partially undoing)

-- =====================================================================
-- 1. Revoke anon access to the table itself
-- =====================================================================

DROP POLICY IF EXISTS profiles_select_public ON public.profiles;
REVOKE SELECT ON public.profiles FROM anon;

-- =====================================================================
-- 2. Create the public-safe view
-- =====================================================================
--
-- security_invoker = false (the default) — the view runs as its
-- definer, bypassing RLS on profiles. That's fine here because the
-- view itself only exposes safe columns; the security boundary is the
-- column list, not RLS.
--
-- We do NOT include email, contact, home_phone, notes, team_id, or
-- created_at — none of those are needed by the public site.

CREATE OR REPLACE VIEW public.public_profiles AS
SELECT
  id,
  full_name,
  avatar_url,
  role
FROM public.profiles;

COMMENT ON VIEW public.public_profiles IS
  'Anon-safe projection of profiles. Exposes only id / full_name / avatar_url / role. Use this from the public website instead of reading profiles directly.';

GRANT SELECT ON public.public_profiles TO anon, authenticated;

-- =====================================================================
-- 3. Sanity belt: explicit GRANT revoke on PII columns at the table
--    level. Redundant with the table-level REVOKE above, but defends
--    against a future migration accidentally re-granting `SELECT ON
--    profiles TO anon`.
-- =====================================================================
--
-- Postgres column-level grants are strictly additive; there's no
-- "deny" verb. So this section is documentation more than enforcement
-- — but the comment on profiles makes the intent obvious.

COMMENT ON TABLE public.profiles IS
  'User profiles. PII-bearing columns (email, contact, home_phone, notes) MUST NOT be granted to anon. Public site reads go through public_profiles view instead.';

NOTIFY pgrst, 'reload schema';
