-- F-5 Phase 2: REVOKE anon SELECT on public.listing_details.
--
-- Closes the contact-PII leak that 20260506000001_public_listing_details_view.sql
-- (Phase 1) addressed for new code while leaving the original
-- materialized view world-readable. Phase 1 introduced the column-
-- restricted `public_listing_details` view; Phase 2 actually revokes
-- the anon grant on the underlying MV.
--
-- WHY:
-- listing_details holds denormalized contact PII (contact_email,
-- contact_home_phone, contact_mobile_number, contact_link,
-- contact_notes, contact_owner_user_id) sourced from public.contacts —
-- which is authenticated-only via 20260430000002_contacts_rls.sql.
-- Materialized views do NOT inherit RLS from their sources, and the
-- anon grant on listing_details meant anyone with the public anon
-- key could:
--   curl https://<proj>.supabase.co/rest/v1/listing_details?select=*
-- and harvest the entire contact PII denorm. Same class of leak that
-- 20260501000012_profiles_anon_pii_lockdown closed for profiles.
--
-- WHY THE VIEW STILL WORKS AFTER THIS REVOKE:
-- public.public_listing_details was created without
-- `WITH (security_invoker = on)`, so it runs with the privileges of
-- its OWNER (postgres) — not the calling anon role. Anon's grant on
-- the VIEW is the only check; the view's read of the underlying MV
-- is performed as postgres which has unrestricted access. Verified
-- against the Postgres 14+ default view-owner-rights semantics.
--
-- AUDIT (run before applying):
-- Confirm no anon caller other than the website's own queries hits
-- listing_details directly:
--   - websiteo/: every from('listing_details') reference has been
--     migrated to from('public_listing_details') as of the
--     20260506000001 deploy. Verified with grep on 2026-05-07.
--   - userportal/: only authenticated and service-role clients
--     touch the MV. Authenticated grant survives this REVOKE.
--   - Third-party / partner traffic: webhook subscribers receive
--     events; they don't read the MV. There is no documented
--     external integration that depends on anon-reading
--     listing_details.
--
-- ROLLBACK (if a previously-unknown anon caller breaks):
--   GRANT SELECT ON public.listing_details TO anon;
--   NOTIFY pgrst, 'reload schema';
--
-- DEPENDS ON:
--   20260506000001_public_listing_details_view.sql (the replacement)


-- =====================================================================
-- 1. Revoke anon access on the MV
-- =====================================================================

REVOKE SELECT ON public.listing_details FROM anon;

-- Belt + suspenders: also revoke from PUBLIC so a previously-existing
-- PUBLIC grant (which would silently re-include anon) doesn't leave
-- the surface readable. authenticated still has its grant via
-- existing GRANT SELECT TO authenticated; that survives this.
REVOKE SELECT ON public.listing_details FROM PUBLIC;


-- =====================================================================
-- 2. Sanity-check the view still works as the anon role
-- =====================================================================
--
-- Plpgsql DO block runs at apply time, not by callers. We SET LOCAL
-- ROLE anon, then SELECT through the view; if anything errors here
-- the migration aborts and the REVOKE rolls back via the implicit
-- transaction.
--
-- Why this is the migration's last line of defense: a misconfigured
-- view (one that we accidentally created with security_invoker=on,
-- or whose owner doesn't have access to the MV) would only surface
-- post-deploy when an anon caller hits it. Catching it here turns
-- a production 401 into a migration failure.

DO $$
BEGIN
  SET LOCAL ROLE anon;
  PERFORM 1 FROM public.public_listing_details LIMIT 1;
  RESET ROLE;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION
    'public_listing_details is not readable as anon after revoking listing_details: % — %',
    SQLSTATE, SQLERRM;
END $$;


NOTIFY pgrst, 'reload schema';
