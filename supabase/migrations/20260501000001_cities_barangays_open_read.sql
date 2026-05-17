-- Reference-data RLS: cities + barangays must be readable by every
-- authenticated user. They are pure lookup tables (Philippine
-- geography); there is no per-user privacy concern, but if RLS is on
-- without a SELECT policy, PostgREST returns 0 rows and the listings
-- filters break (city / barangay dropdowns empty).
--
-- This migration is idempotent and safe regardless of current RLS
-- state. It:
--   1. Enables RLS on both tables (no-op if already on).
--   2. Re-asserts an open SELECT policy for `authenticated`.
--   3. Re-asserts an admin-only write policy so non-admins cannot
--      mutate the lookup tables (city/barangay catalogs are
--      managed by ops, not end users).
--   4. NOTIFY pgrst, 'reload schema' so PostgREST picks the new
--      policies up immediately.
--
-- Why open SELECT to everyone authenticated: the listings page filter
-- dropdowns need them, and they're not sensitive. If the public
-- (anon) site also needs them, add a similar policy `TO anon`.
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql  (current_user_role helper)

ALTER TABLE public.cities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.barangays ENABLE ROW LEVEL SECURITY;

-- Table-level GRANT — RLS is necessary but NOT sufficient. If the role
-- doesn't have SELECT privilege at the table level, PostgREST returns 0
-- rows even when an open RLS policy applies. The existing `{public}`
-- and `{anon}` policies were correct; the missing piece was this grant.
GRANT SELECT ON public.cities    TO authenticated, anon;
GRANT SELECT ON public.barangays TO authenticated, anon;

-- ----- cities -----
DROP POLICY IF EXISTS cities_select_authenticated ON public.cities;
CREATE POLICY cities_select_authenticated
  ON public.cities FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS cities_admin_write ON public.cities;
CREATE POLICY cities_admin_write
  ON public.cities FOR ALL
  TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- ----- barangays -----
DROP POLICY IF EXISTS barangays_select_authenticated ON public.barangays;
CREATE POLICY barangays_select_authenticated
  ON public.barangays FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS barangays_admin_write ON public.barangays;
CREATE POLICY barangays_admin_write
  ON public.barangays FOR ALL
  TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- Force PostgREST to reload its schema cache so the new policies take
-- effect immediately rather than on the next deploy / restart.
NOTIFY pgrst, 'reload schema';
