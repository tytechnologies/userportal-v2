-- buildings_legacy_snapshot RLS lockdown
--
-- The buildings_legacy_snapshot table was created by migration
-- 20260501000006 as a one-time spot-check copy of the buildings
-- materialized view contents before that view was dropped and replaced
-- with the first-class buildings table. Subsequent migrations
-- (20260502000001_buildings_is_curated, 20260502000003_buildings_curation_reseed)
-- read from it during backfill.
--
-- The backfill is now done. The snapshot still exists in environments
-- where 000006 actually had a matview to drop, and it carries every
-- row that lived in the public matview at that moment — including any
-- rows that newly-introduced RLS on `buildings` would now hide.
--
-- Without RLS, any authenticated client (including non-admin agents)
-- can `SELECT * FROM public.buildings_legacy_snapshot` and bypass the
-- buildings RLS entirely. This migration locks it down with default-deny:
-- ENABLE ROW LEVEL SECURITY with no policies, which means only
-- service_role / postgres / supabase_admin can read it. The migrations
-- that referenced it are already applied; no production code path
-- queries it.
--
-- Why not DROP the table? Per the project's schema discipline,
-- destructive operations (DROP TABLE) need explicit user sign-off and
-- a rollback story. RLS lockdown achieves the same security outcome
-- (no anon / authenticated reads) and is fully reversible. The table
-- can be dropped in a future migration once verified unneeded.
--
-- ROLLBACK:
--   ALTER TABLE IF EXISTS public.buildings_legacy_snapshot
--     DISABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'buildings_legacy_snapshot'
  ) THEN
    EXECUTE 'ALTER TABLE public.buildings_legacy_snapshot ENABLE ROW LEVEL SECURITY';
    -- FORCE applies RLS to the table owner too (not strictly required for
    -- service_role, which already bypasses, but matches the codebase
    -- convention of enabling FORCE on any newly-locked table).
    EXECUTE 'ALTER TABLE public.buildings_legacy_snapshot FORCE ROW LEVEL SECURITY';
    RAISE NOTICE 'buildings_legacy_snapshot RLS enabled (default-deny; service_role only).';
  ELSE
    RAISE NOTICE 'buildings_legacy_snapshot does not exist in this environment; nothing to lock down.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
