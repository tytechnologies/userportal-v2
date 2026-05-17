-- Tighten listing_sources read access + add admin-only rotate RPC.
--
-- Round 6 shipped listing_sources with `SELECT TO authenticated USING (true)`
-- so any authenticated portal user could read `ingest_secret` for every
-- partner. That's a leak — agents shouldn't be able to harvest source
-- bearers. This migration replaces the broad read with admin-gating
-- (mirrors the write side, which already requires sources.manage), and
-- adds an explicit RPC for secret rotation that returns the new value
-- once for UI handoff.
--
-- Tightening read RLS is technically a behavior change, not strictly
-- additive — but the prior shape exposed credentials to roles that
-- have no business reading them. Treat as a security correction, not
-- a feature regression.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS listing_sources_select_admin ON public.listing_sources;
--   CREATE POLICY listing_sources_select_authenticated
--     ON public.listing_sources FOR SELECT
--     TO authenticated
--     USING (true);
--   DROP FUNCTION IF EXISTS public.rotate_listing_source_secret(bigint);
--
-- DEPENDS ON:
--   20260506000013_listing_sources.sql


-- =====================================================================
-- 1. Replace SELECT policy with admin-gated read
-- =====================================================================

DROP POLICY IF EXISTS listing_sources_select_authenticated ON public.listing_sources;
DROP POLICY IF EXISTS listing_sources_select_admin         ON public.listing_sources;

CREATE POLICY listing_sources_select_admin
  ON public.listing_sources FOR SELECT
  TO authenticated
  USING (public.has_permission('sources.manage'));

COMMENT ON POLICY listing_sources_select_admin ON public.listing_sources IS
  'Admin-only read. Sources carry ingest_secret which non-admin authenticated users have no business reading. Aligns the read posture with the existing write posture (also gated on sources.manage).';


-- =====================================================================
-- 2. rotate_listing_source_secret RPC
-- =====================================================================
--
-- SECURITY DEFINER so the function can mutate ingest_secret + return
-- the new value in a single round trip without granting raw UPDATE on
-- ingest_secret to the calling role. Body re-checks the permission so
-- the function can't be hijacked via a future GRANT to a wider role.
--
-- Returns the new 64-hex-char secret. Caller (admin UI) is expected
-- to display once and copy to clipboard — the value is also persisted
-- so future reads via the SELECT policy still work, but UI design
-- should treat rotation as the only legitimate way to surface the
-- secret in plaintext.

CREATE OR REPLACE FUNCTION public.rotate_listing_source_secret(p_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_secret text;
BEGIN
  -- Re-check authorization inside the function — the GRANT below
  -- exposes EXECUTE to authenticated, but only callers with the
  -- sources.manage permission may actually use it.
  IF NOT public.has_permission('sources.manage') THEN
    RAISE EXCEPTION 'Insufficient permissions to rotate listing source secret'
      USING ERRCODE = '42501';
  END IF;

  v_new_secret := encode(gen_random_bytes(32), 'hex');

  UPDATE public.listing_sources
     SET ingest_secret = v_new_secret,
         updated_at    = now()
   WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing_sources.id % not found', p_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN v_new_secret;
END
$$;

COMMENT ON FUNCTION public.rotate_listing_source_secret(bigint) IS
  'Generate a new 256-bit ingest_secret for the given source and return it. Admin-only via inline has_permission check. Returns the new value as a one-time response for the UI to display and copy.';

REVOKE ALL ON FUNCTION public.rotate_listing_source_secret(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rotate_listing_source_secret(bigint)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
