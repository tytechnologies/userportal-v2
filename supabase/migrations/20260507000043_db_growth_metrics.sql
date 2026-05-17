-- DB Growth Metrics — per-table storage observability for the
-- /admin/operations dashboard.
--
-- Adds:
--   1. system_table_size_snapshots — daily per-table size capture
--   2. ops_db_growth() RPC          — latest sizes + 24h/7d deltas
--   3. cron system_table_size_snapshot_daily (03:30 UTC)
--   4. cron system_table_size_snapshot_prune  (drops > 90 days)
--
-- Why daily, not 5-min: pg_total_relation_size is cheap but we don't
-- need 5-min resolution on storage trends. Daily snapshots give the
-- operator week-over-week growth visibility without churning the
-- snapshot table.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.ops_db_growth();
--   DROP FUNCTION IF EXISTS public.capture_table_size_snapshot();
--   DROP TABLE IF EXISTS public.system_table_size_snapshots;
--   SELECT cron.unschedule('system_table_size_snapshot_daily');
--   SELECT cron.unschedule('system_table_size_snapshot_prune');


-- =====================================================================
-- 1. Snapshot table
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.system_table_size_snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  -- Day key for the unique constraint. Generated column instead of
  -- a function-based index because date_trunc('day', timestamptz) is
  -- STABLE (depends on session timezone) and Postgres rejects STABLE
  -- functions in index expressions (42P17). Casting through
  -- `AT TIME ZONE 'UTC'` pins the timezone, making the cast IMMUTABLE.
  captured_day  date GENERATED ALWAYS AS (((captured_at AT TIME ZONE 'UTC')::date)) STORED,
  schema_name   text NOT NULL,
  table_name    text NOT NULL,
  -- pg_total_relation_size: heap + indexes + TOAST. The "storage" number.
  total_bytes   bigint NOT NULL,
  -- pg_relation_size: heap only.
  table_bytes   bigint NOT NULL,
  -- pg_indexes_size: sum of all indexes on this relation.
  index_bytes   bigint NOT NULL,
  -- TOAST bytes (large/compressed values stored out-of-line).
  toast_bytes   bigint NOT NULL,
  -- pg_class.reltuples — estimate, NOT exact. Surfaced in UI as such.
  row_estimate  bigint NOT NULL,
  -- One snapshot per (table, UTC day). Re-run within the same UTC day
  -- updates the existing row via ON CONFLICT in capture_table_size_snapshot().
  UNIQUE (captured_day, schema_name, table_name)
);

CREATE INDEX IF NOT EXISTS system_table_size_snapshots_recent_idx
  ON public.system_table_size_snapshots (captured_at DESC);

ALTER TABLE public.system_table_size_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_table_size_snapshots_admin
  ON public.system_table_size_snapshots;
CREATE POLICY system_table_size_snapshots_admin
  ON public.system_table_size_snapshots
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 2. Capture function — one row per public-schema table
-- =====================================================================

CREATE OR REPLACE FUNCTION public.capture_table_size_snapshot()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted int := 0;
BEGIN
  -- Smoke-test bypass: ops/service contexts only.
  IF session_user NOT IN ('postgres', 'supabase_admin', 'service_role')
     AND NOT public.has_permission('admin.access') THEN
    RAISE EXCEPTION 'capture_table_size_snapshot: not authorized';
  END IF;

  WITH inserted AS (
    INSERT INTO public.system_table_size_snapshots
      (schema_name, table_name, total_bytes, table_bytes,
       index_bytes, toast_bytes, row_estimate)
    SELECT
      n.nspname  AS schema_name,
      c.relname  AS table_name,
      pg_total_relation_size(c.oid) AS total_bytes,
      pg_relation_size(c.oid)       AS table_bytes,
      pg_indexes_size(c.oid)        AS index_bytes,
      COALESCE(pg_total_relation_size(c.reltoastrelid), 0) AS toast_bytes,
      GREATEST(c.reltuples::bigint, 0) AS row_estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname = 'public'
      -- Skip our own snapshot tables to keep growth signal clean
      -- (a 5-min cadence cron writing to its own monitor would
      -- self-amplify the trend).
      AND c.relname NOT IN ('system_metric_snapshots', 'system_table_size_snapshots')
    ON CONFLICT (captured_day, schema_name, table_name)
    DO UPDATE SET
      total_bytes  = EXCLUDED.total_bytes,
      table_bytes  = EXCLUDED.table_bytes,
      index_bytes  = EXCLUDED.index_bytes,
      toast_bytes  = EXCLUDED.toast_bytes,
      row_estimate = EXCLUDED.row_estimate,
      captured_at  = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM inserted;

  RETURN v_inserted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.capture_table_size_snapshot() TO service_role;


-- =====================================================================
-- 3. ops_db_growth() — latest size per table + 24h / 7d deltas
-- =====================================================================
--
-- Returns one row per table with the most recent snapshot's sizes
-- alongside the byte-delta vs. the snapshot from ~24h ago and ~7d ago.
-- Deltas are NULL when no prior snapshot exists in that window.

CREATE OR REPLACE FUNCTION public.ops_db_growth()
RETURNS TABLE (
  schema_name   text,
  table_name    text,
  total_bytes   bigint,
  table_bytes   bigint,
  index_bytes   bigint,
  toast_bytes   bigint,
  row_estimate  bigint,
  delta_24h     bigint,
  delta_7d      bigint,
  captured_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (s.schema_name, s.table_name)
      s.schema_name,
      s.table_name,
      s.total_bytes,
      s.table_bytes,
      s.index_bytes,
      s.toast_bytes,
      s.row_estimate,
      s.captured_at
    FROM public.system_table_size_snapshots s
    ORDER BY s.schema_name, s.table_name, s.captured_at DESC
  ),
  prior_24h AS (
    SELECT DISTINCT ON (s.schema_name, s.table_name)
      s.schema_name,
      s.table_name,
      s.total_bytes
    FROM public.system_table_size_snapshots s
    WHERE s.captured_at <= now() - interval '20 hours'
      AND s.captured_at >= now() - interval '36 hours'
    ORDER BY s.schema_name, s.table_name, s.captured_at DESC
  ),
  prior_7d AS (
    SELECT DISTINCT ON (s.schema_name, s.table_name)
      s.schema_name,
      s.table_name,
      s.total_bytes
    FROM public.system_table_size_snapshots s
    WHERE s.captured_at <= now() - interval '6 days'
      AND s.captured_at >= now() - interval '8 days'
    ORDER BY s.schema_name, s.table_name, s.captured_at DESC
  )
  SELECT
    l.schema_name,
    l.table_name,
    l.total_bytes,
    l.table_bytes,
    l.index_bytes,
    l.toast_bytes,
    l.row_estimate,
    (l.total_bytes - p24.total_bytes) AS delta_24h,
    (l.total_bytes - p7.total_bytes)  AS delta_7d,
    l.captured_at
  FROM latest l
  LEFT JOIN prior_24h p24
    ON p24.schema_name = l.schema_name
   AND p24.table_name  = l.table_name
  LEFT JOIN prior_7d  p7
    ON p7.schema_name  = l.schema_name
   AND p7.table_name   = l.table_name
  ORDER BY l.total_bytes DESC;
$$;

REVOKE ALL ON FUNCTION public.ops_db_growth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_db_growth() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_db_growth() TO service_role;


-- =====================================================================
-- 4. Cron — daily capture + 90-day prune
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed; db_growth crons NOT scheduled.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('system_table_size_snapshot_daily')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system_table_size_snapshot_daily');
  PERFORM cron.schedule(
    'system_table_size_snapshot_daily',
    '30 3 * * *',
    $cmd$ SELECT public.capture_table_size_snapshot(); $cmd$
  );

  PERFORM cron.unschedule('system_table_size_snapshot_prune')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system_table_size_snapshot_prune');
  PERFORM cron.schedule(
    'system_table_size_snapshot_prune',
    '40 3 * * *',
    $cmd$
      DELETE FROM public.system_table_size_snapshots
       WHERE captured_at < now() - interval '90 days';
    $cmd$
  );
END $$;


-- =====================================================================
-- 5. Backfill — first capture so the page has data immediately
-- =====================================================================
--
-- Without this, the operator hits an empty Storage panel until
-- 03:30 UTC the next day. Capture once at migration apply time.

SELECT public.capture_table_size_snapshot();


-- =====================================================================
-- 6. Governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.system_table_size_snapshots', 'table', 'userportal', ARRAY['userportal'],
   'Daily per-table storage snapshots. Drives /admin/operations Storage panel.', false),
  ('public.ops_db_growth', 'function', 'userportal', ARRAY['userportal'],
   'Latest per-table sizes joined with 24h/7d byte deltas. Admin-only via has_permission.', false),
  ('public.capture_table_size_snapshot', 'function', 'userportal', ARRAY['userportal'],
   'Inserts/updates one row per public-schema table for today. Cron-driven daily.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
