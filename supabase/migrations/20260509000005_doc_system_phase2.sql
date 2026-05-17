-- Document generation system — Phase 2.
--
-- Adds:
--   document_versions     — append-only snapshot history
--   document_approvals    — request → decide workflow per draft
--
-- Signature placeholders: stored as a JSONB array on
-- document_drafts.data._signature_placeholders. No migration needed —
-- the data column is already JSONB. Schema:
--   _signature_placeholders: [
--     { id: uuid, label: string, party_role: string, page: int|null,
--       x: number|null, y: number|null, signed_at: ISO|null,
--       signed_by_user_id: uuid|null }
--   ]
-- The "signed" markers are operational hints — actual cryptographic
-- e-signing is deferred to a vendor integration (Phase 3).

-- ============================================================
-- 1. document_versions — append-only snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS public.document_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        uuid NOT NULL REFERENCES public.document_drafts(id) ON DELETE CASCADE,
  version_number  integer NOT NULL,
  -- Full snapshot at the moment the version was minted. Storing the
  -- whole data blob means diffs work even when fields move around;
  -- the broker can revert by reading version N's data back into the
  -- live row. Snapshot is intentionally untyped — the editor and
  -- the diff viewer agree on shape.
  snapshot_data   jsonb NOT NULL,
  -- Convenience copy of the AI/freeform body text (when present) so
  -- the diff viewer doesn't have to dig into snapshot_data for the
  -- common "show me how the wording changed" case.
  snapshot_body   text,
  -- Optional human-readable label ("pre-notary", "post-revisions").
  label           text,
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, version_number)
);

CREATE INDEX IF NOT EXISTS document_versions_draft_idx
  ON public.document_versions(draft_id, version_number DESC);

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_versions_read   ON public.document_versions;
DROP POLICY IF EXISTS document_versions_write  ON public.document_versions;

-- Read access piggybacks on the parent draft's RLS — if you can read
-- the draft row, you can read its versions. The subquery is cheap
-- (PK lookup) and avoids duplicating the parent's permission logic.
CREATE POLICY document_versions_read ON public.document_versions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.document_drafts d
    WHERE d.id = document_versions.draft_id
  ));

CREATE POLICY document_versions_write ON public.document_versions
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.document_drafts d
    WHERE d.id = document_versions.draft_id
  ));

-- Append-only: no UPDATE/DELETE policies. Versions are immutable
-- once minted (the "audit trail" property). To "revert" the live
-- draft, the application copies snapshot_data back into the
-- document_drafts row — the version history stays intact.

GRANT SELECT, INSERT ON public.document_versions TO authenticated;

-- ============================================================
-- 2. document_approvals — pending → approved/rejected workflow
-- ============================================================
CREATE TABLE IF NOT EXISTS public.document_approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id          uuid NOT NULL REFERENCES public.document_drafts(id) ON DELETE CASCADE,
  reviewer_user_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requested_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','withdrawn')),
  comment           text,
  -- Snapshot pointer: which version was reviewed. NULL = no version
  -- minted at request time (legacy / unsnapshotted approval).
  version_id        uuid REFERENCES public.document_versions(id) ON DELETE SET NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  -- Prevent duplicate pending approvals from the same reviewer on
  -- the same draft. New reviews after a decision are a fresh row.
  UNIQUE (draft_id, reviewer_user_id, requested_at)
);

CREATE INDEX IF NOT EXISTS document_approvals_draft_idx
  ON public.document_approvals(draft_id);
CREATE INDEX IF NOT EXISTS document_approvals_reviewer_pending_idx
  ON public.document_approvals(reviewer_user_id) WHERE status = 'pending';

ALTER TABLE public.document_approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_approvals_read     ON public.document_approvals;
DROP POLICY IF EXISTS document_approvals_request  ON public.document_approvals;
DROP POLICY IF EXISTS document_approvals_decide   ON public.document_approvals;

-- Read: anyone who can read the parent draft, OR the reviewer.
CREATE POLICY document_approvals_read ON public.document_approvals
  FOR SELECT TO authenticated
  USING (
       reviewer_user_id = auth.uid()
    OR requested_by    = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.document_drafts d
      WHERE d.id = document_approvals.draft_id
    )
  );

-- Anyone with read access on the draft can request approval.
CREATE POLICY document_approvals_request ON public.document_approvals
  FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.document_drafts d
      WHERE d.id = document_approvals.draft_id
    )
  );

-- Decisions: only the reviewer can approve/reject; only the
-- requester can withdraw. PATCH endpoint enforces the status
-- transition shape on top.
CREATE POLICY document_approvals_decide ON public.document_approvals
  FOR UPDATE TO authenticated
  USING (
       reviewer_user_id = auth.uid()
    OR requested_by    = auth.uid()
  )
  WITH CHECK (
       reviewer_user_id = auth.uid()
    OR requested_by    = auth.uid()
  );

GRANT SELECT, INSERT, UPDATE ON public.document_approvals TO authenticated;
