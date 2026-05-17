-- Periodic safety-net refresh for public.listing_details.
--
-- Background:
--   `listing_details` is refreshed inline by every known write path:
--     - server/repositories/listings.repo.ts (6 methods: create, archive,
--       unarchive, updateRemarks, softDelete, clone)
--     - app/services/listing.services.js (2 client paths: _createListingOnly,
--       _updateListing — both go through /api/admin/refresh-listing-details)
--   Plus the manual admin endpoint as an explicit escape hatch.
--
--   That covers every write path the application owns. Two staleness vectors
--   are NOT covered:
--     1. Out-of-band writes — Supabase Studio, manual SQL, ad-hoc scripts
--        that mutate `listings` directly. Indefinite staleness until someone
--        hits the manual admin trigger.
--     2. Lookup-table mutations — when a contact's full_name/designation,
--        a city's name, or a barangay's name changes, the MV's denormalized
--        columns (contact_name, city_name, barangay_name) stay stale until
--        the next write to a listing that references that lookup row.
--
--   This migration installs a pg_cron job that calls
--   refresh_listing_details() every 5 minutes, bounding worst-case
--   staleness to 5 minutes regardless of which path performed the write.
--   Inline refreshes from app code keep most updates near-instant; this
--   is a safety net, not a replacement.
--
-- Conditional installation:
--   pg_cron is a Supabase-managed extension that must be enabled per
--   project (Database → Extensions in the dashboard, or
--   `CREATE EXTENSION pg_cron`). If it isn't enabled, this migration
--   emits a NOTICE and exits cleanly — re-run after enabling.
--
-- Idempotency:
--   The job is created with a stable name. Re-running this migration
--   un-schedules any prior job by that name before re-scheduling, so it's
--   safe to apply multiple times.
--
-- ROLLBACK:
--   DO $$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
--       PERFORM cron.unschedule('refresh_listing_details_periodic');
--     END IF;
--   END $$;
--
-- DEPENDS ON:
--   20260429000005_refresh_listing_details.sql  (creates the RPC this calls)


DO $$
DECLARE
  v_jobname constant text := 'refresh_listing_details_periodic';
  v_exists  bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE
      'pg_cron extension is not installed. Skipping periodic refresh schedule. '
      'Enable pg_cron via Supabase Dashboard (Database → Extensions) and re-run '
      'this migration to install the safety net.';
    RETURN;
  END IF;

  -- Idempotent: drop any prior job with the same name. cron.unschedule(text)
  -- raises if the job doesn't exist, so we check first.
  SELECT count(*) INTO v_exists
  FROM cron.job
  WHERE jobname = v_jobname;

  IF v_exists > 0 THEN
    PERFORM cron.unschedule(v_jobname);
  END IF;

  -- Schedule. Every 5 minutes, on the 0th, 5th, 10th… minute of every hour.
  -- The cron job runs as the cron extension's owner (typically `postgres`),
  -- which has the privileges to execute refresh_listing_details() and the
  -- underlying REFRESH MATERIALIZED VIEW.
  PERFORM cron.schedule(
    v_jobname,
    '*/5 * * * *',
    $cron$ SELECT public.refresh_listing_details(); $cron$
  );

  RAISE NOTICE
    'Scheduled %: SELECT public.refresh_listing_details(); every 5 minutes.',
    v_jobname;
END
$$;
