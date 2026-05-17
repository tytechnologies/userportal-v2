-- Fix: listings page filters show "Cities: 0 / Barangays: 0" even
-- though the tables have data (63 cities, 486 barangays in DB).
--
-- Cause: 20260501000001 created RLS policies for `cities` and
-- `barangays` scoped `TO authenticated USING (true)`. Some client
-- code paths hit these tables before the supabase-js session is
-- attached to the request — the call goes out as the `anon` role and
-- RLS silently filters every row out (no error, just []).
--
-- These are pure reference lookups (Philippine geography). The
-- 20260501000001 migration's own comment recommends opening the
-- SELECT branch to `anon` if the public site needs them. The
-- listings filter UI counts as that public surface (renders before
-- the session is necessarily ready), so this widens the read.
--
-- WRITE policies stay admin-only — only the read branch widens.
--
-- The GRANT in 20260501000001 already covered `anon`; this migration
-- just adds the matching RLS policy.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS cities_select_anon    ON public.cities;
--   DROP POLICY IF EXISTS barangays_select_anon ON public.barangays;

DROP POLICY IF EXISTS cities_select_anon ON public.cities;
CREATE POLICY cities_select_anon
  ON public.cities FOR SELECT
  TO anon
  USING (true);

DROP POLICY IF EXISTS barangays_select_anon ON public.barangays;
CREATE POLICY barangays_select_anon
  ON public.barangays FOR SELECT
  TO anon
  USING (true);

NOTIFY pgrst, 'reload schema';
