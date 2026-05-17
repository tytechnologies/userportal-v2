-- Anon-safe projection of accepted co-broker shares on listings.
--
-- Powers the website's listing-detail "Co-listed by …" surface. Public
-- buyers see who else is representing the listing without giving anon
-- direct access to the listing_shares table (which carries pending /
-- revoked rows, internal messages, granter UUIDs, expiry timestamps —
-- none of which buyers should see).
--
-- Same pattern as public_profiles (20260501000012) and
-- public_listing_details (20260506000001): the underlying object stays
-- locked down via authenticated-only RLS; this view re-projects an
-- anon-safe column list with explicit WHERE filtering for status +
-- expiration.
--
-- Definer-runs (default security_invoker = false), so the view itself
-- bypasses RLS on listing_shares + the underlying public_profiles. That
-- is intentional — the security boundary is the column list + the
-- WHERE clause, not RLS on the source.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.public_listing_collaborators;
--   NOTIFY pgrst, 'reload schema';
--
-- DEPENDS ON:
--   20260501000008_listing_shares.sql
--   20260501000012_profiles_anon_pii_lockdown.sql
--   20260506000003_profiles_slug.sql           (slug column on public_profiles)


CREATE OR REPLACE VIEW public.public_listing_collaborators AS
SELECT
  s.listing_id,
  s.shared_with_user_id      AS user_id,
  p.full_name                AS display_name,
  p.avatar_url,
  p.slug,
  s.share_role               AS role
FROM public.listing_shares s
JOIN public.public_profiles p ON p.id = s.shared_with_user_id
WHERE s.status = 'accepted'
  AND (s.expires_at IS NULL OR s.expires_at > now());

COMMENT ON VIEW public.public_listing_collaborators IS
  'Anon-safe accepted co-brokers per listing. Excludes pending / revoked / expired shares; excludes message, shared_by_user_id, timestamps, raw uuid. The view is definer-runs (security_invoker = false) so it can join through listing_shares (authenticated-only) into public_profiles. To expose a new column, add it here in a follow-up migration -- this view is intentionally NOT SELECT *.';

GRANT SELECT ON public.public_listing_collaborators TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
