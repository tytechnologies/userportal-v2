-- Two follow-ups from the website agent's audit:
--
-- (1) Curation-tail cleanup: rows whose `name` starts with a non-
--     alphanumeric character ("! Bedroom One Maridien", "(Former Danji
--     Korean Reasturant)") slipped through the May-1 heuristic blocklist
--     because they didn't match any of the explicit "FOR SALE" / bedroom
--     prefix patterns. Add a non-alphanumeric leading-char rule and flip
--     them to is_curated=false.
--
-- (2) building_online_unit_counts view: replaces a ~40-page paginated
--     listings scan on the public site with a single grouped query.
--     Anon-readable so the website's PostgREST query can join via
--     embed.
--
-- DEPENDS ON:
--   20260502000001 (is_curated column), 20260501000006 (buildings
--   table + listings.building_id FK)

-- =====================================================================
-- 1. Extend the curation blocklist
-- =====================================================================

DO $$
DECLARE
  rows_flipped int := 0;
BEGIN
  WITH flipped AS (
    UPDATE public.buildings
    SET is_curated = false
    WHERE is_curated = true
      AND name IS NOT NULL
      -- Names that don't begin with a letter or digit are almost always
      -- malformed listing-derived rows (leading "!", "(", ".", etc.).
      AND name !~ '^[A-Za-z0-9]'
    RETURNING id
  )
  SELECT count(*) INTO rows_flipped FROM flipped;

  RAISE NOTICE 'Curation tail: flipped is_curated=false on % rows whose name does not start with a letter or digit.', rows_flipped;
END $$;

-- =====================================================================
-- 2. building_online_unit_counts view
-- =====================================================================
--
-- Aggregates `is_online` listings by building_id. The website's
-- /api/public/buildings used to scan listings page-by-page and group
-- in-process; this view collapses that to a single grouped read.
-- Recomputed on every SELECT (no materialization) — listings.is_online
-- changes intra-day, so a matview would need refreshes.

CREATE OR REPLACE VIEW public.building_online_unit_counts
WITH (security_invoker = true) AS
SELECT
  building_id,
  count(*)::int AS units_count
FROM public.listings
WHERE is_online = true
  AND building_id IS NOT NULL
  AND deleted_at IS NULL
GROUP BY building_id;

COMMENT ON VIEW public.building_online_unit_counts IS
  'Online unit count per building (security_invoker=true so RLS on listings still applies). Used by the public site to render "<n> units" on building cards without paginating the full listings table.';

-- Anon + authenticated can read. Anon access piggybacks on the
-- existing listings_select_public policy via security_invoker; no
-- additional table-level GRANT on listings is needed because this is
-- a view, not a base table.
GRANT SELECT ON public.building_online_unit_counts TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
