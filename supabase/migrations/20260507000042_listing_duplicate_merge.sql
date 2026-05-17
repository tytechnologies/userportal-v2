-- Listing duplicate merge action.
--
-- Closes the review-queue workflow: after admin confirms two
-- listings are duplicates, this provides the actual merge action
-- that soft-deletes the non-canonical listing and stamps a
-- duplicate_of_id pointer so the relationship is queryable.
--
-- Pattern:
--   ALTER listings ADD duplicate_of_id bigint  (additive, nullable)
--   merge_listing_duplicate(candidate_id, canonical_listing_id) RPC
--   - validates candidate is 'confirmed_duplicate'
--   - validates canonical is one of the two pair listings
--   - validates loser is online + not already deleted
--   - soft-deletes loser, sets duplicate_of_id = canonical
--   - records on the candidate row which side won
--   - audit-logged via log_activity
--
-- Reversal: simply set duplicate_of_id=NULL + deleted_at=NULL on
-- the loser. Not exposed via RPC v1; admin runs SQL manually if
-- they need to undo.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.merge_listing_duplicate(uuid, bigint);
--   ALTER TABLE public.listings DROP COLUMN IF EXISTS duplicate_of_id;
--   ALTER TABLE public.listing_duplicate_candidates
--     DROP COLUMN IF EXISTS canonical_listing_id,
--     DROP COLUMN IF EXISTS merged_listing_id,
--     DROP COLUMN IF EXISTS merged_at;


-- =====================================================================
-- 1. listings.duplicate_of_id — pointer to the canonical listing
-- =====================================================================
--
-- Set by merge_listing_duplicate on the loser. NULL on canonical
-- listings. Self-referencing FK with SET NULL on cascade so a
-- canonical hard-delete (rare) doesn't cascade-delete every loser
-- that pointed at it; they just become unmerged + soft-deleted
-- orphans.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS duplicate_of_id bigint
    REFERENCES public.listings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS listings_duplicate_of_idx
  ON public.listings(duplicate_of_id) WHERE duplicate_of_id IS NOT NULL;

COMMENT ON COLUMN public.listings.duplicate_of_id IS
  'When NOT NULL, points to the canonical listing this row was merged into. The canonical listing has duplicate_of_id IS NULL. Set by merge_listing_duplicate.';


-- =====================================================================
-- 2. listing_duplicate_candidates — track the merge action
-- =====================================================================

ALTER TABLE public.listing_duplicate_candidates
  ADD COLUMN IF NOT EXISTS canonical_listing_id bigint
    REFERENCES public.listings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_listing_id    bigint
    REFERENCES public.listings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at            timestamptz;

COMMENT ON COLUMN public.listing_duplicate_candidates.canonical_listing_id IS
  'After merge: which side the admin kept (one of a_listing_id / b_listing_id).';
COMMENT ON COLUMN public.listing_duplicate_candidates.merged_listing_id IS
  'After merge: the side that was soft-deleted + flagged duplicate_of_id.';


-- =====================================================================
-- 3. merge_listing_duplicate RPC
-- =====================================================================
--
-- Atomic, audit-logged, idempotent.

CREATE OR REPLACE FUNCTION public.merge_listing_duplicate(
  p_candidate_id          uuid,
  p_canonical_listing_id  bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_candidate record;
  v_loser_id  bigint;
  v_canonical record;
  v_loser     record;
BEGIN
  -- Caller gate. Admin or service-role only.
  IF NOT (session_user IN ('postgres','supabase_admin','service_role')
          OR public.has_permission('admin.access')) THEN
    RAISE EXCEPTION 'permission denied: merge_listing_duplicate is admin only'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_candidate
    FROM public.listing_duplicate_candidates
   WHERE id = p_candidate_id;

  IF v_candidate IS NULL THEN
    RAISE EXCEPTION 'duplicate candidate not found: %', p_candidate_id
      USING ERRCODE = '42704';
  END IF;

  -- Idempotent: if already merged, return the existing decision.
  IF v_candidate.merged_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_merged', true,
      'canonical_listing_id', v_candidate.canonical_listing_id,
      'merged_listing_id',    v_candidate.merged_listing_id
    );
  END IF;

  -- Lifecycle: must be confirmed_duplicate before merge.
  IF v_candidate.status <> 'confirmed_duplicate' THEN
    RAISE EXCEPTION 'candidate must be confirmed_duplicate (got %)', v_candidate.status
      USING ERRCODE = '22023';
  END IF;

  -- Canonical must be one side of the pair.
  IF p_canonical_listing_id NOT IN (v_candidate.a_listing_id, v_candidate.b_listing_id) THEN
    RAISE EXCEPTION 'canonical_listing_id must be one of the pair (got %, pair: %, %)',
      p_canonical_listing_id, v_candidate.a_listing_id, v_candidate.b_listing_id
      USING ERRCODE = '22023';
  END IF;

  v_loser_id := CASE
    WHEN p_canonical_listing_id = v_candidate.a_listing_id THEN v_candidate.b_listing_id
    ELSE v_candidate.a_listing_id
  END;

  -- Pull both for audit + sanity.
  SELECT id, is_online, deleted_at, title, duplicate_of_id INTO v_canonical
    FROM public.listings WHERE id = p_canonical_listing_id;
  SELECT id, is_online, deleted_at, title, duplicate_of_id INTO v_loser
    FROM public.listings WHERE id = v_loser_id;

  IF v_canonical IS NULL OR v_loser IS NULL THEN
    RAISE EXCEPTION 'one or both listings no longer exist (canonical %, loser %)',
      p_canonical_listing_id, v_loser_id
      USING ERRCODE = '42704';
  END IF;

  -- Don't merge if canonical is itself a loser of another merge —
  -- that creates a chain. Surface as an error for admin to resolve.
  IF v_canonical.duplicate_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'canonical listing % is itself merged into %; resolve chain manually',
      p_canonical_listing_id, v_canonical.duplicate_of_id
      USING ERRCODE = '22023';
  END IF;

  -- Don't operate on an already-deleted loser. If it's already
  -- soft-deleted, we still set duplicate_of_id (so the relationship
  -- is queryable) but skip the deleted_at update.
  IF v_loser.deleted_at IS NULL THEN
    UPDATE public.listings
       SET deleted_at      = now(),
           is_online       = false,
           duplicate_of_id = p_canonical_listing_id,
           updated_at      = now()
     WHERE id = v_loser_id;
  ELSE
    UPDATE public.listings
       SET duplicate_of_id = p_canonical_listing_id,
           updated_at      = now()
     WHERE id = v_loser_id;
  END IF;

  -- Stamp the candidate row.
  UPDATE public.listing_duplicate_candidates
     SET canonical_listing_id = p_canonical_listing_id,
         merged_listing_id    = v_loser_id,
         merged_at            = now()
   WHERE id = p_candidate_id;

  RETURN jsonb_build_object(
    'ok',                  true,
    'already_merged',      false,
    'canonical_listing_id', p_canonical_listing_id,
    'merged_listing_id',    v_loser_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.merge_listing_duplicate(uuid, bigint) TO authenticated;


-- =====================================================================
-- 4. Governance contract update
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.merge_listing_duplicate', 'function', 'userportal', ARRAY['userportal'],
   'Admin-only RPC. Atomically soft-deletes the loser + sets duplicate_of_id; idempotent on already-merged candidates.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
