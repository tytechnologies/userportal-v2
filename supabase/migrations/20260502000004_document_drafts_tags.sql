-- Add `tags` to document_drafts.
--
-- Free-form string tags so editors can group drafts beyond the
-- chronological/status axis ("Q3 closings", "pending counterparty",
-- "internal", etc.). Multi-tag means one draft can sit in several
-- buckets at once.
--
-- Stored as text[] so we can leverage Postgres array containment
-- operators (`?` and `@>`) for filtering. A GIN index keeps tag
-- lookups cheap as the table grows.
--
-- DEPENDS ON:
--   20260501000003 (document_drafts table)

ALTER TABLE public.document_drafts
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];

-- GIN index for ANY/ALL operators. Postgres uses this whenever the
-- query plans a `tags @> '{foo}'` or `tags && '{foo,bar}'` filter.
CREATE INDEX IF NOT EXISTS idx_document_drafts_tags
  ON public.document_drafts USING gin(tags);

COMMENT ON COLUMN public.document_drafts.tags IS
  'Free-form editor tags for grouping drafts (e.g. "Q3 closings"). Empty array = untagged. Filtering uses Postgres array containment via the GIN index.';

NOTIFY pgrst, 'reload schema';
