-- Lifecycle sweep for source-imported listings.
--
-- When a partner removes a listing from their feed, our row drifts:
-- it stays is_online = true forever, surfaces on the public site, and
-- the buyer reaches out to a property that's no longer available.
-- This migration adds a daily cron that flips is_online = false on
-- source rows whose source_observed_at is older than a per-source TTL.
--
-- Mechanism:
--   - listing_sources.staleness_ttl_hours (new, default 168 = 7 days)
--   - archive_stale_source_listings() — for each enabled source,
--     UPDATEs listings WHERE source_observed_at < now() - ttl. Calls
--     refresh_listing_details() once at the end so anon callers see
--     the change within seconds.
--   - pg_cron at 23:00 UTC daily (07:00 PHT). Spaced from digest
--     (22:00 UTC) and the 5-minute MV refresh tick.
--
-- Idempotent on re-ingest: when the partner re-sends a listing, the
-- upsert in /api/admin/listings/ingest stamps source_observed_at +
-- whatever is_online the partner's payload says. Archive doesn't
-- corrupt anything; it just hides until next sync.
--
-- ROLLBACK:
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       PERFORM cron.unschedule('archive_stale_source_listings_daily');
--     END IF;
--   END $$;
--   DROP FUNCTION IF EXISTS public.archive_stale_source_listings();
--   ALTER TABLE public.listing_sources DROP COLUMN IF EXISTS staleness_ttl_hours;
--
-- DEPENDS ON:
--   20260506000013_listing_sources.sql
--   20260429000005_refresh_listing_details.sql
--   20260506000002_listing_details_periodic_refresh.sql  (pg_cron precedent)


-- =====================================================================
-- 1. Per-source TTL column
-- =====================================================================

ALTER TABLE public.listing_sources
  ADD COLUMN IF NOT EXISTS staleness_ttl_hours integer NOT NULL DEFAULT 168
    CHECK (staleness_ttl_hours >= 1 AND staleness_ttl_hours <= 8760);

COMMENT ON COLUMN public.listing_sources.staleness_ttl_hours IS
  'Hours of inactivity before a listing from this source is auto-archived (is_online=false). Default 168 (7 days). Range 1..8760 (1 hour to 1 year).';


-- =====================================================================
-- 2. Sweep function
-- =====================================================================
--
-- Returns per-source counts for cron-log visibility. Body:
--   1. Iterate enabled sources.
--   2. UPDATE listings to is_online=false where the row is from this
--      source AND currently online AND not soft-deleted AND
--      source_observed_at older than now() - ttl.
--   3. Capture ROW_COUNT, return one row per source.
--   4. After the loop, call refresh_listing_details() so the public
--      MV reflects the change within seconds.
--
-- SECURITY DEFINER so cron (no auth context) can execute. The body
-- has no user input — it's a pure data sweep keyed off
-- listing_sources rows.

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
  v_source RECORD;
  v_count  int;
BEGIN
  FOR v_source IN
    SELECT id, slug, staleness_ttl_hours
    FROM   public.listing_sources
    WHERE  enabled = true
    ORDER  BY id
  LOOP
    UPDATE public.listings l
       SET is_online = false
     WHERE l.source_id           = v_source.id
       AND l.is_online           = true
       AND l.deleted_at          IS NULL
       AND l.source_observed_at  IS NOT NULL
       AND l.source_observed_at  <
             now() - (v_source.staleness_ttl_hours || ' hours')::interval;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    source_id      := v_source.id;
    source_slug    := v_source.slug;
    archived_count := v_count;
    RETURN NEXT;
  END LOOP;

  -- Refresh the public MV so anon callers stop seeing archived rows
  -- within seconds rather than waiting for the 5-minute periodic
  -- refresh tick. Function from 20260429000005.
  PERFORM public.refresh_listing_details();
END
$$;

COMMENT ON FUNCTION public.archive_stale_source_listings() IS
  'Sweep that flips is_online=false on source-imported listings whose source_observed_at is older than the per-source TTL. Returns per-source archive counts. Called by pg_cron daily at 23:00 UTC; can also be invoked manually by an admin for an ad-hoc sweep.';

REVOKE ALL ON FUNCTION public.archive_stale_source_listings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_stale_source_listings()
  TO authenticated, service_role;


-- =====================================================================
-- 3. pg_cron schedule
-- =====================================================================
--
-- Conditional install — same pattern as the listing_details refresh
-- and digest cron. Soft-fails NOTICE if pg_cron isn't enabled.
-- Idempotent: drops any prior job by name before re-scheduling.

DO $$
DECLARE
  v_jobname constant text := 'archive_stale_source_listings_daily';
  v_exists  bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE
      'pg_cron not enabled; skipping schedule for %. Enable pg_cron and re-run this migration.',
      v_jobname;
    RETURN;
  END IF;

  SELECT count(*) INTO v_exists FROM cron.job WHERE jobname = v_jobname;
  IF v_exists > 0 THEN
    PERFORM cron.unschedule(v_jobname);
  END IF;

  -- 23:00 UTC = 07:00 PHT. Hour-staggered from the digest worker
  -- (22:00 UTC) so they don't compete for connections / refresh
  -- locks during the same minute.
  PERFORM cron.schedule(
    v_jobname,
    '0 23 * * *',
    $cron$ SELECT count(*) FROM public.archive_stale_source_listings(); $cron$
  );

  RAISE NOTICE
    'Scheduled %: SELECT count(*) FROM archive_stale_source_listings(); daily at 23:00 UTC.',
    v_jobname;
END
$$;
