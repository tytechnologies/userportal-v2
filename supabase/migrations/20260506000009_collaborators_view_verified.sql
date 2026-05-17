-- Extend public_listing_collaborators with the `verified` flag.
--
-- Powers the "Verified" badge next to co-broker chips on the website's
-- listing detail surface. Same posture as exposing `verified` on
-- public_profiles: an admin attestation, not the underlying license
-- info, so it's safe to anon.
--
-- Backward compatible: existing consumers (websiteo/server/api/public/
-- listings/[id]/collaborators.get.ts) select explicit column lists
-- that don't include `verified` — they keep returning today's shape.
-- New consumers can opt in.
--
-- ROLLBACK:
--   CREATE OR REPLACE VIEW public.public_listing_collaborators AS
--   SELECT
--     s.listing_id, s.shared_with_user_id AS user_id,
--     p.full_name AS display_name, p.avatar_url, p.slug, s.share_role AS role
--   FROM public.listing_shares s
--   JOIN public.public_profiles p ON p.id = s.shared_with_user_id
--   WHERE s.status = 'accepted'
--     AND (s.expires_at IS NULL OR s.expires_at > now());
--   NOTIFY pgrst, 'reload schema';
--
-- DEPENDS ON:
--   20260506000004_public_listing_collaborators.sql
--   20260506000008_profile_verifications.sql (adds verified column to public_profiles)


-- Column order MATTERS for CREATE OR REPLACE VIEW. Postgres only allows
-- ADDING columns at the END of the SELECT list — it cannot rename or
-- reorder existing positions (error 42P16). Migration 20260506000004
-- defined the view with role at position 6, so `verified` must go
-- after role, not before it. The website's select-by-name doesn't
-- care about order.

CREATE OR REPLACE VIEW public.public_listing_collaborators AS
SELECT
  s.listing_id,
  s.shared_with_user_id      AS user_id,
  p.full_name                AS display_name,
  p.avatar_url,
  p.slug,
  s.share_role               AS role,
  p.verified
FROM public.listing_shares s
JOIN public.public_profiles p ON p.id = s.shared_with_user_id
WHERE s.status = 'accepted'
  AND (s.expires_at IS NULL OR s.expires_at > now());

COMMENT ON VIEW public.public_listing_collaborators IS
  'Anon-safe accepted co-brokers per listing. Excludes pending / revoked / expired shares; excludes message, shared_by_user_id, timestamps, raw uuid. Definer-runs (security_invoker = false) so it can join through listing_shares (authenticated-only) into public_profiles. Adding a new column requires a deliberate migration here.';

GRANT SELECT ON public.public_listing_collaborators TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
