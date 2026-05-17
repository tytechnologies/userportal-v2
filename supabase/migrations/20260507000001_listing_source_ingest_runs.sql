-- Per-call ingestion run history.
--
-- /api/admin/listings/ingest already returns { processed, inserted,
-- updated, errors[] } per call. This table persists those summaries
-- so admins can see trend + error rate without grep-ing logs.
--
-- One row per ingest call (not per listing). Even an hourly-syncing
-- partner produces ~8,760 rows/year — negligible.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.listing_source_ingest_runs;
--
-- DEPENDS ON:
--   20260506000013_listing_sources.sql

CREATE TABLE IF NOT EXISTS public.listing_source_ingest_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       bigint NOT NULL
                  REFERENCES public.listing_sources(id) ON DELETE CASCADE,

  -- Outcome counts mirror the endpoint's response shape exactly so the
  -- run record matches what the caller saw.
  processed       integer NOT NULL DEFAULT 0,
  inserted        integer NOT NULL DEFAULT 0,
  updated         integer NOT NULL DEFAULT 0,
  errors_count    integer NOT NULL DEFAULT 0,

  -- Per-row error details. JSON array of { foreign_id, reason } —
  -- exact same shape the endpoint returns. No PII (just foreign_ids
  -- + Postgres error messages).
  errors          jsonb,

  -- Who fired this run. 'admin' = manual JWT trigger, 'source' =
  -- partner secret bearer. Mirrors the endpoint's triggered_by field.
  triggered_by    text NOT NULL DEFAULT 'source'
                  CHECK (triggered_by IN ('admin', 'source')),

  duration_ms     integer,

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "give me the last 10 runs for source N."
CREATE INDEX IF NOT EXISTS listing_source_ingest_runs_source_recent_idx
  ON public.listing_source_ingest_runs(source_id, created_at DESC);

ALTER TABLE public.listing_source_ingest_runs ENABLE ROW LEVEL SECURITY;

-- Read: same gate as listing_sources after the secret-hardening migration
-- (sources.manage). Writes: service-role only (the ingest endpoint).
DROP POLICY IF EXISTS listing_source_ingest_runs_select_admin
  ON public.listing_source_ingest_runs;
CREATE POLICY listing_source_ingest_runs_select_admin
  ON public.listing_source_ingest_runs FOR SELECT
  TO authenticated
  USING (public.has_permission('sources.manage'));

COMMENT ON TABLE public.listing_source_ingest_runs IS
  'One row per /api/admin/listings/ingest call. Persists processed / inserted / updated / errors counts so admins see ingestion trend + error rate without log scraping. RLS: admin read, service-role write.';

NOTIFY pgrst, 'reload schema';
