-- Search index queue + source health — B-4.
--
-- Drives the (out-of-process) external search-engine indexer. When a
-- canonical property changes, an entry is enqueued in
-- search_index_queue; a periodic worker drains it into the chosen
-- engine (Typesense per the architecture decision).
--
-- Why a queue (not direct push):
--   * Decouples writers from the engine. Engine outage / network blip
--     never affects ingest or admin flows.
--   * Coalesces bursty updates — if a partner pushes 500 listings
--     under the same property, that's at most 500 queue rows; the
--     worker debounces by canonical_id and writes once.
--   * Backfill works the same way: a one-shot script enqueues every
--     property, the worker drains. No "indexer" mode vs "live" mode.
--
-- source_health is the per-source SLO/health rollup. Updated by
-- /api/admin/listings/ingest after each run; surfaced to ops via
-- /admin/sources/health (B-4 follow-up).
--
-- Strictly additive. No tables / columns / FKs / grants on existing
-- objects are modified. Reference schema untouched.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS properties_search_index_enqueue ON public.properties;
--   DROP TRIGGER IF EXISTS listings_search_index_enqueue   ON public.listings;
--   DROP FUNCTION IF EXISTS public.fn_enqueue_search_index();
--   DROP FUNCTION IF EXISTS public.fn_enqueue_search_index_via_listing();
--   DROP TABLE    IF EXISTS public.search_index_queue;
--   DROP TABLE    IF EXISTS public.source_health;


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='properties') THEN
    v_missing := v_missing || 'public.properties (reference)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listings') THEN
    v_missing := v_missing || 'public.listings (reference)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listing_sources') THEN
    v_missing := v_missing || 'public.listing_sources (mig 506000013)';
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 20260510000006 missing prerequisites: %.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. search_index_queue
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.search_index_queue (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Canonical key: properties.id (INTEGER per reference). The engine
  -- index is keyed on this; the worker dedupes consecutive ops per
  -- property_id.
  property_id     integer NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  op              text NOT NULL CHECK (op IN ('upsert', 'delete')),
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  -- Free-form per-row diagnostics (engine response, payload size, etc.)
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS search_index_queue_pending_idx
  ON public.search_index_queue(enqueued_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS search_index_queue_property_idx
  ON public.search_index_queue(property_id);

ALTER TABLE public.search_index_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS search_index_queue_admin ON public.search_index_queue;
CREATE POLICY search_index_queue_admin ON public.search_index_queue FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

COMMENT ON TABLE public.search_index_queue IS
  'Queue of canonical (property) upserts/deletes for the external search engine. Drained by /api/internal/index-search-queue. Survives engine outages; coalesces bursty updates per property_id.';


-- =====================================================================
-- 2. source_health — per-source rollup
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.source_health (
  source_id           bigint PRIMARY KEY REFERENCES public.listing_sources(id) ON DELETE CASCADE,
  last_success_at     timestamptz,
  last_failure_at     timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0,
  rolling_success_pct numeric,
  avg_duration_ms     int,
  alert_state         text NOT NULL DEFAULT 'ok'
    CHECK (alert_state IN ('ok','warning','alert')),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.source_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_health_admin ON public.source_health;
CREATE POLICY source_health_admin ON public.source_health FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

COMMENT ON TABLE public.source_health IS
  'Per-source SLO rollup updated by the ingest endpoint. Drives the /admin/sources/health dashboard. PK matches listing_sources.id so the row count is bounded by the source registry.';


-- =====================================================================
-- 3. Enqueue triggers
-- =====================================================================
-- properties change → enqueue properties.id directly.
-- listings change → enqueue the parent property_id (canonical key).
--
-- We coalesce by NOT inserting if an unprocessed row for the same
-- (property_id, op) already exists. The worker will read whatever
-- the row state is at drain time; an extra enqueue would just retry
-- the same work.

CREATE OR REPLACE FUNCTION public.fn_enqueue_search_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op text;
  v_prop_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_op := 'delete';
    v_prop_id := OLD.id;
  ELSE
    v_op := 'upsert';
    v_prop_id := NEW.id;
  END IF;

  IF v_prop_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  INSERT INTO public.search_index_queue (property_id, op)
  SELECT v_prop_id, v_op
  WHERE NOT EXISTS (
    SELECT 1 FROM public.search_index_queue
     WHERE property_id = v_prop_id
       AND op = v_op
       AND processed_at IS NULL
  );

  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE OR REPLACE FUNCTION public.fn_enqueue_search_index_via_listing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prop_id integer;
BEGIN
  -- Re-key from listing → property. Skip if the listing has no
  -- property (shouldn't happen in this codebase — property_id is
  -- NOT NULL per reference — but defensive).
  v_prop_id := COALESCE(NEW.property_id, OLD.property_id);
  IF v_prop_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  INSERT INTO public.search_index_queue (property_id, op)
  SELECT v_prop_id, 'upsert'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.search_index_queue
     WHERE property_id = v_prop_id
       AND op = 'upsert'
       AND processed_at IS NULL
  );

  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS properties_search_index_enqueue ON public.properties;
CREATE TRIGGER properties_search_index_enqueue
  AFTER INSERT OR UPDATE OR DELETE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.fn_enqueue_search_index();

DROP TRIGGER IF EXISTS listings_search_index_enqueue ON public.listings;
CREATE TRIGGER listings_search_index_enqueue
  AFTER INSERT OR UPDATE OF
    title, description, sale_price, rent_price, is_online,
    deleted_at, property_id, bedrooms, bathrooms, floor_area
  OR DELETE
  ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.fn_enqueue_search_index_via_listing();


-- =====================================================================
-- 4. Governance
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
    ('public.search_index_queue', 'table',    'userportal', ARRAY['userportal'],
     'Queue of property-keyed upsert/delete ops for the external search engine.', false),
    ('public.source_health',      'table',    'userportal', ARRAY['userportal'],
     'Per-source SLO rollup. Drives /admin/sources/health.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
--
-- 1) Queue is enqueueing on property INSERT/UPDATE.
-- INSERT INTO public.properties (city_id, category)
-- SELECT (SELECT id FROM public.cities LIMIT 1), 'residential'
-- RETURNING id;
-- -- → expect 1 new pending row
-- SELECT count(*) FROM public.search_index_queue WHERE processed_at IS NULL;
--
-- 2) Coalescing: a second UPDATE on the same row shouldn't double-enqueue.
-- UPDATE public.properties SET updated_at = now()
--  WHERE id = (SELECT max(id) FROM public.properties);
-- SELECT property_id, count(*)
--   FROM public.search_index_queue
--  WHERE processed_at IS NULL
--  GROUP BY property_id
--  ORDER BY count(*) DESC LIMIT 5;
--
-- 3) Backfill seed: enqueue every existing property once.
-- INSERT INTO public.search_index_queue (property_id, op)
-- SELECT p.id, 'upsert'
--   FROM public.properties p
--  WHERE NOT EXISTS (
--    SELECT 1 FROM public.search_index_queue q
--     WHERE q.property_id = p.id
--       AND q.op = 'upsert'
--       AND q.processed_at IS NULL
--  );
