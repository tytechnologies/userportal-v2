-- Workflow + sharing for document_drafts.
--
-- Adds:
--   1. status column on document_drafts (draft → in_review → signed → archived)
--   2. document_draft_share_links table for token-based read-only public access
--
-- The status field is enforced at the DB level via CHECK; the server
-- transition endpoint additionally emits an audit row per status change.
--
-- Share links: a row in document_draft_share_links holds a SECURE
-- random token (generated server-side) plus an expiration. The public
-- shared-draft endpoint joins through this table to validate the
-- token, then returns the draft's contents directly — no JWT, no RLS,
-- no listing of drafts beyond the one the token points at. RLS still
-- gates create/list/revoke of the share rows themselves.
--
-- DEPENDS ON:
--   20260501000003_document_drafts.sql

-- =====================================================================
-- 1. status column on document_drafts
-- =====================================================================

ALTER TABLE public.document_drafts
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';

-- Add the CHECK in a separate guarded block so re-runs are idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_drafts_status_check'
      AND conrelid = 'public.document_drafts'::regclass
  ) THEN
    ALTER TABLE public.document_drafts
      ADD CONSTRAINT document_drafts_status_check
      CHECK (status IN ('draft', 'in_review', 'signed', 'archived'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_document_drafts_status
  ON public.document_drafts(status);

COMMENT ON COLUMN public.document_drafts.status IS
  'Workflow state: draft (default) → in_review → signed → archived. Transitions are recorded in the activities table.';

-- =====================================================================
-- 2. document_draft_share_links
-- =====================================================================
--
-- Tokens are 32-byte URL-safe random strings minted server-side. Token
-- is the lookup key; an attacker who guesses a valid token sees the
-- draft's contents (read-only). Hence:
--   - Tokens are sufficiently long that brute-force is impractical.
--   - Expiration (default 7 days) bounds the leak window.
--   - revoked_at lets owners kill a leaked link immediately.
--   - The public endpoint NEVER lists tokens — it requires you to
--     already have the token to read the draft.

CREATE TABLE IF NOT EXISTS public.document_draft_share_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      uuid NOT NULL REFERENCES public.document_drafts(id) ON DELETE CASCADE,
  token         text NOT NULL UNIQUE,
  -- Optional creator attribution. Set by the create endpoint.
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_share_links_draft
  ON public.document_draft_share_links(draft_id);
CREATE INDEX IF NOT EXISTS idx_share_links_token
  ON public.document_draft_share_links(token);

COMMENT ON TABLE public.document_draft_share_links IS
  'Token-keyed read-only share links for document drafts. Public viewer endpoint joins through token; no auth required.';

ALTER TABLE public.document_draft_share_links ENABLE ROW LEVEL SECURITY;

-- READ: same scope as the parent draft. If you can see the draft, you
-- can see (and revoke) its share links.
DROP POLICY IF EXISTS share_links_select ON public.document_draft_share_links;
CREATE POLICY share_links_select
  ON public.document_draft_share_links FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.document_drafts d
      WHERE d.id = document_draft_share_links.draft_id
    )
  );

-- INSERT: must be a draft you can write.
DROP POLICY IF EXISTS share_links_insert ON public.document_draft_share_links;
CREATE POLICY share_links_insert
  ON public.document_draft_share_links FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.document_drafts d
      WHERE d.id = document_draft_share_links.draft_id
        AND (
          d.owner_user_id = auth.uid()
          OR public.has_permission('documents.write.all')
        )
    )
  );

-- UPDATE / DELETE: only owners + admins (used to revoke).
DROP POLICY IF EXISTS share_links_update ON public.document_draft_share_links;
CREATE POLICY share_links_update
  ON public.document_draft_share_links FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.document_drafts d
      WHERE d.id = document_draft_share_links.draft_id
        AND (
          d.owner_user_id = auth.uid()
          OR public.has_permission('documents.write.all')
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.document_drafts d
      WHERE d.id = document_draft_share_links.draft_id
        AND (
          d.owner_user_id = auth.uid()
          OR public.has_permission('documents.write.all')
        )
    )
  );

DROP POLICY IF EXISTS share_links_delete ON public.document_draft_share_links;
CREATE POLICY share_links_delete
  ON public.document_draft_share_links FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.document_drafts d
      WHERE d.id = document_draft_share_links.draft_id
        AND (
          d.owner_user_id = auth.uid()
          OR public.has_permission('documents.write.all')
        )
    )
  );

NOTIFY pgrst, 'reload schema';
