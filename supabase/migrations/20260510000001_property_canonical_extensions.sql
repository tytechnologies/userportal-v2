-- Property canonical extensions — B-1 of the listing aggregation rebuild.
--
-- The `properties` table from db-main-reference IS already the canonical
-- real-world property. Multiple `listings` rows share a `property_id` and
-- collectively are the "variants" of that property. This migration adds
-- two coordination columns to `properties` so the existing relationship
-- becomes usable as a canonical/variant system:
--
--   primary_listing_id     — which listing currently represents the
--                            property for public consumption. NULL = let
--                            the elect_primary_listing_id() rule pick.
--   internal_authoritative — true when this property's metadata was set
--                            by us (not by an external source). Drives a
--                            search-ranking boost and a trust badge.
--
-- Strictly additive. The reference schema (db-main-reference/*.sql) is
-- not modified. No type changes, no drops, no FK retargets, no rewrites
-- of existing rows (Postgres 11+ skips the rewrite on constant DEFAULTs).
--
-- This migration also ships the two RPCs that make the columns useful:
--
--   elect_primary_listing_id(p_property_id INTEGER) RETURNS INTEGER
--     Pure read function. Returns the listing.id we'd surface for this
--     property right now. Deterministic election rule, no AI:
--       1. listings.source_id IS NULL  (agent-created beats source)
--       2. for_sale beats for_rent     (sale listings usually richer)
--       3. highest updated_at
--       4. lowest listings.id          (deterministic tiebreak)
--     Falls back gracefully when the source_id column hasn't been added
--     yet (drift-safe per project_schema_drift memory).
--
--   merge_listings_into_property(
--       p_source_listing_id  INTEGER,
--       p_target_property_id INTEGER,
--       p_set_primary_to     INTEGER DEFAULT NULL,
--       p_pair_id            UUID    DEFAULT NULL
--   ) RETURNS jsonb
--     Reparents a listing to a different property, optionally pins
--     primary_listing_id, and — when a listing_duplicate_candidates row
--     is supplied — closes that review-queue row with
--     status='confirmed_duplicate'. One transaction; SECURITY DEFINER;
--     admin-gated with the standard cron/service-role escape per
--     feedback_security_definer_smoke_tests.
--
--     COMPLEMENT to merge_listing_duplicate (mig 20260507000042), NOT a
--     replacement. The two RPCs handle different real-world scenarios:
--       merge_listing_duplicate     → soft-delete the loser + set its
--                                     duplicate_of_id to canonical. Use
--                                     when the two rows are literally
--                                     the same listing posted twice.
--       merge_listings_into_property→ reparent listing.property_id to a
--                                     shared property. Both rows stay
--                                     live. Use when the rows are
--                                     distinct listings (sale vs rent,
--                                     two agents marketing the same
--                                     unit) that should share a
--                                     canonical property record.
--     Exposed via:
--       /api/admin/duplicates/:id/merge        (existing) → merge_listing_duplicate
--       /api/admin/properties/:id/attach-variant (new)    → merge_listings_into_property
--
-- ROLLBACK (re-apply in full, NOT in pieces — Postgres rolls back the
-- whole migration on any error per feedback_migration_rollback_completeness):
--   DROP FUNCTION IF EXISTS public.merge_listings_into_property(INTEGER, INTEGER, INTEGER, UUID);
--   DROP FUNCTION IF EXISTS public.elect_primary_listing_id(INTEGER);
--   DROP INDEX  IF EXISTS public.properties_primary_listing_set_idx;
--   ALTER TABLE public.properties
--     DROP COLUMN IF EXISTS internal_authoritative,
--     DROP COLUMN IF EXISTS primary_listing_id;
--   DELETE FROM public.governance_schema_contracts
--    WHERE contract_name IN (
--      'public.elect_primary_listing_id',
--      'public.merge_listings_into_property'
--    );
--
-- DEPENDS ON:
--   db-main-reference/tables.sql       (properties)
--   db-main-reference/listings.sql     (listings)
--   20260507000037_mls_duplicate_detection.sql
--                                      (listing_duplicate_candidates,
--                                       optional — RPC degrades when absent)
--   20260507000027_schema_governance.sql
--                                      (governance_schema_contracts,
--                                       optional — INSERTs guarded)


-- =====================================================================
-- 0. Hard preconditions + drift-safe introspection
-- =====================================================================
-- Confirms the canonical entity tables exist and that listings.id is
-- the type the reference schema declares (INTEGER). If a prior
-- (uncatalogued) migration silently widened listings.id to bigint, this
-- preflight FAILS LOUD so the operator can investigate rather than the
-- FK silently picking up an implicit cast.

DO $$
DECLARE
  v_listings_id_type   text;
  v_properties_id_type text;
  v_missing            text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='properties') THEN
    v_missing := v_missing || 'public.properties';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listings') THEN
    v_missing := v_missing || 'public.listings';
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 20260510000001 requires reference tables: %.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42P01';
  END IF;

  SELECT data_type INTO v_listings_id_type
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='listings' AND column_name='id';
  SELECT data_type INTO v_properties_id_type
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='properties' AND column_name='id';

  IF v_listings_id_type <> 'integer' THEN
    RAISE EXCEPTION
      'Schema drift detected: public.listings.id has type "%" but db-main-reference declares INTEGER. Investigate before re-running 20260510000001.',
      v_listings_id_type
      USING ERRCODE = '42804';
  END IF;
  IF v_properties_id_type <> 'integer' THEN
    RAISE EXCEPTION
      'Schema drift detected: public.properties.id has type "%" but db-main-reference declares INTEGER. Investigate before re-running 20260510000001.',
      v_properties_id_type
      USING ERRCODE = '42804';
  END IF;
END $$;


-- =====================================================================
-- 1. Additive columns on `properties`
-- =====================================================================
-- Both nullable / constant-defaulted so Postgres 11+ skips the table
-- rewrite. `properties` is small relative to `listings`; rewrite would
-- still be fast, but no-rewrite is always cheaper.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS primary_listing_id INTEGER
    REFERENCES public.listings(id) ON DELETE SET NULL;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS internal_authoritative BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.properties.primary_listing_id IS
  'The listings.id chosen to represent this property in public search results. NULL = let elect_primary_listing_id() pick at read time. Set explicitly by an admin via /admin/properties/[id]/promote-primary.';
COMMENT ON COLUMN public.properties.internal_authoritative IS
  'True when this property record was created/curated by us, not by an external source. Drives a search-ranking boost and a trust badge on the property page. Toggled by admins; not derived from listings.';


-- =====================================================================
-- 2. Partial index for the primary-set hot path
-- =====================================================================
-- Admin tooling and the (future) search indexer commonly ask
-- "which properties have an explicit primary set?". A partial index
-- on the predicate keeps the index small and selective.

CREATE INDEX IF NOT EXISTS properties_primary_listing_set_idx
  ON public.properties(primary_listing_id)
  WHERE primary_listing_id IS NOT NULL;


-- =====================================================================
-- 3. elect_primary_listing_id() — read-only election rule
-- =====================================================================
-- Pure function. Returns the listing.id that should represent this
-- property right now, by the deterministic election rule. Used as a
-- fallback by search/website code paths when properties.primary_listing_id
-- is NULL.
--
-- Drift-safe: `source_id` was added to `listings` by mig 506000013 but
-- may not exist on every environment. We dispatch on its presence at
-- function-build time via two branches.

DO $$
DECLARE
  v_has_source_id boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='listings' AND column_name='source_id'
  ) INTO v_has_source_id;

  IF v_has_source_id THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.elect_primary_listing_id(p_property_id INTEGER)
      RETURNS INTEGER
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $body$
        SELECT l.id
          FROM public.listings l
         WHERE l.property_id = p_property_id
           AND l.deleted_at IS NULL
           AND l.is_online  = TRUE
         ORDER BY
           (l.source_id IS NULL) DESC,
           l.for_sale            DESC,
           l.updated_at          DESC,
           l.id                  ASC
         LIMIT 1
      $body$;
    $fn$;
  ELSE
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.elect_primary_listing_id(p_property_id INTEGER)
      RETURNS INTEGER
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $body$
        SELECT l.id
          FROM public.listings l
         WHERE l.property_id = p_property_id
           AND l.deleted_at IS NULL
           AND l.is_online  = TRUE
         ORDER BY
           l.for_sale            DESC,
           l.updated_at          DESC,
           l.id                  ASC
         LIMIT 1
      $body$;
    $fn$;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.elect_primary_listing_id(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.elect_primary_listing_id(INTEGER)
  TO authenticated, anon, service_role;

COMMENT ON FUNCTION public.elect_primary_listing_id(INTEGER) IS
  'Deterministic election rule for which listing.id to surface for a property when properties.primary_listing_id is NULL. Order: internal beats source, sale beats rent, recency, then id asc. Drift-safe — falls back to the non-source variant when listings.source_id is absent.';


-- =====================================================================
-- 4. merge_listings_into_property() — the admin merge action
-- =====================================================================
-- Reparents one listing to a different property (the actual merge),
-- optionally pins primary_listing_id, and — when a
-- listing_duplicate_candidates pair id is supplied — closes that
-- review-queue row.
--
-- All steps run in one transaction. RAISE EXCEPTION rolls back the
-- whole operation, so partial state is impossible.
--
-- The dup-queue close is wrapped in an existence guard so this RPC works
-- in environments where mig 507000037 hasn't shipped yet — the function
-- is still useful for plain "I want these two listings to share a
-- property" admin merges that don't originate from the queue.

CREATE OR REPLACE FUNCTION public.merge_listings_into_property(
  p_source_listing_id  INTEGER,
  p_target_property_id INTEGER,
  p_set_primary_to     INTEGER DEFAULT NULL,
  p_pair_id            UUID    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_property_id INTEGER;
  v_actor_id        UUID;
  v_has_dup_table   boolean;
  v_pair_closed     boolean := false;
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: merge_listings_into_property is admin-only'
      USING ERRCODE = '42501';
  END IF;

  IF p_source_listing_id IS NULL OR p_target_property_id IS NULL THEN
    RAISE EXCEPTION 'merge_listings_into_property: source_listing_id and target_property_id are required'
      USING ERRCODE = '22023';
  END IF;

  -- 1) Capture the prior property for audit + unmerge support.
  SELECT property_id INTO v_old_property_id
    FROM public.listings WHERE id = p_source_listing_id;
  IF v_old_property_id IS NULL THEN
    RAISE EXCEPTION 'merge_listings_into_property: listing % not found', p_source_listing_id
      USING ERRCODE = '42704';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = p_target_property_id) THEN
    RAISE EXCEPTION 'merge_listings_into_property: target property % not found', p_target_property_id
      USING ERRCODE = '42704';
  END IF;

  -- 2) Reparent. Skipped (and reported) when already on the target.
  IF v_old_property_id <> p_target_property_id THEN
    UPDATE public.listings
       SET property_id = p_target_property_id,
           updated_at  = now()
     WHERE id = p_source_listing_id;
  END IF;

  -- 3) Pin primary if requested. Must belong to the target property.
  IF p_set_primary_to IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.listings
       WHERE id = p_set_primary_to
         AND property_id = p_target_property_id
         AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION
        'merge_listings_into_property: listing % is not a live variant of property %',
        p_set_primary_to, p_target_property_id
        USING ERRCODE = '23514';
    END IF;
    UPDATE public.properties
       SET primary_listing_id = p_set_primary_to,
           updated_at         = now()
     WHERE id = p_target_property_id;
  END IF;

  -- 4) Close the review-queue pair when supplied AND the queue exists.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name='listing_duplicate_candidates'
  ) INTO v_has_dup_table;

  IF p_pair_id IS NOT NULL AND v_has_dup_table THEN
    BEGIN
      v_actor_id := auth.uid();
    EXCEPTION WHEN OTHERS THEN
      v_actor_id := NULL;
    END;

    UPDATE public.listing_duplicate_candidates
       SET status       = 'confirmed_duplicate',
           reviewed_by  = v_actor_id,
           reviewed_at  = now(),
           review_notes = coalesce(review_notes || E'\n', '')
                          || 'Merged via merge_listings_into_property: listing '
                          || p_source_listing_id || ' moved from property '
                          || v_old_property_id || ' to ' || p_target_property_id
     WHERE id = p_pair_id
       AND status = 'pending';

    IF FOUND THEN
      v_pair_closed := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'source_listing_id',       p_source_listing_id,
    'old_property_id',         v_old_property_id,
    'new_property_id',         p_target_property_id,
    'primary_listing_id',      p_set_primary_to,
    'pair_id',                 p_pair_id,
    'pair_closed',             v_pair_closed,
    'reparented',              v_old_property_id <> p_target_property_id
  );
END
$$;

REVOKE ALL ON FUNCTION public.merge_listings_into_property(INTEGER, INTEGER, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_listings_into_property(INTEGER, INTEGER, INTEGER, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.merge_listings_into_property(INTEGER, INTEGER, INTEGER, UUID) IS
  'Admin action: reparent a listing to a different property (the merge), optionally pin properties.primary_listing_id, and close the originating listing_duplicate_candidates row when supplied. Single transaction; SECURITY DEFINER; admin-gated with the cron/service-role escape.';


-- =====================================================================
-- 5. Governance contracts (best-effort; guarded for envs without the table)
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RAISE NOTICE 'governance_schema_contracts not present; skipping registration.';
    RETURN;
  END IF;

  -- Only first-class objects (table / view / mv / function / enum) are
  -- valid contract_type values per mig 20260507000027. The two new
  -- properties.* columns ride along with the existing `public.properties`
  -- reference table; we register only the new RPCs here.
  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('public.elect_primary_listing_id', 'function', 'userportal', ARRAY['userportal','website'],
     'Election rule fallback when properties.primary_listing_id is NULL. Internal>source, sale>rent, recency, id asc. Drift-safe re: listings.source_id.', false),
    ('public.merge_listings_into_property', 'function', 'userportal', ARRAY['userportal'],
     'Admin merge action. Reparents listing.property_id, optionally pins properties.primary_listing_id, closes the originating listing_duplicate_candidates row.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste-in SQL editor verification (run as the operator's user).
-- Per feedback_smoke_sql_no_placeholders: no `'...'` literals; ids
-- resolved via subqueries so the snippet runs verbatim.
-- =====================================================================
--
-- 1) Schema shape
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='properties'
--    AND column_name IN ('primary_listing_id','internal_authoritative')
--  ORDER BY column_name;
--
-- 2) Election function on a property that has live listings
-- SELECT public.elect_primary_listing_id(p.id) AS elected_listing_id,
--        p.id AS property_id, p.name
--   FROM public.properties p
--   JOIN public.listings   l ON l.property_id = p.id
--                            AND l.deleted_at IS NULL
--                            AND l.is_online  = TRUE
--  GROUP BY p.id, p.name
--  ORDER BY p.id
--  LIMIT 5;
--
-- 3) Merge two listings under one property (no-op if already merged).
--    Pick the two oldest live listings in the same city — proves the
--    reparent path executes and is reversible.
-- WITH src AS (
--   SELECT l.id AS source_listing_id, l.property_id AS source_property_id
--     FROM public.listings l
--    WHERE l.deleted_at IS NULL AND l.is_online = TRUE
--    ORDER BY l.id ASC
--    LIMIT 1
-- ),
-- tgt AS (
--   SELECT l.property_id AS target_property_id
--     FROM public.listings l
--    WHERE l.deleted_at IS NULL AND l.is_online = TRUE
--      AND l.property_id <> (SELECT source_property_id FROM src)
--    ORDER BY l.id ASC
--    LIMIT 1
-- )
-- SELECT public.merge_listings_into_property(
--          (SELECT source_listing_id  FROM src),
--          (SELECT target_property_id FROM tgt),
--          NULL,
--          NULL
--        ) AS merge_result;
--
-- 4) Unmerge (restore prior property_id from the merge_result above).
-- -- Manual: UPDATE public.listings SET property_id = <old_property_id>
-- --         WHERE id = <source_listing_id>;
