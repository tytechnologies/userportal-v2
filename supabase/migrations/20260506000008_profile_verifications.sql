-- Agent profile verifications.
--
-- Lets agents submit license / brokerage info for admin review and
-- exposes a `verified` boolean on the anon-safe public_profiles view
-- once an approval lands. The boolean is the marketplace's primary
-- "this agent is who they say they are" signal until a richer
-- trust-score layer ships later.
--
-- Schema posture:
--   - One row per submission (multiple-submission allowed for resubmits
--     after rejection). `status` distinguishes pending / approved /
--     rejected.
--   - License + brokerage info is text only — no FK to a separate
--     authority registry. Adequate for a manual review process.
--   - evidence_url is free-form (S3, Drive, anything the admin can
--     open). File-upload UX is a future round; today the agent pastes
--     a link.
--
-- RLS:
--   - SELECT: own row OR admins (users.manage)
--   - INSERT: self only (profile_id = auth.uid())
--   - UPDATE: admins only (review action; can't be used by recipient
--     to self-approve)
--   - DELETE: admins only (rare; e.g. moderation)
--
-- Public exposure:
--   `public_profiles.verified` is an EXISTS subquery against approved
--   rows. The underlying table stays authenticated-only — license
--   numbers / evidence / decision notes never reach anon.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.profile_verifications CASCADE;
--   DELETE FROM public.permissions
--     WHERE name IN ('verifications.submit', 'verifications.review');
--   CREATE OR REPLACE VIEW public.public_profiles AS
--     SELECT id, full_name, avatar_url, role, slug FROM public.profiles;
--   NOTIFY pgrst, 'reload schema';
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql (has_permission)
--   20260501000012_profiles_anon_pii_lockdown.sql (public_profiles view)
--   20260506000003_profiles_slug.sql               (slug column on view)


-- =====================================================================
-- 1. Table
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.profile_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),

  -- What the agent attests
  license_number    text,
  license_authority text,  -- e.g. 'PRC', 'HLURB', 'DTI'
  brokerage_name    text,
  evidence_url      text,
  -- Free-form context the agent provides at submission time
  applicant_notes   text,

  -- Review state — written by the PATCH endpoint under admin auth
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  review_notes  text,  -- admin's reasoning on the decision

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_verifications_profile_idx
  ON public.profile_verifications(profile_id);

-- Hot path: admin queue + the EXISTS check on public_profiles.verified.
-- Partial indexes minimize size since most rows are approved/rejected
-- in the long run.
CREATE INDEX IF NOT EXISTS profile_verifications_pending_idx
  ON public.profile_verifications(submitted_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS profile_verifications_approved_idx
  ON public.profile_verifications(profile_id)
  WHERE status = 'approved';

DROP TRIGGER IF EXISTS set_profile_verifications_updated_at
  ON public.profile_verifications;
CREATE TRIGGER set_profile_verifications_updated_at
  BEFORE UPDATE ON public.profile_verifications
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.profile_verifications IS
  'Agent verification submissions and review state. One row per submission; multiple per profile_id allowed for resubmits. License + evidence stay authenticated-only; only the boolean "approved exists" propagates to the anon public_profiles view.';


-- =====================================================================
-- 2. Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('verifications.submit', 'Submit a verification request for own profile', 'users'),
  ('verifications.review', 'Review and approve/reject verification requests', 'users')
ON CONFLICT (name) DO NOTHING;

-- All authenticated roles can submit; only admin can review.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'verifications.submit'),
  ('admin',   'verifications.review'),
  ('manager', 'verifications.submit'),
  ('agent',   'verifications.submit')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 3. RLS
-- =====================================================================

ALTER TABLE public.profile_verifications ENABLE ROW LEVEL SECURITY;

-- SELECT: agent sees own; admin (users.manage) sees all.
DROP POLICY IF EXISTS profile_verifications_select_own_or_admin
  ON public.profile_verifications;
CREATE POLICY profile_verifications_select_own_or_admin
  ON public.profile_verifications FOR SELECT
  TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.has_permission('users.manage')
  );

-- INSERT: agent inserts only for themselves. Status defaults to
-- 'pending' (CHECK constraint above); they can't land an 'approved' row.
DROP POLICY IF EXISTS profile_verifications_insert_self
  ON public.profile_verifications;
CREATE POLICY profile_verifications_insert_self
  ON public.profile_verifications FOR INSERT
  TO authenticated
  WITH CHECK (
    profile_id = auth.uid()
    AND public.has_permission('verifications.submit')
  );

-- UPDATE: admin only. WITH CHECK is the same predicate — admins can't
-- "transfer" a row to a non-admin context that would let it be edited
-- further by anyone but admins.
DROP POLICY IF EXISTS profile_verifications_update_admin
  ON public.profile_verifications;
CREATE POLICY profile_verifications_update_admin
  ON public.profile_verifications FOR UPDATE
  TO authenticated
  USING (public.has_permission('verifications.review'))
  WITH CHECK (public.has_permission('verifications.review'));

-- DELETE: admin only.
DROP POLICY IF EXISTS profile_verifications_delete_admin
  ON public.profile_verifications;
CREATE POLICY profile_verifications_delete_admin
  ON public.profile_verifications FOR DELETE
  TO authenticated
  USING (public.has_permission('verifications.review'));


-- =====================================================================
-- 4. Re-create public_profiles to expose `verified`
-- =====================================================================
--
-- Same column set + verified. Existing readers (`agent-card.get.ts`,
-- `agents/[slug].get.ts`, `public_listing_collaborators` view) select
-- explicit column lists that don't include `verified` — they keep
-- working byte-for-byte. New consumers can opt in.

CREATE OR REPLACE VIEW public.public_profiles AS
SELECT
  p.id,
  p.full_name,
  p.avatar_url,
  p.role,
  p.slug,
  EXISTS (
    SELECT 1
    FROM public.profile_verifications v
    WHERE v.profile_id = p.id
      AND v.status = 'approved'
  ) AS verified
FROM public.profiles p;

COMMENT ON VIEW public.public_profiles IS
  'Anon-safe projection of profiles. Exposes id / full_name / avatar_url / role / slug / verified. The verified flag is true if at least one approved verification exists; underlying license / evidence stays authenticated-only.';

GRANT SELECT ON public.public_profiles TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
