-- B-3.1 — listings_normalized → listings apply worker.
--
-- Mig 510000005 added the raw + normalized staging tables and a
-- normalize worker (raw → normalized). This migration adds the
-- second worker in the chain: normalized → listings.
--
-- Operating model — SHADOW MODE first.
--   /api/admin/listings/ingest still does its direct upsert into
--   listings (existing behavior). The new apply worker ALSO writes
--   the same data via the normalized path. Both writers must
--   converge on the same row content; we run them in parallel for a
--   parity-verification window before flipping the ingest endpoint
--   to skip the direct write.
--
-- Idempotency / dual-write safety
--   - Rows where match_status='matched_existing_listing' get UPDATEd
--     iff the existing listings.source_observed_at < the normalized
--     row's ingested_at. Prevents the apply worker from overwriting
--     a fresher direct-ingest write with stale normalized data.
--   - Rows where match_status='matched_existing_property' INSERT a
--     new listings row scoped by (source_id, foreign_id). Collides
--     on the partial unique index from mig 506000013; ON CONFLICT
--     DO NOTHING so the second writer is a clean no-op.
--   - matched_at IS NULL is the "not yet applied" predicate. The
--     worker stamps matched_at = now() per row regardless of whether
--     the underlying listings change applied or was a no-op.
--   - queued_for_review and rejected rows are NEVER touched by this
--     worker — admin verdict required.
--
-- The worker is bounded per call (p_max default 200) so cron ticks
-- stay fast even under burst load. The per-row work is in a savepoint
-- BEGIN/EXCEPTION block so one bad row doesn't fail the batch.
--
-- Strictly additive. No tables / columns modified. listings_normalized
-- and listings unchanged. Reference schema untouched.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.apply_listings_normalized_batch(int);
--   DELETE FROM public.governance_schema_contracts
--    WHERE contract_name = 'public.apply_listings_normalized_batch';
--
-- DEPENDS ON:
--   20260510000005_listings_raw_normalized.sql  (listings_normalized table)
--   20260506000013_listing_sources.sql          (partial unique on listings(source_id, foreign_id))


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listings_normalized') THEN
    v_missing := v_missing || 'public.listings_normalized (mig 510000005)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='listings'
                    AND column_name='source_id') THEN
    v_missing := v_missing || 'public.listings.source_id (mig 506000013)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='listings'
                    AND column_name='source_observed_at') THEN
    v_missing := v_missing || 'public.listings.source_observed_at (mig 506000013)';
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 20260513000005 missing prerequisites: %.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. apply_listings_normalized_batch
-- =====================================================================
-- Returns the per-pass counts:
--   processed       — rows the worker looked at
--   updated_existing — matched_existing_listing rows that resulted in an UPDATE
--   inserted_new    — matched_existing_property rows that resulted in an INSERT
--   skipped_stale   — matched_existing_listing rows skipped because the
--                     existing listings row is fresher
--   skipped_collision — matched_existing_property rows that collided on
--                     the (source_id, foreign_id) unique index
--   errors          — per-row exceptions caught + logged in match_notes

CREATE OR REPLACE FUNCTION public.apply_listings_normalized_batch(
  p_max int DEFAULT 200
)
RETURNS TABLE (
  processed         int,
  updated_existing  int,
  inserted_new      int,
  skipped_stale     int,
  skipped_collision int,
  errors            int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row             record;
  v_listing_observed_at timestamptz;
  v_new_listing_id  integer;
  c_processed       int := 0;
  c_updated         int := 0;
  c_inserted        int := 0;
  c_skipped_stale   int := 0;
  c_skipped_coll    int := 0;
  c_err             int := 0;
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: apply worker is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  FOR v_row IN
    SELECT *
      FROM public.listings_normalized
     WHERE matched_at IS NULL
       AND match_status IN ('matched_existing_listing', 'matched_existing_property')
     ORDER BY ingested_at ASC
     LIMIT p_max
     FOR UPDATE SKIP LOCKED
  LOOP
    c_processed := c_processed + 1;

    BEGIN
      IF v_row.match_status = 'matched_existing_listing' THEN
        -- Resolve must point at an existing row. If the listing was
        -- deleted between normalize-time and apply-time, treat as
        -- skipped_collision (the data we wanted to apply no longer
        -- has a home).
        SELECT source_observed_at INTO v_listing_observed_at
          FROM public.listings
         WHERE id = v_row.resolved_listing_id;

        IF v_listing_observed_at IS NULL THEN
          UPDATE public.listings_normalized
             SET matched_at = now(),
                 match_notes = coalesce(match_notes || E'\n', '')
                               || 'apply: listings row gone (resolved_listing_id='
                               || coalesce(v_row.resolved_listing_id::text, 'null') || ')'
           WHERE id = v_row.id;
          c_skipped_coll := c_skipped_coll + 1;
          CONTINUE;
        END IF;

        -- Staleness guard: if the listings row was updated AFTER this
        -- normalized row was ingested, a fresher write already won.
        -- Skip the apply but stamp matched_at to retire the row.
        IF v_listing_observed_at IS NOT NULL
           AND v_listing_observed_at >= v_row.ingested_at THEN
          UPDATE public.listings_normalized
             SET matched_at = now(),
                 match_notes = coalesce(match_notes || E'\n', '')
                               || 'apply: skipped (listings.source_observed_at fresher)'
           WHERE id = v_row.id;
          c_skipped_stale := c_skipped_stale + 1;
          CONTINUE;
        END IF;

        -- Apply.
        UPDATE public.listings
           SET title             = COALESCE(v_row.title, title),
               description       = COALESCE(v_row.description, description),
               property_category = COALESCE(v_row.property_category, property_category),
               property_type     = COALESCE(v_row.property_type, property_type),
               sale_price        = COALESCE(v_row.sale_price, sale_price),
               rent_price        = COALESCE(v_row.rent_price, rent_price),
               bedrooms          = COALESCE(v_row.bedrooms, bedrooms),
               bathrooms         = COALESCE(v_row.bathrooms, bathrooms),
               floor_area        = COALESCE(v_row.floor_area, floor_area),
               lot_area          = COALESCE(v_row.lot_area, lot_area),
               parking_spaces    = COALESCE(v_row.parking_spaces, parking_spaces),
               for_sale          = COALESCE(v_row.for_sale, for_sale),
               for_rent          = COALESCE(v_row.for_rent, for_rent),
               unit_number       = COALESCE(v_row.unit_number, unit_number),
               source_observed_at = greatest(source_observed_at, v_row.ingested_at)
         WHERE id = v_row.resolved_listing_id;

        UPDATE public.listings_normalized
           SET matched_at = now()
         WHERE id = v_row.id;

        c_updated := c_updated + 1;

      ELSIF v_row.match_status = 'matched_existing_property' THEN
        -- New listing under an existing property. INSERT scoped by
        -- (source_id, foreign_id) using the partial unique index from
        -- mig 506000013. The conflict path is "another writer (likely
        -- the direct ingest path during the dual-write window) already
        -- inserted this row" — perfectly fine, skip.
        INSERT INTO public.listings (
          property_id, title, description,
          property_category, property_type,
          sale_price, rent_price,
          bedrooms, bathrooms, floor_area, lot_area, parking_spaces,
          for_sale, for_rent,
          unit_number,
          source_id, foreign_id, source_observed_at,
          is_online
        )
        VALUES (
          v_row.resolved_property_id, v_row.title, v_row.description,
          coalesce(v_row.property_category, 'residential'),
          v_row.property_type,
          v_row.sale_price, v_row.rent_price,
          v_row.bedrooms, v_row.bathrooms, v_row.floor_area, v_row.lot_area, v_row.parking_spaces,
          coalesce(v_row.for_sale, false),
          coalesce(v_row.for_rent, false),
          v_row.unit_number,
          v_row.source_id, v_row.foreign_id, v_row.ingested_at,
          false                              -- new listings land offline; moderator publishes
        )
        ON CONFLICT (source_id, foreign_id)
          WHERE source_id IS NOT NULL AND foreign_id IS NOT NULL
          DO NOTHING
        RETURNING id INTO v_new_listing_id;

        IF v_new_listing_id IS NULL THEN
          -- Conflict path — another writer already inserted.
          UPDATE public.listings_normalized
             SET matched_at = now(),
                 match_notes = coalesce(match_notes || E'\n', '')
                               || 'apply: skipped (collision on source_id+foreign_id; another writer inserted)'
           WHERE id = v_row.id;
          c_skipped_coll := c_skipped_coll + 1;
        ELSE
          UPDATE public.listings_normalized
             SET matched_at = now(),
                 resolved_listing_id = v_new_listing_id
           WHERE id = v_row.id;
          c_inserted := c_inserted + 1;
        END IF;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      -- One bad row doesn't fail the batch. Capture SQLERRM in match_notes
      -- so the admin queue surfaces what went wrong.
      UPDATE public.listings_normalized
         SET matched_at = now(),
             match_status = 'rejected',
             match_notes = coalesce(match_notes || E'\n', '')
                           || 'apply error: ' || SQLERRM
       WHERE id = v_row.id;
      c_err := c_err + 1;
    END;
  END LOOP;

  -- Coalesced MV refresh request (mig 513000004) — does not block.
  IF c_updated > 0 OR c_inserted > 0 THEN
    PERFORM public.request_listing_details_refresh();
  END IF;

  processed         := c_processed;
  updated_existing  := c_updated;
  inserted_new      := c_inserted;
  skipped_stale     := c_skipped_stale;
  skipped_collision := c_skipped_coll;
  errors            := c_err;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION public.apply_listings_normalized_batch(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_listings_normalized_batch(int)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.apply_listings_normalized_batch(int) IS
  'B-3.1 apply worker. Drains listings_normalized → listings for matched_existing_listing + matched_existing_property rows. Staleness-guarded against fresher direct-ingest writes; ON CONFLICT DO NOTHING against the (source_id, foreign_id) partial unique index. Runs in shadow mode alongside the direct ingest path during the dual-write window.';


-- =====================================================================
-- 2. Governance
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RETURN;
  END IF;
  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('public.apply_listings_normalized_batch', 'function', 'userportal', ARRAY['userportal'],
     'B-3.1 apply worker. Drains listings_normalized → listings. Shadow-mode safe (staleness + collision guards).', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
--
-- 1) Shape — function exists, returns 6-col table.
-- SELECT proname, pg_get_function_result(oid)
--   FROM pg_proc
--  WHERE proname = 'apply_listings_normalized_batch';
--
-- 2) Drain — should be a no-op on a fresh DB (no pending normalized rows).
-- SELECT * FROM public.apply_listings_normalized_batch(200);
-- -- → all zeros
--
-- 3) Synthetic end-to-end: insert a raw row, normalize it, apply it.
--    Pick an existing source + existing listing to exercise the
--    matched_existing_listing path.
-- WITH src AS (
--   SELECT id FROM public.listing_sources LIMIT 1
-- ),
-- ref_listing AS (
--   SELECT id, foreign_id FROM public.listings
--    WHERE source_id = (SELECT id FROM src) AND foreign_id IS NOT NULL
--    LIMIT 1
-- )
-- INSERT INTO public.listings_raw (source_id, foreign_id, raw_json)
-- SELECT (SELECT id FROM src),
--        (SELECT foreign_id FROM ref_listing),
--        jsonb_build_object(
--          'title',       'B-3.1 smoke ' || gen_random_uuid()::text,
--          'description', 'apply worker smoke test',
--          'sale_price',  9999999
--        );
--
-- SELECT * FROM public.normalize_listings_raw_batch(10);
-- SELECT * FROM public.apply_listings_normalized_batch(10);
--
-- 4) Verify the target listing got the new title.
-- SELECT id, title, source_observed_at
--   FROM public.listings
--  WHERE id = (
--    SELECT resolved_listing_id FROM public.listings_normalized
--     ORDER BY ingested_at DESC LIMIT 1
--  );
--
-- 5) Pending counts (should be 0 after the apply).
-- SELECT match_status, count(*)
--   FROM public.listings_normalized
--  WHERE matched_at IS NULL
--  GROUP BY match_status;
