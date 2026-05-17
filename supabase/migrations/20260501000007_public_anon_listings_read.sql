-- Public (anon) read policy on listings + profiles for the public site.
--
-- Phase 4 RLS targets `TO authenticated`, so unauthenticated reads
-- return zero rows from PostgREST. The marketing site reads listings
-- with the anon key — without this policy, every property page on
-- housinginteractive.com.ph silently 404s the moment Phase 4 ships
-- to production.
--
-- Scope intentionally narrow:
--   listings: only is_online = true AND deleted_at IS NULL. Drafts,
--             archived rows, and soft-deleted rows are NEVER exposed.
--   profiles: read all (so listings can join the creator's name +
--             avatar for the agent card on the public listing page).
--             Email and phone are still readable here — if you want
--             to scrub PII for anon, switch to a dedicated public_view
--             with only safe columns.
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql

DROP POLICY IF EXISTS listings_select_public ON public.listings;
CREATE POLICY listings_select_public
  ON public.listings FOR SELECT
  TO anon
  USING (
    is_online = true
    AND deleted_at IS NULL
  );

-- Profiles read for anon: so the public listing page can show the
-- creator's name + avatar. RLS for `authenticated` already exists
-- (USING (true)); we add a separate `TO anon` policy with the same
-- shape so PostgREST returns join data on the unauthenticated path.
DROP POLICY IF EXISTS profiles_select_public ON public.profiles;
CREATE POLICY profiles_select_public
  ON public.profiles FOR SELECT
  TO anon
  USING (true);

-- Buildings: the public site likely needs these for property pages
-- (creator card + property name). Reference data; safe to expose.
DROP POLICY IF EXISTS buildings_select_public ON public.buildings;
CREATE POLICY buildings_select_public
  ON public.buildings FOR SELECT
  TO anon
  USING (true);

-- Cities + barangays already have anon-readable policies via
-- 20260501000001; nothing else to do for those.

-- Table-level GRANTs — RLS is necessary but not sufficient.
GRANT SELECT ON public.listings  TO anon;
GRANT SELECT ON public.profiles  TO anon;
GRANT SELECT ON public.buildings TO anon;

NOTIFY pgrst, 'reload schema';
