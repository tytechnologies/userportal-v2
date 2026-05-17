-- Idempotent re-application of public.government_documents.external_url.
--
-- WHY:
-- Production logs on 2026-05-07 surfaced repeated:
--   column government_documents.external_url does not exist
--   op: gov_docs.list
--
-- The column should exist via 20260502000018_government_documents_external_url_backfill.sql.
-- It doesn't on this database — same pattern hit earlier in the session
-- with the *_legacy quarantine columns: a migration that was either
-- never applied or had its column dropped manually.
--
-- This migration is the column-add half of 20260502000018,
-- re-shipped idempotently. The backfill / status-flip side effects
-- of the original migration are NOT replayed — those depend on the
-- specific seed-row titles and would no-op on a database where the
-- seed rows have moved on, or worse, clobber admin-customized URLs
-- if the rows were edited.
--
-- Read path in server/api/government-documents/index.get.ts is:
--   COALESCE(signed_url_from_s3_key, external_url, '')
-- so a missing external_url just means "no fallback URL" — rows
-- without an s3_key will render a non-clickable item until an admin
-- uploads or edits.
--
-- ROLLBACK:
--   ALTER TABLE public.government_documents DROP COLUMN IF EXISTS external_url;
--   (rolling this back will re-break gov_docs.list on this database;
--    don't unless you're also reverting the read path)

ALTER TABLE public.government_documents
  ADD COLUMN IF NOT EXISTS external_url text;

COMMENT ON COLUMN public.government_documents.external_url IS
  'Optional static URL or absolute path to the file (e.g. /img/documents/foo.jpg for a public asset). Used when the row references content not stored in S3. Read path prefers s3_key when both are set; UI falls back to external_url when s3_key is null. Re-shipped via 20260507000019 after production logs showed the column missing on this database.';

NOTIFY pgrst, 'reload schema';
