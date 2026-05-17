-- Add `is_curated` to public.buildings — splits real building entries
-- from auto-generated rows the May-1 backfill created off
-- listing_details.property_name.
--
-- Background: 000011 + 000013's two-pass backfill blindly inserted a
-- distinct buildings row for every property_name on listings. That
-- field is a marketing headline ("3-STOREY HOUSE FOR SALE IN MAKATI"),
-- not a normalized building registry, so the table is now ~80% junk:
-- 3,107 rows where most are listing titles, a minority are real
-- buildings ("Shaw Plaza Two", "The Grove"). The public website
-- exposed thousands of low-quality near-duplicate building URLs as a
-- result.
--
-- Fix: classification, not deletion. Auto-rows stay (listings.building_id
-- depends on them); a boolean flag separates curated from auto. Public
-- site filters WHERE is_curated = true. Editors triage over time via
-- the portal's /buildings/:id page.
--
-- Pre-seed strategy: rows whose name matches an entry in
-- public.buildings_legacy_snapshot (created by 000006's matview-drop)
-- are flagged is_curated = true. That snapshot is the pre-backfill
-- registry and represents the editor-curated set before any auto-
-- create churn — the cleanest signal we have.
--
-- DEPENDS ON:
--   20260501000006 (buildings_legacy_snapshot table)

-- =====================================================================
-- 1. Column + index
-- =====================================================================

ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS is_curated boolean NOT NULL DEFAULT false;

-- Public-site index: filter on is_curated, lookup by slug. Partial so
-- we don't pay write cost for the auto-row majority.
CREATE INDEX IF NOT EXISTS idx_buildings_curated_slug
  ON public.buildings (is_curated, slug)
  WHERE is_curated = true;

COMMENT ON COLUMN public.buildings.is_curated IS
  'true = real building reviewed by an editor (safe to expose publicly). false = auto-generated row from May-1 backfill that represents a listing title, not a real building. Public website filters to is_curated = true; portal UI exposes a toggle for editorial triage.';

-- =====================================================================
-- 2. Pre-seed from the legacy snapshot
-- =====================================================================
--
-- buildings_legacy_snapshot was the matview's contents before the
-- matview-to-table conversion in 000006. Rows whose name appears in
-- that snapshot are by definition NOT auto-create casualties — they
-- existed before the backfill ran.
--
-- Match is case-insensitive + trimmed to absorb minor data hygiene
-- drift. Defensive about which name column the snapshot has (it may
-- carry `name` OR the legacy `building_name`).

DO $$
DECLARE
  has_snapshot      boolean;
  has_name          boolean;
  has_building_name boolean;
  src_col           text;
  rows_curated      int := 0;
  sql_text          text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='buildings_legacy_snapshot'
  ) INTO has_snapshot;
  IF NOT has_snapshot THEN
    RAISE NOTICE 'buildings_legacy_snapshot not present; skipping pre-seed. All rows default is_curated=false; editors triage via portal UI.';
    RETURN;
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='buildings_legacy_snapshot' AND column_name='name')
    INTO has_name;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='buildings_legacy_snapshot' AND column_name='building_name')
    INTO has_building_name;

  IF has_name THEN src_col := 'name';
  ELSIF has_building_name THEN src_col := 'building_name';
  ELSE
    RAISE NOTICE 'snapshot has neither name nor building_name; skipping pre-seed.';
    RETURN;
  END IF;

  sql_text := format($f$
    WITH curated AS (
      UPDATE public.buildings b
      SET is_curated = true
      WHERE EXISTS (
        SELECT 1 FROM public.buildings_legacy_snapshot s
        WHERE lower(trim(s.%I)) = lower(trim(b.name))
          AND s.%I IS NOT NULL
          AND s.%I <> ''
      )
      AND b.is_curated = false
      RETURNING b.id
    )
    SELECT count(*) FROM curated
  $f$, src_col, src_col, src_col);

  EXECUTE sql_text INTO rows_curated;
  RAISE NOTICE 'Pre-seeded is_curated=true on % buildings from legacy snapshot.', rows_curated;
END $$;

NOTIFY pgrst, 'reload schema';
