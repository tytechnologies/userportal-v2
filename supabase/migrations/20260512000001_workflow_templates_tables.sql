-- Workflow Templates — master tables for the post-signing document
-- workflow. These are admin-editable; per-deal snapshots live in
-- deal_workflows / deal_workflow_steps (see 20260512000003).
--
-- See: docs/superpowers/specs/2026-05-12-post-signing-document-workflow-design.md
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS workflow_template_steps_select ON public.workflow_template_steps;
--   DROP POLICY IF EXISTS workflow_template_steps_write  ON public.workflow_template_steps;
--   DROP POLICY IF EXISTS workflow_templates_select_active   ON public.workflow_templates;
--   DROP POLICY IF EXISTS workflow_templates_select_admin    ON public.workflow_templates;
--   DROP POLICY IF EXISTS workflow_templates_write           ON public.workflow_templates;
--   DROP TABLE IF EXISTS public.workflow_template_steps;
--   DROP TABLE IF EXISTS public.workflow_templates;
--   DELETE FROM public.role_permissions WHERE permission IN
--     ('workflow_templates.write', 'workflow_templates.read.all', 'deal_workflows.abandon');
--   DELETE FROM public.permissions WHERE name IN
--     ('workflow_templates.write', 'workflow_templates.read.all', 'deal_workflows.abandon');
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.workflow_templates', 'public.workflow_template_steps');

-- =====================================================================
-- 1. workflow_templates
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.workflow_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text UNIQUE NOT NULL,                       -- 'sale_transfer_v1'
  title       text NOT NULL,
  description text,
  applies_to  text NOT NULL CHECK (applies_to IN ('sale','lease')),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_templates_applies_to_active_idx
  ON public.workflow_templates(applies_to, active);

DROP TRIGGER IF EXISTS set_workflow_templates_updated_at ON public.workflow_templates;
CREATE TRIGGER set_workflow_templates_updated_at
  BEFORE UPDATE ON public.workflow_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.workflow_templates IS
  'Master workflow definitions for the post-signing document process. applies_to=sale or lease. Per-deal snapshots in deal_workflow_steps freeze the step text at start time so template edits never disrupt in-flight workflows.';

-- =====================================================================
-- 2. workflow_template_steps
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.workflow_template_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id      uuid NOT NULL REFERENCES public.workflow_templates(id) ON DELETE CASCADE,
  step_index       int  NOT NULL,
  key              text NOT NULL,
  title            text NOT NULL,
  description      text,
  phase            text NOT NULL,
  branch           text NOT NULL DEFAULT 'always'
                       CHECK (branch IN ('always','condo_only','land_only')),
  attestation_text text NOT NULL,
  helper_doc_id    uuid REFERENCES public.government_documents(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, step_index),
  UNIQUE (template_id, key)
);

CREATE INDEX IF NOT EXISTS workflow_template_steps_template_idx
  ON public.workflow_template_steps(template_id, step_index);

DROP TRIGGER IF EXISTS set_workflow_template_steps_updated_at ON public.workflow_template_steps;
CREATE TRIGGER set_workflow_template_steps_updated_at
  BEFORE UPDATE ON public.workflow_template_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- =====================================================================
-- 3. Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('workflow_templates.write',    'Create / edit / disable workflow templates',           'workflow'),
  ('workflow_templates.read.all', 'Read drafts + disabled templates',                     'workflow'),
  ('deal_workflows.abandon',      'Abandon any deal''s workflow regardless of participation','workflow')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'workflow_templates.write'),
  ('admin',   'workflow_templates.read.all'),
  ('admin',   'deal_workflows.abandon'),
  ('manager', 'workflow_templates.write'),
  ('manager', 'deal_workflows.abandon')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 4. RLS
-- =====================================================================

ALTER TABLE public.workflow_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_templates_select_active ON public.workflow_templates;
CREATE POLICY workflow_templates_select_active ON public.workflow_templates FOR SELECT
  TO authenticated USING (active = true);

DROP POLICY IF EXISTS workflow_templates_select_admin ON public.workflow_templates;
CREATE POLICY workflow_templates_select_admin ON public.workflow_templates FOR SELECT
  TO authenticated USING (public.has_permission('workflow_templates.write'));

DROP POLICY IF EXISTS workflow_templates_write ON public.workflow_templates;
CREATE POLICY workflow_templates_write ON public.workflow_templates FOR ALL
  TO authenticated
  USING (public.has_permission('workflow_templates.write'))
  WITH CHECK (public.has_permission('workflow_templates.write'));


ALTER TABLE public.workflow_template_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_template_steps_select ON public.workflow_template_steps;
CREATE POLICY workflow_template_steps_select ON public.workflow_template_steps FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.workflow_templates t
       WHERE t.id = template_id
         AND (t.active = true OR public.has_permission('workflow_templates.write'))
    )
  );

DROP POLICY IF EXISTS workflow_template_steps_write ON public.workflow_template_steps;
CREATE POLICY workflow_template_steps_write ON public.workflow_template_steps FOR ALL
  TO authenticated
  USING (public.has_permission('workflow_templates.write'))
  WITH CHECK (public.has_permission('workflow_templates.write'));

GRANT SELECT ON public.workflow_templates, public.workflow_template_steps TO authenticated;

-- =====================================================================
-- 5. Governance contracts
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.workflow_templates',      'table', 'userportal',
   ARRAY['userportal']::text[], 'Master workflow definition table',   false),
  ('public.workflow_template_steps', 'table', 'userportal',
   ARRAY['userportal']::text[], 'Step list for each workflow template', false)
ON CONFLICT (contract_name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
