-- Promote documents.metadata->>'listing_id' (and contact_id) to real
-- FK columns.
--
-- Background: server endpoints stash listing_id and contact_id in
-- documents.metadata jsonb so the unified CRM timeline can pivot on
-- them. That works for the timeline (GIN index on metadata) but isn't
-- enough when we want to:
--   - Show "all documents for this listing" on a listing detail page
--     without a JSONB scan over every document row.
--   - Cascade-clean documents when a listing is deleted.
--   - Type-check the relationship in PostgREST embedded selects.
--
-- This migration:
--   1. Adds documents.listing_id (bigint, FK → listings, ON DELETE SET NULL).
--   2. Adds documents.contact_id (bigint, FK → contacts, ON DELETE SET NULL).
--   3. Backfills both from existing metadata.
--   4. Indexes both columns.
--
-- Existing metadata pointers stay (server endpoints still write them
-- for backwards compat with anything that reads them today). We just
-- now ALSO write the FK columns.
--
-- DEPENDS ON:
--   20250129000000 (documents table)
--   20260501000006 (listings building_id pattern; listings.id exists)

-- =====================================================================
-- 1. Columns
-- =====================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS listing_id bigint,
  ADD COLUMN IF NOT EXISTS contact_id bigint;

-- =====================================================================
-- 2. FK constraints — guarded so re-runs are no-ops
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_listing_id_fkey'
      AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_listing_id_fkey
      FOREIGN KEY (listing_id) REFERENCES public.listings(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_contact_id_fkey'
      AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_contact_id_fkey
      FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =====================================================================
-- 3. Backfill from metadata
-- =====================================================================
--
-- Only fills NULL columns — re-running is safe. Casts the JSONB text
-- value through bigint with a regex guard so a malformed metadata value
-- doesn't blow up the migration.

UPDATE public.documents
SET listing_id = NULLIF(metadata->>'listing_id', '')::bigint
WHERE listing_id IS NULL
  AND metadata ? 'listing_id'
  AND metadata->>'listing_id' ~ '^\d+$';

UPDATE public.documents
SET contact_id = NULLIF(metadata->>'contact_id', '')::bigint
WHERE contact_id IS NULL
  AND metadata ? 'contact_id'
  AND metadata->>'contact_id' ~ '^\d+$';

-- =====================================================================
-- 4. Indexes
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_documents_listing_id
  ON public.documents(listing_id)
  WHERE listing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_contact_id
  ON public.documents(contact_id)
  WHERE contact_id IS NOT NULL;

COMMENT ON COLUMN public.documents.listing_id IS
  'FK to listings.id. Replaces metadata->>"listing_id" for joinable queries (e.g. "all documents for this listing"). Server endpoints still write the metadata field too for backwards compat.';
COMMENT ON COLUMN public.documents.contact_id IS
  'FK to contacts.id. Same reasoning as listing_id.';

NOTIFY pgrst, 'reload schema';
