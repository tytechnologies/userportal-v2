-- Remediation: ensure listings.barangay_id and listings.city_id exist.
--
-- The new-listing form writes city_id + barangay_id (the canonical FK
-- columns post-normalization). If the original normalize migration
-- (20260429000004_normalize_listings_city_barangay.sql) didn't apply,
-- these columns are absent and PostgREST returns:
--
--   "Could not find the 'barangay_id' column of 'listings' in the
--    schema cache"
--
-- This migration is idempotent and safe to run regardless of state.
--
-- DEPENDS ON:
--   public.cities and public.barangays must exist with PK = id.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS city_id     smallint,
  ADD COLUMN IF NOT EXISTS barangay_id integer;

-- FKs are added in DO blocks because PG <16 doesn't support
-- ADD CONSTRAINT IF NOT EXISTS. Each block checks pg_constraint first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'listings_city_id_fkey'
      AND conrelid = 'public.listings'::regclass
  ) THEN
    ALTER TABLE public.listings
      ADD CONSTRAINT listings_city_id_fkey
      FOREIGN KEY (city_id) REFERENCES public.cities(id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'listings_barangay_id_fkey'
      AND conrelid = 'public.listings'::regclass
  ) THEN
    ALTER TABLE public.listings
      ADD CONSTRAINT listings_barangay_id_fkey
      FOREIGN KEY (barangay_id) REFERENCES public.barangays(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Indexes for the FKs — joins/filters by city_id or barangay_id are
-- common and we'd rather not seq-scan a large listings table.
CREATE INDEX IF NOT EXISTS idx_listings_city_id     ON public.listings(city_id);
CREATE INDEX IF NOT EXISTS idx_listings_barangay_id ON public.listings(barangay_id);

-- Force PostgREST to pick up the new columns.
NOTIFY pgrst, 'reload schema';
