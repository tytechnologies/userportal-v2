-- Trust + Reputation foundation.
--
-- Five additive objects, no destructive changes:
--   1. public.reviews                   — polymorphic ratings/reviews
--   2. public.review_reports            — abuse-flag queue
--   3. public.listing_verifications     — verified-listing badge
--   4. public.building_verifications    — verified-building badge
--   5. public.trust_score (view)        — deterministic per-target score
--
-- Plus: new permissions catalog entries, RLS policies, indexes,
-- self-review prevention trigger, target-id format CHECK trigger.
--
-- Existing infrastructure reused as-is (NOT replaced):
--   - profile_verifications (broker / owner verification)
--   - public_profiles + public_listing_collaborators (verified flag)
--   - notifications + notify() helper (new kinds are free-form text)
--   - activities + log_activity (new verbs are free-form text)
--   - webhook_subscriptions (new event_kinds are free-form text)
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.trust_score;
--   DROP TABLE IF EXISTS public.review_reports;
--   DROP TABLE IF EXISTS public.reviews;
--   DROP TABLE IF EXISTS public.listing_verifications;
--   DROP TABLE IF EXISTS public.building_verifications;
--   DELETE FROM public.permissions WHERE name IN
--     ('reviews.moderate', 'verifications.review_listings',
--      'verifications.review_buildings');


-- =====================================================================
-- 1. reviews — polymorphic ratings / written reviews
-- =====================================================================
--
-- target_type is the entity being reviewed; target_id is its key.
-- Why polymorphic: agents / buildings / listings / developers all
-- accept reviews under the same shape. Splitting per-target would
-- multiply tables without reducing complexity (every join needs to
-- know the target type anyway).
--
-- target_id is text because the four target types use different PK
-- types (uuid for profiles, bigint for listings/buildings, text for
-- developers — which today live in a denormalized `developer_name`
-- string). The format-validation trigger below enforces correctness
-- per target_type.

CREATE TABLE IF NOT EXISTS public.reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Polymorphic target
  target_type       text NOT NULL CHECK (target_type IN
                       ('agent', 'building', 'developer', 'listing', 'owner')),
  target_id         text NOT NULL,

  -- Reviewer (always an authenticated portal user; no anonymous
  -- public reviews). FK guarantees deletion cascades clean.
  reviewer_user_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Overall rating, 1.0–5.0 in 0.5 increments (UI rounds; check
  -- enforces the range only).
  rating            numeric(2,1) NOT NULL CHECK (rating >= 1.0 AND rating <= 5.0),

  -- Multi-dimension breakdown. Keys server-side-allowlisted to:
  --   responsiveness, professionalism, accuracy, transparency,
  --   property_condition
  -- Each value 1.0–5.0. Empty {} = no per-dimension breakdown.
  dimensions        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Free-form text review. Bounded so a single row can't be
  -- weaponized as a denial-of-storage vector.
  title             text,
  body              text NOT NULL CHECK (char_length(body) <= 5000),

  -- Optional verification context — e.g., the inquiry/transaction
  -- that proves the reviewer interacted with the target. Strengthens
  -- against drive-by reviews. Loose FK (text) so future evidence
  -- types (transaction record, document share, ...) plug in.
  evidence_kind     text CHECK (evidence_kind IS NULL OR evidence_kind IN
                       ('inquiry', 'shared_listing', 'transaction', 'manual')),
  evidence_ref      text,

  -- Display preferences (privacy)
  reviewer_display  text NOT NULL DEFAULT 'full_name'
                       CHECK (reviewer_display IN ('full_name', 'initials_only', 'hidden')),

  -- Moderation. hidden_at is the soft-delete: admin moderation
  -- removes from public view but preserves the row for audit.
  hidden_at         timestamptz,
  hidden_reason     text,
  hidden_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Lifecycle
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- One review per (reviewer, target). Re-reviews UPDATE the
  -- existing row, not insert a new one — keeps the rating distribution
  -- honest.
  UNIQUE (reviewer_user_id, target_type, target_id)
);

-- Hot indexes:
--   1. Per-target lookup (the "show me reviews for this agent" query)
CREATE INDEX IF NOT EXISTS reviews_target_idx
  ON public.reviews (target_type, target_id, created_at DESC);
--   2. Per-reviewer (a user's own review history)
CREATE INDEX IF NOT EXISTS reviews_reviewer_idx
  ON public.reviews (reviewer_user_id, created_at DESC);
--   3. Visible-only filter for public surfaces — partial index keeps
--      the working set small as hidden reviews accumulate
CREATE INDEX IF NOT EXISTS reviews_target_visible_idx
  ON public.reviews (target_type, target_id, created_at DESC)
  WHERE hidden_at IS NULL;

DROP TRIGGER IF EXISTS set_reviews_updated_at ON public.reviews;
CREATE TRIGGER set_reviews_updated_at
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.reviews IS
  'Polymorphic reviews/ratings. target_type ∈ {agent, building, developer, listing, owner}. UNIQUE(reviewer, target_type, target_id) → one review per pair. hidden_at = moderation soft-delete (preserves audit). dimensions jsonb holds multi-axis breakdown.';


-- =====================================================================
-- 2. Self-review + target-format enforcement triggers
-- =====================================================================
--
-- Two BEFORE-INSERT (and UPDATE) triggers:
--   a. format_target_id   — uuid for agent/owner; bigint-string for
--                           listing/building; free-text for developer.
--   b. block_self_reviews — reviewer can't review themselves (agent),
--                           their own listings (listing), or owners
--                           who are themselves.
--
-- Both abort with 22023 (invalid_parameter_value) so the API can
-- map cleanly to 400.

CREATE OR REPLACE FUNCTION public.reviews_validate_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_listing_owner uuid;
BEGIN
  -- Format check on target_id by target_type.
  IF NEW.target_type IN ('agent', 'owner') THEN
    IF NEW.target_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'target_id must be uuid for target_type=%', NEW.target_type
        USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.target_type IN ('listing', 'building') THEN
    IF NEW.target_id !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'target_id must be numeric for target_type=%', NEW.target_type
        USING ERRCODE = '22023';
    END IF;
  END IF;
  -- developer: any non-empty string is fine for now.

  -- Self-review prevention.
  IF NEW.target_type = 'agent' AND NEW.target_id::text = NEW.reviewer_user_id::text THEN
    RAISE EXCEPTION 'cannot review yourself (target_type=agent)'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.target_type = 'owner' AND NEW.target_id::text = NEW.reviewer_user_id::text THEN
    RAISE EXCEPTION 'cannot review yourself (target_type=owner)'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.target_type = 'listing' THEN
    SELECT created_by INTO v_listing_owner
      FROM public.listings WHERE id = NEW.target_id::bigint;
    IF v_listing_owner IS NOT NULL AND v_listing_owner = NEW.reviewer_user_id THEN
      RAISE EXCEPTION 'cannot review your own listing'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reviews_validate ON public.reviews;
CREATE TRIGGER reviews_validate
  BEFORE INSERT OR UPDATE OF target_type, target_id, reviewer_user_id
  ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.reviews_validate_fn();


-- =====================================================================
-- 3. RLS — reviews
-- =====================================================================

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

-- READ: visible (hidden_at IS NULL) is public; the reviewer always
-- sees their own (even if hidden); moderators see all.
DROP POLICY IF EXISTS reviews_select_public ON public.reviews;
CREATE POLICY reviews_select_public
  ON public.reviews FOR SELECT
  TO anon, authenticated
  USING (
    hidden_at IS NULL
    OR reviewer_user_id = auth.uid()
    OR public.has_permission('reviews.moderate')
  );

-- INSERT: any authenticated user; format/self-review trigger does
-- the heavy lifting. RLS just gates auth.
DROP POLICY IF EXISTS reviews_insert_self ON public.reviews;
CREATE POLICY reviews_insert_self
  ON public.reviews FOR INSERT
  TO authenticated
  WITH CHECK (reviewer_user_id = auth.uid());

-- UPDATE: reviewer can edit their own (rating, body, dimensions);
-- moderators can flip hidden_at + hidden_reason.
DROP POLICY IF EXISTS reviews_update ON public.reviews;
CREATE POLICY reviews_update
  ON public.reviews FOR UPDATE
  TO authenticated
  USING (
    reviewer_user_id = auth.uid()
    OR public.has_permission('reviews.moderate')
  )
  WITH CHECK (
    reviewer_user_id = auth.uid()
    OR public.has_permission('reviews.moderate')
  );

-- DELETE: reviewer (cascade) or moderator. Soft-delete (hidden_at)
-- preferred; hard delete loses the audit row.
DROP POLICY IF EXISTS reviews_delete ON public.reviews;
CREATE POLICY reviews_delete
  ON public.reviews FOR DELETE
  TO authenticated
  USING (
    reviewer_user_id = auth.uid()
    OR public.has_permission('reviews.moderate')
  );


-- =====================================================================
-- 4. review_reports — abuse-flag queue
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.review_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       uuid NOT NULL REFERENCES public.reviews(id) ON DELETE CASCADE,
  reporter_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason          text NOT NULL CHECK (char_length(reason) <= 2000),
  status          text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'reviewed', 'dismissed')),
  reviewed_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  review_notes    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One report per (review, reporter) — repeated reports update.
  UNIQUE (review_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS review_reports_review_idx
  ON public.review_reports(review_id, status);
CREATE INDEX IF NOT EXISTS review_reports_open_queue_idx
  ON public.review_reports(created_at DESC) WHERE status = 'open';

ALTER TABLE public.review_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS review_reports_insert ON public.review_reports;
CREATE POLICY review_reports_insert
  ON public.review_reports FOR INSERT
  TO authenticated
  WITH CHECK (reporter_user_id = auth.uid());

DROP POLICY IF EXISTS review_reports_select ON public.review_reports;
CREATE POLICY review_reports_select
  ON public.review_reports FOR SELECT
  TO authenticated
  USING (
    reporter_user_id = auth.uid()
    OR public.has_permission('reviews.moderate')
  );

DROP POLICY IF EXISTS review_reports_update_admin ON public.review_reports;
CREATE POLICY review_reports_update_admin
  ON public.review_reports FOR UPDATE
  TO authenticated
  USING (public.has_permission('reviews.moderate'))
  WITH CHECK (public.has_permission('reviews.moderate'));


-- =====================================================================
-- 5. listing_verifications + building_verifications
-- =====================================================================
--
-- Mirror the shape of profile_verifications. Separate tables (not a
-- single polymorphic verifications table) because the subject types
-- have different PK types (bigint vs uuid) and FK constraints catch
-- bad data at write time.

CREATE TABLE IF NOT EXISTS public.listing_verifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id          bigint NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  submitted_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected')),
  evidence_url        text,
  applicant_notes     text,
  reviewed_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  review_notes        text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  -- One pending request per listing — re-requests UPDATE.
  UNIQUE (listing_id)
);

CREATE INDEX IF NOT EXISTS listing_verifications_status_idx
  ON public.listing_verifications(status, submitted_at DESC);

ALTER TABLE public.listing_verifications ENABLE ROW LEVEL SECURITY;

-- Listing owner submits; admin reviews.
DROP POLICY IF EXISTS listing_verifications_select ON public.listing_verifications;
CREATE POLICY listing_verifications_select
  ON public.listing_verifications FOR SELECT
  TO authenticated
  USING (
    submitted_by = auth.uid()
    OR public.has_permission('verifications.review_listings')
    OR EXISTS (
      SELECT 1 FROM public.listings l
       WHERE l.id = listing_verifications.listing_id
         AND l.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS listing_verifications_insert ON public.listing_verifications;
CREATE POLICY listing_verifications_insert
  ON public.listing_verifications FOR INSERT
  TO authenticated
  WITH CHECK (
    submitted_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.listings l
       WHERE l.id = listing_verifications.listing_id
         AND l.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS listing_verifications_update_admin ON public.listing_verifications;
CREATE POLICY listing_verifications_update_admin
  ON public.listing_verifications FOR UPDATE
  TO authenticated
  USING (public.has_permission('verifications.review_listings'))
  WITH CHECK (public.has_permission('verifications.review_listings'));


CREATE TABLE IF NOT EXISTS public.building_verifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         bigint NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  submitted_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected')),
  evidence_url        text,
  applicant_notes     text,
  reviewed_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  review_notes        text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id)
);

CREATE INDEX IF NOT EXISTS building_verifications_status_idx
  ON public.building_verifications(status, submitted_at DESC);

ALTER TABLE public.building_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS building_verifications_select ON public.building_verifications;
CREATE POLICY building_verifications_select
  ON public.building_verifications FOR SELECT
  TO authenticated
  USING (
    submitted_by = auth.uid()
    OR public.has_permission('verifications.review_buildings')
  );

DROP POLICY IF EXISTS building_verifications_insert ON public.building_verifications;
CREATE POLICY building_verifications_insert
  ON public.building_verifications FOR INSERT
  TO authenticated
  WITH CHECK (submitted_by = auth.uid());

DROP POLICY IF EXISTS building_verifications_update_admin ON public.building_verifications;
CREATE POLICY building_verifications_update_admin
  ON public.building_verifications FOR UPDATE
  TO authenticated
  USING (public.has_permission('verifications.review_buildings'))
  WITH CHECK (public.has_permission('verifications.review_buildings'));


-- =====================================================================
-- 6. Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('reviews.moderate', 'Hide / unhide reviews + resolve abuse reports', 'reviews'),
  ('verifications.review_listings', 'Approve / reject listing verification requests', 'verifications'),
  ('verifications.review_buildings', 'Approve / reject building verification requests', 'verifications')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'reviews.moderate'),
  ('admin', 'verifications.review_listings'),
  ('admin', 'verifications.review_buildings')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 7. trust_score view — deterministic per-target
-- =====================================================================
--
-- Inputs (all already in the schema):
--   - reviews.rating + dimensions (visible only)
--   - profile_verifications.status (for agent/owner)
--   - listing_verifications.status (for listing)
--   - building_verifications.status (for building)
--
-- Output: 0–100 score with breakdown.
--
-- Pure SQL view, no caching. Cheap because:
--   - reviews_target_visible_idx covers per-target aggregation
--   - verification tables have status indexes
-- If profile pages get heavy and the view is too slow, we add a
-- denorm refresh (next-turn material).

CREATE OR REPLACE VIEW public.trust_score AS
WITH review_aggregates AS (
  SELECT
    target_type,
    target_id,
    count(*)                            AS review_count,
    avg(rating)::numeric(3,2)           AS avg_rating,
    coalesce(avg((dimensions->>'responsiveness')::numeric)::numeric(3,2), null)
                                        AS avg_responsiveness,
    coalesce(avg((dimensions->>'professionalism')::numeric)::numeric(3,2), null)
                                        AS avg_professionalism,
    coalesce(avg((dimensions->>'accuracy')::numeric)::numeric(3,2), null)
                                        AS avg_accuracy,
    coalesce(avg((dimensions->>'transparency')::numeric)::numeric(3,2), null)
                                        AS avg_transparency,
    coalesce(avg((dimensions->>'property_condition')::numeric)::numeric(3,2), null)
                                        AS avg_property_condition
  FROM public.reviews
  WHERE hidden_at IS NULL
  GROUP BY target_type, target_id
),
agent_verification AS (
  SELECT profile_id::text AS target_id, true AS verified
  FROM public.profile_verifications
  WHERE status = 'approved'
),
listing_verification AS (
  SELECT listing_id::text AS target_id, true AS verified
  FROM public.listing_verifications
  WHERE status = 'approved'
),
building_verification AS (
  SELECT property_id::text AS target_id, true AS verified
  FROM public.building_verifications
  WHERE status = 'approved'
)
SELECT
  ra.target_type,
  ra.target_id,
  ra.review_count,
  ra.avg_rating,
  ra.avg_responsiveness,
  ra.avg_professionalism,
  ra.avg_accuracy,
  ra.avg_transparency,
  ra.avg_property_condition,
  -- Verification per-type. Each LEFT JOIN is gated on target_type so
  -- the wrong table never matches a wrong-type id collision.
  CASE
    WHEN ra.target_type IN ('agent', 'owner') THEN av.verified
    WHEN ra.target_type = 'listing'           THEN lv.verified
    WHEN ra.target_type = 'building'          THEN bv.verified
    ELSE false
  END                                AS verified,
  -- Score formula (0–100). Deterministic, no ML:
  --   60%  → review average normalized to 0–60 (rating 1.0 → 0,
  --          rating 5.0 → 60). Cold-start: 0 if review_count < 3
  --          (we don't pretend confidence on 1–2 reviews).
  --   25%  → verified flag (yes = 25, no = 0)
  --   15%  → review-volume bonus, capped (10 reviews = full 15)
  LEAST(100,
    CASE
      WHEN ra.review_count < 3 THEN 0
      ELSE round(((ra.avg_rating - 1.0) / 4.0) * 60)::int
    END
    + CASE
        WHEN ra.target_type IN ('agent', 'owner') AND av.verified IS TRUE THEN 25
        WHEN ra.target_type = 'listing'           AND lv.verified IS TRUE THEN 25
        WHEN ra.target_type = 'building'          AND bv.verified IS TRUE THEN 25
        ELSE 0
      END
    + LEAST(15, ra.review_count)
  )                                  AS trust_score
FROM review_aggregates ra
LEFT JOIN agent_verification    av ON ra.target_type IN ('agent','owner') AND av.target_id = ra.target_id
LEFT JOIN listing_verification  lv ON ra.target_type = 'listing'         AND lv.target_id = ra.target_id
LEFT JOIN building_verification bv ON ra.target_type = 'building'        AND bv.target_id = ra.target_id;

GRANT SELECT ON public.trust_score TO anon, authenticated;

COMMENT ON VIEW public.trust_score IS
  'Deterministic per-target trust score (0–100). 60% review-derived (cold-start guard at 3 reviews), 25% verification, 15% volume. No ML; pure SQL. Cheap reads via reviews_target_visible_idx + verification status indexes.';


NOTIFY pgrst, 'reload schema';
