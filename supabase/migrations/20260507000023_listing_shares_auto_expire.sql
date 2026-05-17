-- Auto-expire stale listing_shares.
--
-- WHY:
-- listing_shares.expires_at is already honored by RLS:
--   listings_select_via_share's predicate has
--     (s.expires_at IS NULL OR s.expires_at > now())
-- so an expired share is functionally inert from a security
-- perspective — the recipient can't read or edit the parent listing
-- once the timestamp passes.
--
-- The status column doesn't auto-flip though, so:
--   - The shares panel shows "accepted" forever even after expiry
--   - Audit/reporting can't distinguish "still active" from
--     "expired but the row stuck around"
--   - Re-shares with expires_at update the existing row, which
--     conflates "this was once expired" with "this is brand new"
--
-- This migration adds a daily cron that flips status='accepted'
-- shares whose expires_at has passed to status='revoked'. UI shows
-- them as revoked from then on; re-shares still upsert correctly
-- (the UNIQUE constraint is on (listing_id, recipient), not status).
--
-- Cadence: 04:45 UTC daily. Staggered from existing daily crons
-- (22:00 saved-search digest, 23:00 stale-source archive,
-- 03:30 deliveries prune, 04:15 ops snapshots prune).
--
-- ROLLBACK:
--   SELECT cron.unschedule('listing_shares_expire_daily');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed; listing_shares auto-expire NOT scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('listing_shares_expire_daily')
    WHERE EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'listing_shares_expire_daily'
    );

  PERFORM cron.schedule(
    'listing_shares_expire_daily',
    '45 4 * * *',
    $cmd$
      UPDATE public.listing_shares
         SET status = 'revoked',
             updated_at = now()
       WHERE status = 'accepted'
         AND expires_at IS NOT NULL
         AND expires_at < now();
    $cmd$
  );
END $$;


COMMENT ON COLUMN public.listing_shares.status IS
  'accepted = active; pending = awaiting recipient accept; revoked = explicitly killed OR auto-expired by listing_shares_expire_daily cron (mig 20260507000023). RLS already gates expired shares regardless of status — this cron is for visibility/audit consistency.';


NOTIFY pgrst, 'reload schema';
