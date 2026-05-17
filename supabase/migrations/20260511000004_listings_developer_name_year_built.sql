-- Fix: AddListingWizard publish fails with
--   "Could not find the 'developer_name' column of 'listings' in the
--    schema cache"
--
-- These columns are part of the baseline listings schema (the
-- pre-migration era schema that lives outside supabase/migrations).
-- Production has them; local databases that were stood up from
-- migrations alone don't, and the wizard payload references them
-- directly (AddListingWizard.vue ~line 640).
--
-- Both columns are tracked elsewhere as already-existing:
--   - 20260429000005 lists developer_name varchar / year_built smallint
--     in the listing_details MV column reference
--   - 20260506000001_public_listing_details_view selects developer_name
--     from listings
-- So we mirror those types here. IF NOT EXISTS keeps the migration
-- idempotent / no-op on prod where the columns are already present.
--
-- If other baseline columns turn out to be missing on this local DB
-- (property_name, street_address, etc.), add them in a follow-up
-- migration with the same pattern, or `pg_dump --schema-only` from
-- prod and rehydrate.
--
-- ROLLBACK:
--   ALTER TABLE public.listings DROP COLUMN IF EXISTS developer_name;
--   ALTER TABLE public.listings DROP COLUMN IF EXISTS year_built;

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS developer_name varchar,
  ADD COLUMN IF NOT EXISTS year_built     smallint;

NOTIFY pgrst, 'reload schema';
