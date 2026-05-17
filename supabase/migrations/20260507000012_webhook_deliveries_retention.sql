-- Retention pruning for webhook_deliveries.
--
-- The 20260507000002 migration table comment promised "Future cleanup
-- cron prunes rows > 30d." This is that cron.
--
-- WHY 30 DAYS:
-- The "View deliveries" admin UI shows the most recent 20 attempts per
-- subscription. Operators debugging a partner-side bug realistically
-- want a few weeks of history, not months. Beyond ~30 days the data is
-- noise — partners that were healthy then are healthy now, and stale
-- failures from a long-ago partner outage just clutter the panel.
--
-- The retry queue table (webhook_retry_queue) has its own self-cleaning
-- semantic — rows leave on success / exhaustion — so it doesn't need
-- a separate prune.
--
-- WHY DELETE NOT SOFT-DELETE:
-- This table is purely an audit log of transient HTTP attempts. There
-- is no foreign key pointing INTO it, no compliance requirement to
-- retain (the row contents are signed-event redeliveries, not user
-- data), and no analytical workload querying old rows. Hard delete is
-- the right operation; nothing else cares.
--
-- ROLLBACK:
--   SELECT cron.unschedule('webhook_deliveries_prune_daily');
--
-- DEPENDS ON: 20260507000002 (webhook_deliveries table)


DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed; webhook_deliveries retention cron NOT scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('webhook_deliveries_prune_daily')
    WHERE EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'webhook_deliveries_prune_daily'
    );

  -- 03:30 UTC daily — staggered from the saved-search digest (22:00),
  -- stale-source-archive (23:00), and rate-limit-buckets cleanup so
  -- they don't all land on the same minute.
  PERFORM cron.schedule(
    'webhook_deliveries_prune_daily',
    '30 3 * * *',
    $cmd$
      DELETE FROM public.webhook_deliveries
       WHERE attempted_at < now() - interval '30 days';
    $cmd$
  );
END $$;


COMMENT ON TABLE public.webhook_deliveries IS
  'Append-only log of every webhook dispatch + retry. Captures status, response excerpt (first 1KB), error message, duration. Pruned daily at 03:30 UTC: rows older than 30 days are deleted (cron job webhook_deliveries_prune_daily, migration 20260507000012).';


NOTIFY pgrst, 'reload schema';
