-- AI Suggestions queue.
--
-- Phase D foundation. Records LLM-generated suggestions for human
-- review before any state change. Trust-first: NO suggestion ever
-- mutates a target row directly; the operator reviews + accepts or
-- rejects, and acceptance triggers the appropriate downstream
-- domain RPC (which has its own audit trail).
--
-- Documented suggestion kinds (open-ended; new kinds add without migration):
--   listing.description_enrichment   — improved listing description
--   listing.duplicate_review_assist  — confidence rationale on a duplicate pair
--   inquiry.summarisation            — summary of an inquiry conversation
--   document_draft.field_autofill    — suggested field values for a draft
--   moderation.first_pass            — recommend approve/reject on a verification
--
-- Suggestion lifecycle:
--   pending → accepted | rejected | superseded | expired
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.ai_suggestions;
--   DELETE FROM public.role_permissions WHERE permission = 'ai_suggestions.manage';
--   DELETE FROM public.permissions WHERE name = 'ai_suggestions.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.ai_suggestions';


CREATE TABLE IF NOT EXISTS public.ai_suggestions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Documented kinds; free-form text so new kinds don't need a migration.
  kind                text NOT NULL,

  -- Polymorphic target. target_kind documents what target_id refers to.
  -- e.g. ('listing', '<bigint>'), ('inquiry', '<uuid>'),
  -- ('document_draft', '<uuid>'), ('listing_duplicate', '<uuid>').
  target_kind         text NOT NULL,
  target_id           text NOT NULL,

  -- The model's proposed change. Shape depends on kind:
  --   description_enrichment: { proposed_description: text, diff_summary: text }
  --   duplicate_review_assist: { recommended_verdict: 'duplicate'|'distinct'|'unclear',
  --                              confidence: 0-1, rationale: text }
  --   inquiry.summarisation: { summary: text, key_points: text[], next_action: text }
  suggested_payload   jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Provenance: which model and run produced this.
  model_provider      text,            -- 'openai', 'anthropic', 'self_hosted', etc.
  model_name          text,            -- 'gpt-4', 'claude-opus-4-7', etc.
  model_run_id        text,            -- tracking ID from the provider
  prompt_version      text,            -- internal versioning of the prompt template
  -- 0.0 - 1.0 if the model emits one; NULL if not.
  confidence          numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  -- Lifecycle.
  status              text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'accepted', 'rejected',
                                             'superseded', 'expired')),

  reviewed_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  -- Operator's edit of suggested_payload before accepting (when applicable).
  accepted_payload    jsonb,
  reject_reason       text,

  -- For duplicate detection: when a newer suggestion supersedes this one.
  superseded_by_id    uuid REFERENCES public.ai_suggestions(id) ON DELETE SET NULL,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at          timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_suggestions_status_idx
  ON public.ai_suggestions(status, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_suggestions_target_idx
  ON public.ai_suggestions(target_kind, target_id);
CREATE INDEX IF NOT EXISTS ai_suggestions_pending_idx
  ON public.ai_suggestions(kind, created_at DESC)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS set_ai_suggestions_updated_at ON public.ai_suggestions;
CREATE TRIGGER set_ai_suggestions_updated_at
  BEFORE UPDATE ON public.ai_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.ai_suggestions IS
  'AI-generated suggestions for human review. NO direct mutation of target rows. Acceptance is operator-driven and triggers the appropriate domain RPC separately.';


-- =====================================================================
-- Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('ai_suggestions.manage',
   'Review, accept, reject AI-generated suggestions',
   'platform')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'ai_suggestions.manage'),
  ('manager', 'ai_suggestions.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- RLS
-- =====================================================================

ALTER TABLE public.ai_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_suggestions_select ON public.ai_suggestions;
CREATE POLICY ai_suggestions_select ON public.ai_suggestions FOR SELECT
  TO authenticated
  USING (
    public.has_permission('ai_suggestions.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS ai_suggestions_modify ON public.ai_suggestions;
CREATE POLICY ai_suggestions_modify ON public.ai_suggestions FOR ALL
  TO authenticated
  USING (
    public.has_permission('ai_suggestions.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('ai_suggestions.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.ai_suggestions', 'table', 'userportal',
   ARRAY['userportal']::text[], 'AI suggestion review queue', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
