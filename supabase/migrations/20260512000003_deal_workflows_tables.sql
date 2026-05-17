-- Per-deal workflow snapshot tables. Created when a broker (or
-- envelope auto-completion handler) starts the workflow; populated
-- by the deal_workflow_start RPC in 20260512000004.
--
-- Writes are RPC-only — INSERT/UPDATE/DELETE policies are absent so
-- direct PostgREST mutations get rejected. The state machine lives
-- in the SECURITY DEFINER RPCs.
--
-- See: docs/superpowers/specs/2026-05-12-post-signing-document-workflow-design.md
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS deal_workflow_steps_select ON public.deal_workflow_steps;
--   DROP POLICY IF EXISTS deal_workflows_select      ON public.deal_workflows;
--   DROP TABLE IF EXISTS public.deal_workflow_steps;
--   DROP TABLE IF EXISTS public.deal_workflows;
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.deal_workflows', 'public.deal_workflow_steps');

-- =====================================================================
-- 1. deal_workflows
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.deal_workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid NOT NULL UNIQUE REFERENCES public.deals(id) ON DELETE CASCADE,
  template_id     uuid REFERENCES public.workflow_templates(id) ON DELETE SET NULL,
  template_key    text NOT NULL,                          -- frozen
  title_branch    text CHECK (title_branch IN ('condo','land')),
  status          text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','completed','abandoned')),
  current_step_id uuid,                                   -- FK declared after deal_workflow_steps
  started_via     text NOT NULL CHECK (started_via IN ('envelope_auto','manual')),
  envelope_id     uuid REFERENCES public.document_envelopes(id) ON DELETE SET NULL,
  started_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  abandoned_at    timestamptz,
  abandon_reason  text
);

CREATE INDEX IF NOT EXISTS deal_workflows_deal_idx
  ON public.deal_workflows(deal_id);
CREATE INDEX IF NOT EXISTS deal_workflows_status_idx
  ON public.deal_workflows(status, started_at DESC);
CREATE INDEX IF NOT EXISTS deal_workflows_envelope_idx
  ON public.deal_workflows(envelope_id) WHERE envelope_id IS NOT NULL;

COMMENT ON TABLE public.deal_workflows IS
  'Per-deal post-signing workflow instance. Frozen template snapshot lives in deal_workflow_steps. State transitions exclusively via SECURITY DEFINER RPCs (deal_workflow_start / advance / abandon).';

-- =====================================================================
-- 2. deal_workflow_steps
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.deal_workflow_steps (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id             uuid NOT NULL REFERENCES public.deal_workflows(id) ON DELETE CASCADE,
  step_index              int  NOT NULL,
  key                     text NOT NULL,
  title                   text NOT NULL,
  description             text,
  phase                   text NOT NULL,
  attestation_text        text NOT NULL,
  status                  text NOT NULL DEFAULT 'locked'
                              CHECK (status IN ('locked','active','completed','skipped')),
  document_id             uuid REFERENCES public.documents(id) ON DELETE RESTRICT,
  attested_at             timestamptz,
  attested_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  attestation_signature   text,
  completed_at            timestamptz,
  skip_reason             text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, step_index)
);

CREATE INDEX IF NOT EXISTS deal_workflow_steps_workflow_idx
  ON public.deal_workflow_steps(workflow_id, step_index);
CREATE INDEX IF NOT EXISTS deal_workflow_steps_active_idx
  ON public.deal_workflow_steps(workflow_id, status)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS deal_workflow_steps_doc_idx
  ON public.deal_workflow_steps(document_id) WHERE document_id IS NOT NULL;

-- Forward-declare the FK on deal_workflows.current_step_id now that the
-- referenced table exists. Allows NULL (the workflow has no active step
-- when in a terminal state).
ALTER TABLE public.deal_workflows
  DROP CONSTRAINT IF EXISTS deal_workflows_current_step_id_fkey,
  ADD CONSTRAINT deal_workflows_current_step_id_fkey
    FOREIGN KEY (current_step_id)
    REFERENCES public.deal_workflow_steps(id)
    ON DELETE SET NULL;

-- =====================================================================
-- 3. RLS — SELECT only; writes go through RPCs.
-- =====================================================================

ALTER TABLE public.deal_workflows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_workflows_select ON public.deal_workflows;
CREATE POLICY deal_workflows_select ON public.deal_workflows FOR SELECT
  TO authenticated USING (public.deal_can_read(deal_id));

-- No INSERT/UPDATE/DELETE policies => PostgREST writes are blocked.
-- SECURITY DEFINER RPCs in 20260512000004 own all mutations.


ALTER TABLE public.deal_workflow_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_workflow_steps_select ON public.deal_workflow_steps;
CREATE POLICY deal_workflow_steps_select ON public.deal_workflow_steps FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.deal_workflows w
       WHERE w.id = workflow_id
         AND public.deal_can_read(w.deal_id)
    )
  );

GRANT SELECT ON public.deal_workflows, public.deal_workflow_steps TO authenticated;

-- =====================================================================
-- 4. Governance contracts
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.deal_workflows',      'table', 'userportal',
   ARRAY['userportal']::text[], 'Per-deal post-signing workflow instance', false),
  ('public.deal_workflow_steps', 'table', 'userportal',
   ARRAY['userportal']::text[], 'Frozen step snapshot per deal workflow',  false)
ON CONFLICT (contract_name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
