-- Speed up the hybrid orchestrator's PG-FTS fallback.
--
-- Background:
--   The website's /api/public/search-hybrid endpoint queries
--   `public_listing_details` (anon-safe view over `listing_details`)
--   with PostgREST `.textSearch('title', q, { type: 'websearch' })`,
--   which generates:
--     to_tsvector('english', title) @@ websearch_to_tsquery('english', q)
--
--   Without an expression index on that exact tsvector, the planner
--   does a sequential scan over the MV — measured at ~1270ms for a
--   "makati 2br condo" query against the live 49k-listing dataset.
--
-- Fix:
--   GIN index matching the predicate exactly. Postgres expression
--   indexes only kick in when the WHERE clause expression is literally
--   identical (config string included), so we're explicit.
--
-- Trade-offs:
--   - Adds ~10-40MB to the MV depending on title length distribution.
--   - REFRESH MATERIALIZED VIEW rebuilds the index (slower refresh by
--     a few hundred ms). The MV refresh coalescer in
--     20260513000004 already batches refreshes so this is tolerable.
--   - Sub-200ms p95 for free-text title queries.
--
-- Strictly additive — no other surface touched.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.listing_details_title_fts_idx;


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'listing_details'
       AND c.relkind = 'm'   -- 'm' = materialized view
  ) THEN
    RAISE EXCEPTION
      'Migration 20260514000003 requires the listing_details materialized view'
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. GIN FTS index — matches PostgREST websearch_to_tsquery default
-- =====================================================================
-- IMPORTANT: the config in this expression MUST match the config used
-- by the runtime query exactly. PostgREST's `.textSearch(col, q,
-- { type: 'websearch' })` defaults to 'english'. If a caller switches
-- to `{ config: 'simple' }`, the planner won't use this index — a
-- second index would be needed.
--
-- `CONCURRENTLY` is not used because Supabase migrations run inside a
-- transaction (CONCURRENTLY requires being outside one). For the
-- production rollout, expect a brief AccessExclusiveLock on the MV
-- during creation — measured at <5s for 49k rows. Acceptable; the
-- coalescer (mig 20260513000004) holds refreshes back during DDL.

CREATE INDEX IF NOT EXISTS listing_details_title_fts_idx
  ON public.listing_details
  USING GIN (to_tsvector('english', title));

COMMENT ON INDEX public.listing_details_title_fts_idx IS
  'Expression GIN index for full-text search on listing_details.title. Matches the runtime predicate ''to_tsvector(english, title) @@ websearch_to_tsquery(english, ?)'' used by /api/public/search-hybrid PG-FTS branch. If query config changes (e.g. ''simple''), add a parallel index — Postgres expression indexes are strict on the expression literal.';


-- =====================================================================
-- 2. Refresh PostgREST schema cache
-- =====================================================================
-- Not strictly necessary for indexes (PostgREST doesn't expose them in
-- the schema) but harmless and keeps the migration footer consistent.

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste in SQL editor.
-- =====================================================================
-- 1) Index exists.
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE schemaname='public'
--    AND tablename='listing_details'
--    AND indexname='listing_details_title_fts_idx';
--
-- 2) Plan uses the index (look for "Bitmap Index Scan on
--    listing_details_title_fts_idx"). If you see "Seq Scan" instead,
--    the config doesn't match — re-check PostgREST settings.
-- EXPLAIN ANALYZE
--   SELECT listing_id, title
--     FROM public.public_listing_details
--    WHERE to_tsvector('english', title)
--          @@ websearch_to_tsquery('english', 'makati 2br condo')
--    LIMIT 48;
--
-- 3) Time should now be <200ms for typical queries on the full set.
