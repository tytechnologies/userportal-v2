-- archive_stale_source_listings — promote-before-archive update.
--
-- Mig 506000015 added the daily cron that flips is_online=false on
-- source-imported listings past their per-source TTL. With canonicals
-- now live (mig 510000001), a stale row that happens to be the pinned
-- properties.primary_listing_id would leave the property pointing at a
-- dead primary — the website would surface an offline listing as the
-- canonical representative of the property.
--
-- This migration CREATE OR REPLACEs the function with the same
-- signature (same return shape, same SECURITY DEFINER, same grants —
-- the cron schedule from mig 506000015 keeps firing unchanged). The
-- body gains one step: AFTER each source's archive sweep, re-point
-- properties.primary_listing_id on any property whose pinned primary
-- is no longer live, using the existing elect_primary_listing_id RPC.
-- If no live sibling remains the pin becomes NULL.
--
-- Why after the UPDATE and not before:
--   elect_primary_listing_id filters its candidate set on
--   is_online=true AND deleted_at IS NULL — so it must see the
--   archived row as already offline to pick a *live* sibling. Doing
--   the remap after the archive UPDATE is the cheap path.
--
-- Strictly additive at the schema level. No tables / columns / FKs /
-- grants / cron entries created or modified. Reference schema
-- untouched.
--
-- ROLLBACK:
--   Re-apply 20260506000015_archive_stale_source_listings.sql
--   section 2 (the prior function body).
--
-- DEPENDS ON:
--   20260506000015_archive_stale_source_listings.sql  (prior function body)
--   20260510000001_property_canonical_extensions.sql  (elect_primary_listing_id RPC,
--                                                      properties.primary_listing_id)


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines
                  WHERE routine_schema='public' AND routine_name='archive_stale_source_listings') THEN
    v_missing := v_missing || 'public.archive_stale_source_listings (mig 506000015)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.routines
                  WHERE routine_schema='public' AND routine_name='elect_primary_listing_id') THEN
    v_missing := v_missing || 'public.elect_primary_listing_id (mig 510000001)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='properties'
                    AND column_name='primary_listing_id') THEN
    v_missing := v_missing || 'public.properties.primary_listing_id (mig 510000001)';
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 20260510000004 missing prerequisites: %.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. Replace the function body
-- =====================================================================

CREATE OR REPLACE FUNCTION public.archive_stale_source_listings()
RETURNS TABLE (
  source_id      bigint,
  source_slug    text,
  archived_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source     RECORD;
  v_archived   int;
  v_remapped   int;
  v_remapped_total int := 0;
BEGIN
  FOR v_source IN
    SELECT id, slug, staleness_ttl_hours
    FROM   public.listing_sources
    WHERE  enabled = true
    ORDER  BY id
  LOOP
    -- Step 1: archive — unchanged from mig 506000015.
    UPDATE public.listings l
       SET is_online = false
     WHERE l.source_id          = v_source.id
       AND l.is_online           = true
       AND l.deleted_at          IS NULL
       AND l.source_observed_at  IS NOT NULL
       AND l.source_observed_at  <
             now() - (v_source.staleness_ttl_hours || ' hours')::interval;

    GET DIAGNOSTICS v_archived = ROW_COUNT;

    -- Step 2: promote-before-archive (NEW).
    --
    -- Find every property whose pinned primary_listing_id is no
    -- longer live (which now includes anything this source just
    -- archived) and re-elect via the canonical election rule. If
    -- no live sibling exists the pin becomes NULL — the property
    -- has no representative until a fresh ingest arrives.
    --
    -- Scope is global on purpose: it's idempotent (no-op for
    -- properties whose primary is still live) and the properties
    -- table is small (~tens of thousands of rows); doing it per
    -- source is correct without a performance hit. The NOT EXISTS
    -- predicate is a single index probe per property.
    WITH affected_props AS (
      SELECT p.id
        FROM public.properties p
       WHERE p.primary_listing_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.listings cur
            WHERE cur.id = p.primary_listing_id
              AND cur.is_online  = true
              AND cur.deleted_at IS NULL
         )
    )
    UPDATE public.properties p
       SET primary_listing_id = public.elect_primary_listing_id(p.id),
           updated_at         = now()
      FROM affected_props ap
     WHERE p.id = ap.id;

    GET DIAGNOSTICS v_remapped = ROW_COUNT;
    v_remapped_total := v_remapped_total + v_remapped;

    IF v_remapped > 0 THEN
      RAISE NOTICE
        'archive_stale: source % archived % rows; remapped % property primaries.',
        v_source.slug, v_archived, v_remapped;
    END IF;

    source_id      := v_source.id;
    source_slug    := v_source.slug;
    archived_count := v_archived;
    RETURN NEXT;
  END LOOP;

  -- Surface a single rollup notice so the cron log always carries
  -- the total even when individual sources had 0 remaps.
  RAISE NOTICE 'archive_stale: total property-primary remaps this run: %', v_remapped_total;

  -- Refresh the public MV so the changes are visible within seconds.
  -- Identical call to the prior body.
  PERFORM public.refresh_listing_details();
END
$$;

COMMENT ON FUNCTION public.archive_stale_source_listings() IS
  'Daily archival sweep. For each enabled listing_source, flips is_online=false on rows older than the per-source TTL. Mig 510000004 added the promote-before-archive step: after each source sweep, properties whose pinned primary_listing_id is no longer live are re-elected via elect_primary_listing_id (NULL if no live sibling). Cron called from postgres; admins can invoke for an ad-hoc sweep.';

-- Grants are unchanged from mig 506000015. CREATE OR REPLACE preserves
-- existing GRANTs.


-- =====================================================================
-- 2. Governance update
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RAISE NOTICE 'governance_schema_contracts not present; skipping update.';
    RETURN;
  END IF;

  -- Register if missing (mig 506000015 might not have).
  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('public.archive_stale_source_listings', 'function', 'userportal', ARRAY['userportal'],
     'Daily archival sweep + promote-before-archive. Flips is_online=false on rows past per-source TTL; re-elects properties.primary_listing_id when the pinned primary goes offline.', false)
  ON CONFLICT (contract_name) DO UPDATE
    SET description = EXCLUDED.description,
        updated_at  = now();
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste in the SQL editor.
-- =====================================================================
--
-- 1) Function shape unchanged.
-- SELECT proname, pg_get_function_identity_arguments(oid) AS args,
--        pg_get_function_result(oid) AS result
--   FROM pg_proc
--  WHERE proname = 'archive_stale_source_listings';
--
-- 2) Manual sweep — returns per-source archive counts. The remap
--    NOTICE lines surface in `Messages` in the Supabase SQL editor.
-- SELECT * FROM public.archive_stale_source_listings();
--
-- 3) Confirm no property is left with a pinned-but-dead primary.
--    Expect 0 rows on a healthy DB after a sweep.
-- SELECT p.id AS property_id, p.primary_listing_id, l.is_online, l.deleted_at
--   FROM public.properties p
--   JOIN public.listings   l ON l.id = p.primary_listing_id
--  WHERE l.is_online = false OR l.deleted_at IS NOT NULL;
--
-- 4) Spot-check a property where the elected primary != pin (none
--    should exist after a sweep; if they do, the elect rule disagrees
--    with the pin — admin judgement call, surfaced for review).
-- SELECT p.id AS property_id,
--        p.primary_listing_id           AS pinned_primary,
--        public.elect_primary_listing_id(p.id) AS elected_primary
--   FROM public.properties p
--  WHERE p.primary_listing_id IS NOT NULL
--    AND public.elect_primary_listing_id(p.id) IS DISTINCT FROM p.primary_listing_id
--  LIMIT 20;
