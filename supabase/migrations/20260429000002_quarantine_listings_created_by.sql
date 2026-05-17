-- Audit D1 fix: listings.created_by holds a mix of valid UUIDs (linking to
-- auth.users / profiles) and legacy plain-name strings (e.g. "Tyler",
-- "Laine Bordaje"). This migration cleans the column without losing data:
--
--   1. Add `created_by_legacy text` to receive the bad strings.
--   2. Move every non-UUID value out of `created_by` into the new column.
--   3. Re-type `created_by` as uuid (now safe — only UUIDs / NULLs remain).
--   4. Add the FK to public.profiles to prevent re-introducing the issue.
--
-- The legacy column stays for offline reconciliation (manual mapping of
-- "Tyler" → a real profile.id, etc.). Drop it once it's empty in a follow-up.
--
-- DEPENDS ON: 20260429000001_create_profiles_table.sql
--
-- ROLLBACK (per step):
--   ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS listings_created_by_fk;
--   ALTER TABLE public.listings ALTER COLUMN created_by TYPE text USING created_by::text;
--   UPDATE public.listings SET created_by = COALESCE(created_by, created_by_legacy)
--     WHERE created_by_legacy IS NOT NULL;
--   ALTER TABLE public.listings DROP COLUMN IF EXISTS created_by_legacy;

-- 1. Quarantine column for the legacy string values.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS created_by_legacy text;

COMMENT ON COLUMN public.listings.created_by_legacy IS
  'Legacy free-text values that used to live in created_by before the FK to profiles. Reconcile manually then drop.';

CREATE INDEX IF NOT EXISTS idx_listings_created_by_legacy
  ON public.listings(created_by_legacy)
  WHERE created_by_legacy IS NOT NULL;

-- 2. Move non-UUID values out of created_by.
-- Same regex used by the JS enrichment fallback; keep them in sync.
UPDATE public.listings
SET created_by_legacy = created_by,
    created_by        = NULL
WHERE created_by IS NOT NULL
  AND created_by !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Same treatment for updated_by + deleted_by which share the same legacy issue.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS updated_by_legacy text,
  ADD COLUMN IF NOT EXISTS deleted_by_legacy text;

UPDATE public.listings
SET updated_by_legacy = updated_by,
    updated_by        = NULL
WHERE updated_by IS NOT NULL
  AND updated_by !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE public.listings
SET deleted_by_legacy = deleted_by,
    deleted_by        = NULL
WHERE deleted_by IS NOT NULL
  AND deleted_by !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 3. Type-lock all three columns to uuid.
-- Wrapped in DO blocks so re-running the migration is a no-op if already typed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'listings'
      AND column_name = 'created_by' AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE public.listings ALTER COLUMN created_by TYPE uuid USING created_by::uuid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'listings'
      AND column_name = 'updated_by' AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE public.listings ALTER COLUMN updated_by TYPE uuid USING updated_by::uuid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'listings'
      AND column_name = 'deleted_by' AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE public.listings ALTER COLUMN deleted_by TYPE uuid USING deleted_by::uuid;
  END IF;
END $$;

-- 4. FK constraints. ON DELETE SET NULL: if a profile is deleted (cascade
-- from auth.users), the listing survives but loses attribution.
ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_created_by_fk;
ALTER TABLE public.listings
  ADD CONSTRAINT listings_created_by_fk
  FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_updated_by_fk;
ALTER TABLE public.listings
  ADD CONSTRAINT listings_updated_by_fk
  FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_deleted_by_fk;
ALTER TABLE public.listings
  ADD CONSTRAINT listings_deleted_by_fk
  FOREIGN KEY (deleted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Indexes for the FKs (PostgREST relational selects use them; without these
-- a `select(*, profiles!created_by(*))` forces a sequential scan).
CREATE INDEX IF NOT EXISTS idx_listings_created_by ON public.listings(created_by);
CREATE INDEX IF NOT EXISTS idx_listings_updated_by ON public.listings(updated_by);
CREATE INDEX IF NOT EXISTS idx_listings_deleted_by ON public.listings(deleted_by);

-- Heal helper: maps a legacy string to a profile by exact case-insensitive
-- full_name match. Run with caution — multiple profiles can share names.
-- This is intentionally NOT executed as part of the migration; product
-- judgment is required.
--
-- UPDATE public.listings l
-- SET created_by        = p.id,
--     created_by_legacy = NULL
-- FROM public.profiles p
-- WHERE l.created_by_legacy IS NOT NULL
--   AND lower(p.full_name) = lower(l.created_by_legacy);
