-- Listings search indexes — composite B-tree (filter hot path) +
-- tsvector + GIN (keyword search).
--
-- Pure performance migration. No table data is modified except for
-- the new generated column being backfilled (Postgres rewrites the
-- table once on ADD COLUMN ... STORED). All existing readers and
-- writers continue to work with no code changes — the planner just
-- gets new options to pick from.
--
-- =====================================================================
-- WHY PARTIAL INDEXES ON `is_online AND deleted_at IS NULL`
-- =====================================================================
-- Every public-marketplace query the website issues filters on those
-- two predicates (RLS already enforces the same shape via
-- `listings_select_public`). A partial index that bakes them in is:
--   1. Smaller — drafts / archived / soft-deleted rows aren't in it.
--   2. Faster — cold pages are fewer; planner cost is lower.
--   3. Self-documenting — the index name + WHERE clause encode the
--      contract.
--
-- =====================================================================
-- WHY tsvector GENERATED ALWAYS AS (...) STORED
-- =====================================================================
-- Free-text search needs an index Postgres can use without recomputing
-- the vector at query time. Two options:
--   a) GIN on `to_tsvector(...)` expression  → planner uses the index,
--      but the WHERE clause still recomputes the vector for matching.
--   b) Generated column + GIN on the column  → vector computed once
--      on write, read queries hit storage directly. Slightly more
--      disk; meaningfully faster reads.
-- We pick (b). At marketplace scale the read-path latency win is
-- worth the ~10-20% storage overhead.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.listings_search_tsv_gin_idx;
--   ALTER TABLE public.listings DROP COLUMN IF EXISTS search_tsv;
--   DROP INDEX IF EXISTS public.listings_public_sale_browse_idx;
--   DROP INDEX IF EXISTS public.listings_public_rent_browse_idx;
--   DROP INDEX IF EXISTS public.listings_public_recency_idx;
--   ANALYZE public.listings;
--
-- DEPENDS ON:
--   20260501000007_public_anon_listings_read.sql  (the RLS predicate
--                                                   we mirror in WHERE)


-- =====================================================================
-- 1. tsvector for keyword search
-- =====================================================================
--
-- Title weighted 'A', description 'B' — a "Makati Penthouse" listing
-- outranks a description that mentions Makati in passing. The
-- 'english' text-search config is the default and works well for
-- mixed-language Philippine real-estate listings (the dominant
-- vocabulary in titles is English: condo, penthouse, studio, etc.).
--
-- coalesce(...,'') guards against NULL columns so the expression is
-- total — INSERT/UPDATE never fail because of this column.
--
-- ALTER TABLE ... ADD COLUMN ... STORED rewrites the table once. At
-- the current row count this is sub-second; emit a NOTICE so timing
-- is visible in the migration log.

DO $$
DECLARE
  v_t0 timestamptz := clock_timestamp();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'listings'
      AND column_name = 'search_tsv'
  ) THEN
    ALTER TABLE public.listings
      ADD COLUMN search_tsv tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')),       'A')
        || setweight(to_tsvector('english', coalesce(description, '')), 'B')
      ) STORED;

    RAISE NOTICE
      'Added listings.search_tsv (rewrote table; took %).',
      clock_timestamp() - v_t0;
  ELSE
    RAISE NOTICE 'listings.search_tsv already present; skipping ADD COLUMN.';
  END IF;
END
$$;

COMMENT ON COLUMN public.listings.search_tsv IS
  'Generated tsvector for keyword search. Title weighted A, description weighted B. Indexed by listings_search_tsv_gin_idx (partial on is_online + non-deleted). Recomputed automatically on every UPDATE.';


-- =====================================================================
-- 2. GIN on search_tsv (partial — public-readable rows only)
-- =====================================================================
-- Future keyword-search endpoint queries:
--   SELECT … FROM public.listings
--   WHERE is_online = true AND deleted_at IS NULL
--     AND search_tsv @@ websearch_to_tsquery('english', $1)
--   ORDER BY ts_rank(search_tsv, websearch_to_tsquery('english', $1)) DESC
--   LIMIT N;
--
-- Partial keeps the index small — drafts / archived rows never need
-- to be reachable on the public path.

CREATE INDEX IF NOT EXISTS listings_search_tsv_gin_idx
  ON public.listings USING gin (search_tsv)
  WHERE is_online = true AND deleted_at IS NULL;


-- =====================================================================
-- 3. Composite partial B-tree: SALE browse path
-- =====================================================================
-- Covers:
--   WHERE is_online AND NOT deleted_at AND for_sale = true
--     [AND property_category = ?]
--     [AND sale_price BETWEEN ?,?]
--     [AND bedrooms BETWEEN ?,?]
--   ORDER BY updated_at DESC
-- Leftmost columns are the most-selective equality / boolean filters;
-- range columns (sale_price, bedrooms) trail; the ORDER BY column
-- sorted DESC at the end so the planner can use the index for sort.

CREATE INDEX IF NOT EXISTS listings_public_sale_browse_idx
  ON public.listings (
    property_category,
    for_sale,
    sale_price,
    bedrooms,
    updated_at DESC
  )
  WHERE is_online = true
    AND deleted_at IS NULL
    AND for_sale = true;


-- =====================================================================
-- 4. Composite partial B-tree: RENT browse path
-- =====================================================================
-- Mirrors the sale path with rent_price.

CREATE INDEX IF NOT EXISTS listings_public_rent_browse_idx
  ON public.listings (
    property_category,
    for_rent,
    rent_price,
    bedrooms,
    updated_at DESC
  )
  WHERE is_online = true
    AND deleted_at IS NULL
    AND for_rent = true;


-- =====================================================================
-- 5. Recency / featured fallback index
-- =====================================================================
-- For "what's new" queries that don't filter by sale vs rent or by
-- price (e.g. the homepage Featured carousel, the map view's
-- unfiltered ListingsStore.fetchListings(), saved-search digest's
-- "since last digest" cutoff). Covers:
--   ORDER BY updated_at DESC
-- on live rows, with optional category filter.

CREATE INDEX IF NOT EXISTS listings_public_recency_idx
  ON public.listings (
    property_category,
    updated_at DESC
  )
  WHERE is_online = true
    AND deleted_at IS NULL;


-- =====================================================================
-- 6. Analyze so the planner sees the new statistics
-- =====================================================================
-- Without ANALYZE, the planner uses old stats and may not pick the
-- new indexes immediately. ANALYZE is fast (samples, doesn't rewrite)
-- and idempotent.

ANALYZE public.listings;
