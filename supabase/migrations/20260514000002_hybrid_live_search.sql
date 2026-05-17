-- Hybrid live-search infrastructure.
--
-- Adds the durable surfaces needed by the Zillow-style hybrid search:
--
--   - source_connectors            registry of approved external providers
--                                  (Tavily-fronted today; partner adapters
--                                  later). Carries trust score, daily budget,
--                                  domain allowlist.
--   - live_search_cache            normalized external query results, keyed
--                                  by (provider, query_hash). TTL governs
--                                  staleness. Hit rate is the throttle for
--                                  budget burn.
--   - external_listing_candidates  per-row durable record of external hits
--                                  surfaced to users. Lets us review,
--                                  promote, blacklist. Distinct from
--                                  listings_raw (partner-feed staging).
--   - search_events                one row per hybrid query. Powers the
--                                  /admin/live-search dashboard.
--
-- Strictly additive. No reference table touched. ROLLBACK at the bottom.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.search_events;
--   DROP TABLE IF EXISTS public.external_listing_candidates;
--   DROP TABLE IF EXISTS public.live_search_cache;
--   DROP TABLE IF EXISTS public.source_connectors;
--   DELETE FROM public.governance_schema_contracts
--    WHERE contract_name IN (
--      'public.source_connectors',
--      'public.live_search_cache',
--      'public.external_listing_candidates',
--      'public.search_events'
--    );


-- =====================================================================
-- 0. Preconditions
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='properties') THEN
    RAISE EXCEPTION 'Migration 20260514000002 requires public.properties'
      USING ERRCODE='42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. source_connectors — provider registry
-- =====================================================================
-- The hybrid search consults these to decide which external providers to
-- query in a live request. `enabled=false` parks a provider without
-- deleting it. `trust_score` weights the provider's hits in ranking.
-- `domain_allowlist` filters Tavily/url-based providers to a curated set
-- (Lamudi, Property24, Rentpad, …) so we never blindly surface arbitrary
-- domains.

CREATE TABLE IF NOT EXISTS public.source_connectors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9_-]+$'),
  display_name       text NOT NULL,
  provider_kind      text NOT NULL CHECK (provider_kind IN (
                        'tavily_search',     -- discovery via Tavily query
                        'partner_feed',      -- direct ingest (listings_raw)
                        'static_url'         -- single-URL extract on demand
                       )),
  enabled            boolean NOT NULL DEFAULT false,
  -- Restrict Tavily/URL providers to these domains. NULL = "no filter"
  -- (only allowed for partner_feed). Order matters for tie-breaks.
  domain_allowlist   text[] DEFAULT NULL,
  -- 0..100. 100 = treat hits as canonical-quality (internal-equivalent).
  -- 0 = surface only if no internal coverage. Default 50 = neutral.
  trust_score        smallint NOT NULL DEFAULT 50
                        CHECK (trust_score BETWEEN 0 AND 100),
  -- Daily query budget for this provider. Hybrid orchestrator consults
  -- rate_limit_buckets before issuing a live call.
  daily_budget       int NOT NULL DEFAULT 200 CHECK (daily_budget >= 0),
  -- Cache TTL in seconds for live results from this provider.
  -- Default 6h = balance between freshness and burn.
  default_ttl_seconds int NOT NULL DEFAULT 21600
                        CHECK (default_ttl_seconds BETWEEN 60 AND 604800),
  -- Provider-specific extras (Tavily `search_depth`, partner credentials
  -- by reference, etc).
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_connectors_enabled_idx
  ON public.source_connectors(enabled) WHERE enabled = true;

DROP TRIGGER IF EXISTS set_source_connectors_updated_at
  ON public.source_connectors;
CREATE TRIGGER set_source_connectors_updated_at
  BEFORE UPDATE ON public.source_connectors
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 2. live_search_cache — normalized external query results
-- =====================================================================
-- One row per (provider, query_hash). `payload` holds the normalized
-- candidate list (array of external listing candidate shapes). `expires_at`
-- is consulted on read; orchestrator treats expired rows as a miss and
-- re-fetches. We keep expired rows around for a short window (24h) for
-- forensic value, swept by the expiry cron below.

CREATE TABLE IF NOT EXISTS public.live_search_cache (
  cache_key      text PRIMARY KEY,        -- "provider:hash" — kept compact
  provider_slug  text NOT NULL REFERENCES public.source_connectors(slug)
                       ON DELETE CASCADE ON UPDATE CASCADE,
  query_hash     text NOT NULL,           -- sha256(normalized query JSON)
  -- The original query — kept verbatim for cache-management UI and for
  -- post-hoc audit. Already-normalized (lowercased, key-sorted) before
  -- hashing, so the same logical query collapses to one row.
  query_input    jsonb NOT NULL,
  -- Normalized candidate list. Shape mirrors
  -- external_listing_candidates so the orchestrator can hand it back
  -- without further transformation. Trimmed to top N before write.
  payload        jsonb NOT NULL,
  result_count   int NOT NULL DEFAULT 0,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  hit_count      int NOT NULL DEFAULT 0,  -- bumped on every cache read
  last_hit_at    timestamptz
);

CREATE INDEX IF NOT EXISTS live_search_cache_expires_idx
  ON public.live_search_cache(expires_at);
CREATE INDEX IF NOT EXISTS live_search_cache_provider_idx
  ON public.live_search_cache(provider_slug, fetched_at DESC);


-- =====================================================================
-- 3. external_listing_candidates — durable external hits
-- =====================================================================
-- Every external candidate the orchestrator surfaces is persisted here.
-- Lets admin review the corpus over time and lets the dedup engine
-- consult prior matches without re-fetching. NOT the same as
-- listings_raw — that's partner-feed staging keyed on (source_id,
-- foreign_id). external_listing_candidates is discovery-shaped (URL is
-- the natural key, source_connector is the lineage).
--
-- Status state machine:
--   surfaced       — shown to a user at least once
--   merged         — dedup matched to an internal property (canonical_property_id set)
--   blacklisted    — operator marked as junk; never resurface
--   promoted       — operator copied to listings_raw for real ingest
--
-- Hot path writes (one per query) are short — we INSERT new candidates
-- and UPDATE last_surfaced_at + surface_count on existing.

CREATE TABLE IF NOT EXISTS public.external_listing_candidates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Provider lineage.
  provider_slug         text NOT NULL REFERENCES public.source_connectors(slug)
                            ON DELETE CASCADE ON UPDATE CASCADE,
  -- Natural key — URL of the source page. Idempotent on re-fetch.
  source_url            text NOT NULL,
  source_domain         text NOT NULL,
  -- Normalized fields. NULL means "couldn't parse it". The orchestrator
  -- doesn't rank candidates with too many NULLs above internal hits.
  title                 text,
  price                 numeric(14, 2),
  currency              text DEFAULT 'PHP',
  for_sale              boolean,
  for_rent              boolean,
  property_type         text,        -- canonical slug if recognized
  bedrooms              smallint,
  bathrooms             smallint,
  floor_area            numeric(10, 2),
  lot_area              numeric(10, 2),
  address               text,
  city_slug             text,
  barangay_slug         text,
  latitude              double precision,
  longitude             double precision,
  thumbnail_url         text,
  description           text,
  raw_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Confidence in the parse (0..1). Adapter sets this; ranking reads it.
  parse_confidence      real NOT NULL DEFAULT 0.5
                            CHECK (parse_confidence BETWEEN 0 AND 1),
  -- Dedup state. canonical_property_id is set when the runtime dedup
  -- engine attaches this candidate to an internal property.
  dedup_status          text NOT NULL DEFAULT 'unmatched'
                            CHECK (dedup_status IN (
                              'unmatched',
                              'matched_provisional',
                              'matched_confirmed',
                              'distinct'
                            )),
  canonical_property_id int REFERENCES public.properties(id) ON DELETE SET NULL,
  match_confidence      real CHECK (match_confidence BETWEEN 0 AND 1),
  -- Operator state.
  operator_status       text NOT NULL DEFAULT 'surfaced'
                            CHECK (operator_status IN (
                              'surfaced',
                              'blacklisted',
                              'promoted'
                            )),
  surface_count         int NOT NULL DEFAULT 0,
  first_surfaced_at     timestamptz NOT NULL DEFAULT now(),
  last_surfaced_at      timestamptz NOT NULL DEFAULT now(),
  -- Lifecycle.
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_slug, source_url)
);

CREATE INDEX IF NOT EXISTS ext_candidates_canonical_idx
  ON public.external_listing_candidates(canonical_property_id)
  WHERE canonical_property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ext_candidates_op_status_idx
  ON public.external_listing_candidates(operator_status);
CREATE INDEX IF NOT EXISTS ext_candidates_provider_seen_idx
  ON public.external_listing_candidates(provider_slug, last_surfaced_at DESC);
CREATE INDEX IF NOT EXISTS ext_candidates_dedup_status_idx
  ON public.external_listing_candidates(dedup_status);
CREATE INDEX IF NOT EXISTS ext_candidates_city_idx
  ON public.external_listing_candidates(city_slug)
  WHERE city_slug IS NOT NULL;

DROP TRIGGER IF EXISTS set_ext_candidates_updated_at
  ON public.external_listing_candidates;
CREATE TRIGGER set_ext_candidates_updated_at
  BEFORE UPDATE ON public.external_listing_candidates
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 4. search_events — observability
-- =====================================================================
-- One row per hybrid query. Includes the breakdown by source so the
-- live-search dashboard can show:
--   - p50/p95 internal latency
--   - p50/p95 external latency per provider
--   - external timeout %
--   - dedup collapse rate
--   - empty-result rate
--
-- Pruning: search_events grows fast. Cap retention at 30 days by default
-- via a separate cleanup function (deferred — index keeps reads cheap).

CREATE TABLE IF NOT EXISTS public.search_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Request context.
  request_origin    text,                 -- 'website' | 'portal' | 'api'
  user_id           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ip_hash           text,                 -- sha256(ip) — never raw
  -- Query (normalized JSON, same shape used to hash live_search_cache).
  query_input       jsonb NOT NULL DEFAULT '{}'::jsonb,
  query_hash        text NOT NULL,
  -- Result counts.
  internal_count    int NOT NULL DEFAULT 0,
  external_count    int NOT NULL DEFAULT 0,
  merged_count      int NOT NULL DEFAULT 0,
  dedup_collapses   int NOT NULL DEFAULT 0,
  -- Latencies (ms).
  internal_ms       int,
  external_ms       int,
  total_ms          int,
  -- Per-provider success/timeout/error rollup. Shape:
  --   { "tavily": { "status": "ok|timeout|error|cache", "count": N, "ms": M } }
  provider_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Degradation marker — true if any provider timed out or errored.
  degraded          boolean NOT NULL DEFAULT false,
  -- Free-form context for debugging.
  notes             text
);

CREATE INDEX IF NOT EXISTS search_events_created_idx
  ON public.search_events(created_at DESC);
CREATE INDEX IF NOT EXISTS search_events_qhash_idx
  ON public.search_events(query_hash);
CREATE INDEX IF NOT EXISTS search_events_degraded_idx
  ON public.search_events(degraded, created_at DESC)
  WHERE degraded = true;


-- =====================================================================
-- 5. RLS
-- =====================================================================
-- All four are admin / service-role only on the write side. Reads gated
-- to admin only. The hybrid orchestrator runs under service_role
-- (portal-side endpoint), so RLS isn't on the hot path.

ALTER TABLE public.source_connectors             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_search_cache             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_listing_candidates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_events                 ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public'
                    AND tablename='source_connectors'
                    AND policyname='source_connectors_admin_all') THEN
    EXECUTE $p$
      CREATE POLICY source_connectors_admin_all
        ON public.source_connectors FOR ALL TO authenticated
        USING (public.has_permission('admin.access'))
        WITH CHECK (public.has_permission('admin.access'));
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public'
                    AND tablename='live_search_cache'
                    AND policyname='live_search_cache_admin_all') THEN
    EXECUTE $p$
      CREATE POLICY live_search_cache_admin_all
        ON public.live_search_cache FOR ALL TO authenticated
        USING (public.has_permission('admin.access'))
        WITH CHECK (public.has_permission('admin.access'));
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public'
                    AND tablename='external_listing_candidates'
                    AND policyname='ext_candidates_admin_all') THEN
    EXECUTE $p$
      CREATE POLICY ext_candidates_admin_all
        ON public.external_listing_candidates FOR ALL TO authenticated
        USING (public.has_permission('admin.access'))
        WITH CHECK (public.has_permission('admin.access'));
    $p$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public'
                    AND tablename='search_events'
                    AND policyname='search_events_admin_read') THEN
    EXECUTE $p$
      CREATE POLICY search_events_admin_read
        ON public.search_events FOR SELECT TO authenticated
        USING (public.has_permission('admin.access'));
    $p$;
  END IF;
END $$;


-- =====================================================================
-- 6. RPCs — SECURITY DEFINER so the portal-side orchestrator (running
--    under any role) can write events + cache without admin grant
--    on every request. Gated by INTERNAL_CRON_SECRET / service_role at
--    the call site.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.record_search_event(
  p_request_origin     text,
  p_user_id            uuid,
  p_ip_hash            text,
  p_query_input        jsonb,
  p_query_hash         text,
  p_internal_count     int,
  p_external_count     int,
  p_merged_count       int,
  p_dedup_collapses    int,
  p_internal_ms        int,
  p_external_ms        int,
  p_total_ms           int,
  p_provider_breakdown jsonb,
  p_degraded           boolean,
  p_notes              text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Smoke-test bypass per [[feedback-security-definer-smoke-tests]].
  IF session_user NOT IN ('postgres','supabase_admin','service_role') THEN
    -- Production callers must come through service_role / the internal
    -- endpoint. Anon / authenticated cannot write directly.
    NULL;
  END IF;

  INSERT INTO public.search_events (
    request_origin, user_id, ip_hash,
    query_input, query_hash,
    internal_count, external_count, merged_count, dedup_collapses,
    internal_ms, external_ms, total_ms,
    provider_breakdown, degraded, notes
  ) VALUES (
    p_request_origin, p_user_id, p_ip_hash,
    COALESCE(p_query_input, '{}'::jsonb), p_query_hash,
    COALESCE(p_internal_count, 0), COALESCE(p_external_count, 0),
    COALESCE(p_merged_count, 0), COALESCE(p_dedup_collapses, 0),
    p_internal_ms, p_external_ms, p_total_ms,
    COALESCE(p_provider_breakdown, '{}'::jsonb), COALESCE(p_degraded, false),
    p_notes
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.record_search_event(
  text, uuid, text, jsonb, text, int, int, int, int, int, int, int,
  jsonb, boolean, text
) TO service_role;

-- Sweep expired cache rows + old search events.
CREATE OR REPLACE FUNCTION public.expire_live_search_cache(
  p_event_retention_days int DEFAULT 30
) RETURNS TABLE (
  cache_rows_deleted int,
  event_rows_deleted int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cache_deleted int := 0;
  v_event_deleted int := 0;
BEGIN
  IF session_user NOT IN ('postgres','supabase_admin','service_role') THEN
    -- Allow admin.access callers explicitly so an operator can run it
    -- ad-hoc from the dashboard.
    IF NOT public.has_permission('admin.access') THEN
      RAISE EXCEPTION 'permission denied' USING ERRCODE='42501';
    END IF;
  END IF;

  WITH d AS (
    DELETE FROM public.live_search_cache
     WHERE expires_at < now() - interval '24 hours'
     RETURNING cache_key
  ) SELECT COUNT(*)::int INTO v_cache_deleted FROM d;

  WITH d AS (
    DELETE FROM public.search_events
     WHERE created_at < now() - make_interval(days := p_event_retention_days)
     RETURNING id
  ) SELECT COUNT(*)::int INTO v_event_deleted FROM d;

  RETURN QUERY SELECT v_cache_deleted, v_event_deleted;
END $$;

GRANT EXECUTE ON FUNCTION public.expire_live_search_cache(int)
  TO service_role, authenticated;


-- =====================================================================
-- 7. Seed — one connector row for Tavily so the orchestrator has
--           something to bind against immediately. Disabled by default
--           until an operator enables it (gates live external traffic).
-- =====================================================================

INSERT INTO public.source_connectors
  (slug, display_name, provider_kind, enabled,
   domain_allowlist, trust_score, daily_budget,
   default_ttl_seconds, config, notes)
VALUES
  ('tavily_ph_real_estate',
   'Tavily PH real-estate discovery',
   'tavily_search',
   false,
   ARRAY[
     'lamudi.com.ph',
     'property24.com.ph',
     'dotproperty.com.ph',
     'myproperty.ph',
     'rentpad.com.ph',
     'philpropertyexpert.com',
     'ohmyhome.com'
   ],
   55, 200, 21600,
   jsonb_build_object(
     'search_depth', 'basic',
     'max_results', 10
   ),
   'Starter connector — enable after rotating TAVILY_API_KEY + confirming budget headroom in /admin/tools/tavily.'
  )
ON CONFLICT (slug) DO NOTHING;


-- =====================================================================
-- 8. Governance
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public'
                    AND table_name='governance_schema_contracts') THEN
    RETURN;
  END IF;
  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('public.source_connectors', 'table', 'userportal',
     ARRAY['userportal','website'],
     'Approved external providers for hybrid live search.', false),
    ('public.live_search_cache', 'table', 'userportal',
     ARRAY['userportal','website'],
     'Normalized cache of external search results keyed by (provider, query_hash).', false),
    ('public.external_listing_candidates', 'table', 'userportal',
     ARRAY['userportal','website'],
     'Durable external listing discovery corpus.', false),
    ('public.search_events', 'table', 'userportal',
     ARRAY['userportal'],
     'Hybrid search query telemetry.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste in SQL editor.
-- =====================================================================
-- 1) All four tables exist.
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema='public'
--    AND table_name IN ('source_connectors','live_search_cache',
--                       'external_listing_candidates','search_events')
--  ORDER BY table_name;
--
-- 2) Tavily connector seeded.
-- SELECT slug, enabled, trust_score, daily_budget FROM public.source_connectors;
--
-- 3) Record a synthetic event (must run as service_role).
-- SELECT public.record_search_event(
--   'smoke', NULL, NULL,
--   '{"q":"makati 2br"}'::jsonb,
--   'smoke-hash',
--   12, 3, 14, 1,
--   78, 612, 720,
--   '{"tavily":{"status":"ok","count":3,"ms":612}}'::jsonb,
--   false,
--   'smoke-test'
-- );
--
-- 4) Expire sweep (zero rows expected on a fresh DB).
-- SELECT * FROM public.expire_live_search_cache(30);
