-- Reseed buildings.is_curated using a listing-title blocklist.
--
-- Background: 20260502000001 pre-seeded is_curated=true from
-- buildings_legacy_snapshot. That source turned out to be the matview's
-- post-backfill state — i.e. it already contained the auto-generated
-- listing-title rows we're trying to filter out. Result: every row
-- ended up flagged curated. The website's public filter `WHERE
-- is_curated = true` is therefore a no-op against the contaminated set.
--
-- Fix: heuristic blocklist. Names that match listing-title patterns
-- (transactional verbs, bedroom counts, storey prefixes, etc.) get
-- flipped to is_curated=false. Real buildings like "Shaw Plaza Two"
-- or "The Grove" survive because their names don't match any pattern.
--
-- This is intentionally aggressive on false positives — better to
-- under-show buildings on the public site than to leak listing titles
-- as building URLs. Editors clean up the remaining ambiguous middle
-- via the portal triage UI (default filter Unreviewed; per-row toggle).
--
-- Trade-offs vs cold start (option 1 in the website agent's prompt):
--   + Preserves obvious real buildings without editorial work.
--   - Real buildings whose marketing names happen to contain
--     "for sale" or numeric prefixes will be incorrectly flagged false.
--     Those need re-approval via the portal toggle.
--
-- DEPENDS ON:
--   20260502000001 (is_curated column)

-- =====================================================================
-- Heuristic patterns
-- =====================================================================
--
-- Each pattern is intentionally narrow and case-insensitive. A listing
-- title typically has at least ONE of these signals; a real building
-- name typically has none. The patterns are ordered by specificity.

DO $$
DECLARE
  rows_flipped int := 0;
BEGIN
  WITH flipped AS (
    UPDATE public.buildings
    SET is_curated = false
    WHERE is_curated = true
      AND (
        -- Strongest signal: explicit transaction phrase. No real
        -- building is named "Shaw Plaza FOR SALE".
        name ILIKE '%FOR SALE%'
        OR name ILIKE '%FOR RENT%'
        OR name ILIKE '%FOR LEASE%'

        -- Bedroom count prefix: "1BR", "2 BR", "3-BR" — not a building.
        OR name ~* '^\s*\d+\s*-?\s*BR\b'

        -- Storey prefix: "2-STOREY", "3 STOREY".
        OR name ~* '^\s*\d+\s*-?\s*STOREY\b'

        -- House & lot phrasing — always a listing title.
        OR name ILIKE '% HOUSE & LOT %'
        OR name ILIKE '% HOUSE AND LOT %'

        -- Lot type qualifiers — also listing-title territory.
        OR name ILIKE '%AGRICULTURAL LOT%'
        OR name ILIKE '%COMMERCIAL LOT%'
        OR name ILIKE '%RESIDENTIAL LOT%'
        OR name ILIKE '%INDUSTRIAL LOT%'

        -- Generic verb-form lot/unit/office phrases.
        OR name ILIKE '%UNIT FOR%'
        OR name ILIKE '%LOT FOR%'
        OR name ILIKE '%OFFICE FOR%'
        OR name ILIKE '%WAREHOUSE FOR%'
        OR name ILIKE '%CONDO FOR%'

        -- Compound address fragments — "Building D, Cluster 4" =
        -- nested location, not a building name.
        OR name ILIKE '%, CLUSTER %'
        OR name ILIKE '%, BUILDING %'
        OR name ILIKE '%, TOWER %'
      )
    RETURNING id
  )
  SELECT count(*) INTO rows_flipped FROM flipped;

  RAISE NOTICE 'Reseed: flipped is_curated=false on % rows matching listing-title heuristics.', rows_flipped;
END $$;

-- =====================================================================
-- Diagnostic: report the post-reseed split for the website team.
-- =====================================================================
DO $$
DECLARE
  curated_count int;
  total_count   int;
BEGIN
  SELECT count(*) INTO curated_count FROM public.buildings WHERE is_curated = true;
  SELECT count(*) INTO total_count   FROM public.buildings;
  RAISE NOTICE 'Post-reseed: % of % buildings remain is_curated=true (%.1f%%).',
    curated_count, total_count,
    CASE WHEN total_count > 0 THEN 100.0 * curated_count / total_count ELSE 0 END;
END $$;

NOTIFY pgrst, 'reload schema';
