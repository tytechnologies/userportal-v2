# Post-Signing Document Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a per-deal, sequentially-gated upload workflow that walks brokers through the Philippines post-signing document sequence (BIR taxes → CAR → transfer tax → title transfer → tax declaration), with a 3-step lease stub and condo-vs-land branching.

**Architecture:** Four new tables — `workflow_templates` + `workflow_template_steps` (master, seeded, admin-editable) and `deal_workflows` + `deal_workflow_steps` (per-deal frozen snapshot). State transitions go through three `SECURITY DEFINER` RPCs that piggyback on the existing `deal_can_read`/`deal_can_write` helpers and write to `public.activities` for audit. UI is one kickoff card + one stepper panel mounted on `/deals/[id]`. Uploads reuse the existing `documents` table; deal-document RLS already covers them.

**Tech Stack:** Postgres (Supabase), Vue 3 / Nuxt 4, Vitest + Playwright, `defineApiHandler` + repository pattern.

**Spec:** `docs/superpowers/specs/2026-05-12-post-signing-document-workflow-design.md`

---

## File Map

**Migrations (sequential, four files):**
- Create: `supabase/migrations/20260512000001_workflow_templates_tables.sql` — master schema, permissions, RLS
- Create: `supabase/migrations/20260512000002_workflow_templates_seed.sql` — seeded sale_transfer_v1 + lease_v1
- Create: `supabase/migrations/20260512000003_deal_workflows_tables.sql` — per-deal snapshot tables, RLS (SELECT-only)
- Create: `supabase/migrations/20260512000004_deal_workflows_rpcs.sql` — three SECURITY DEFINER RPCs

**Test scripts:**
- Create: `scripts/test-workflow-rpcs.mjs` — exercise RPCs against the linked DB; runs alongside `check:migrations` in CI

**Server (Nuxt route handlers + repo):**
- Create: `server/repositories/workflows.repo.ts` — read functions + RPC pass-throughs
- Create: `server/api/deals/[id]/workflow.get.ts`
- Create: `server/api/deals/[id]/workflow/start.post.ts`
- Create: `server/api/deals/[id]/workflow/advance.post.ts`
- Create: `server/api/deals/[id]/workflow/abandon.post.ts`

**App (Vue components):**
- Create: `app/components/deals/DealWorkflowStepRow.vue` — single step (status-aware)
- Create: `app/components/deals/DealWorkflowPanel.vue` — stepper container + realtime sub
- Create: `app/components/deals/DealWorkflowKickoffCard.vue` — start-or-not card
- Modify: `app/pages/deals/[id].vue` — mount kickoff + panel
- Modify: `app/components/deals/DealsPipelineCard.vue` — kanban progress chip

**E2E tests (Playwright):**
- Create: `tests/e2e/workflow-sale-condo.spec.ts` — full sale-condo flow happy path
- Create: `tests/e2e/workflow-lease.spec.ts` — lease stub
- Create: `tests/e2e/workflow-abandon.spec.ts` — admin abandon → broker restart

Each file has one clear responsibility; tight boundaries; nothing else mutates these files in the plan.

---

## Task 1: Master Schema Migration

**Files:**
- Create: `supabase/migrations/20260512000001_workflow_templates_tables.sql`

- [ ] **Step 1: Write the migration file**

```sql
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
```

- [ ] **Step 2: Run the migration locally**

Run: `pnpm check:migrations` (reports as pending), then apply via the Supabase CLI or dashboard.

After apply, verify with: `pnpm check:migrations` again — should show all migrations applied.

Expected: zero pending migrations.

- [ ] **Step 3: Smoke-test schema in psql**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name LIKE 'workflow_%';
-- workflow_templates, workflow_template_steps

SELECT name FROM public.permissions WHERE category='workflow';
-- 3 rows: workflow_templates.write, workflow_templates.read.all, deal_workflows.abandon
```

Expected: 2 tables, 3 permissions present.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260512000001_workflow_templates_tables.sql
git commit -m "feat(db): workflow_templates + workflow_template_steps master tables"
```

---

## Task 2: Seed Templates

**Files:**
- Create: `supabase/migrations/20260512000002_workflow_templates_seed.sql`

- [ ] **Step 1: Write the seed migration**

```sql
-- Seed: sale_transfer_v1 + lease_v1 workflow templates.
--
-- Idempotent (ON CONFLICT DO NOTHING). Re-runs safely.
-- Step text is editable post-seed via SQL or future admin UI;
-- `key` is immutable (appears in documents.document_type +
-- activities.metadata).
--
-- See: docs/superpowers/specs/2026-05-12-post-signing-document-workflow-design.md
--
-- ROLLBACK:
--   DELETE FROM public.workflow_template_steps
--    WHERE template_id IN (SELECT id FROM public.workflow_templates
--                          WHERE key IN ('sale_transfer_v1','lease_v1'));
--   DELETE FROM public.workflow_templates WHERE key IN ('sale_transfer_v1','lease_v1');

-- =====================================================================
-- 1. sale_transfer_v1
-- =====================================================================

INSERT INTO public.workflow_templates (key, title, description, applies_to, active)
VALUES (
  'sale_transfer_v1',
  'Sale transfer documents',
  'Post-signing document upload workflow for property sale transfers: BIR taxes (CGT, DST), the BIR-issued CAR, provincial transfer tax, title transfer (CCT for condo / TCT for land), and final tax declaration in the buyer''s name.',
  'sale',
  true
)
ON CONFLICT (key) DO NOTHING;

-- Seed steps. attestation_text is "I confirm this is the correct <title> for this deal."
-- pre-substituted per row so the runtime doesn't have to template.

WITH t AS (
  SELECT id FROM public.workflow_templates WHERE key = 'sale_transfer_v1'
)
INSERT INTO public.workflow_template_steps
  (template_id, step_index, key, title, description, phase, branch, attestation_text)
SELECT t.id, v.step_index, v.key, v.title, v.description, v.phase, v.branch, v.attestation_text
FROM t, (VALUES
  ( 1, 'cgt_computation',
       'Computation of Capital Gains Tax (CGT)',
       'Upload the CGT computation for this sale. Required by the BIR before they will issue the CAR.',
       'bir_taxes', 'always',
       'I confirm this is the correct Computation of Capital Gains Tax (CGT) for this deal.'),
  ( 2, 'dst_computation',
       'Computation of Documentary Stamp Tax (DST)',
       'Upload the DST computation for this sale.',
       'bir_taxes', 'always',
       'I confirm this is the correct Computation of Documentary Stamp Tax (DST) for this deal.'),
  ( 3, 'bir_car_issued',
       'BIR-issued CAR (Certificate Authorizing Registration)',
       'Upload the BIR-issued CAR. Required to proceed to transfer tax + registration.',
       'bir_taxes', 'always',
       'I confirm this is the correct BIR-issued CAR for this deal.'),
  ( 4, 'transfer_tax_payment',
       'Transfer Tax computation & payment',
       'Upload the transfer tax computation and the proof of payment.',
       'transfer_tax', 'always',
       'I confirm this is the correct Transfer Tax computation & payment for this deal.'),
  ( 5, 'cct_original',
       'Original Copy of CCT',
       'Surrender the seller''s original Condominium Certificate of Title to the Register of Deeds. Upload a scan/photo for our records.',
       'title_transfer', 'condo_only',
       'I confirm this is the correct Original Copy of CCT for this deal.'),
  ( 6, 'cct_certified_true_copy',
       'Certified True Copy of CCT',
       'Upload the certified true copy of the new CCT issued in the buyer''s name.',
       'title_transfer', 'condo_only',
       'I confirm this is the correct Certified True Copy of CCT for this deal.'),
  ( 7, 'car_original',
       'Original Copy of Certificate of Authorizing Registration',
       'Upload the original BIR CAR document presented to the Register of Deeds.',
       'title_transfer', 'always',
       'I confirm this is the correct Original Copy of Certificate of Authorizing Registration for this deal.'),
  ( 8, 'car_certified_true_copy',
       'Certified True Copy of Certificate of Authorizing Registration',
       'Upload the certified true copy of the CAR.',
       'title_transfer', 'always',
       'I confirm this is the correct Certified True Copy of Certificate of Authorizing Registration for this deal.'),
  ( 9, 'tct_filed',
       'Transfer of Certificate of Title (TCT)',
       'Upload the filed TCT transfer paperwork.',
       'title_transfer', 'land_only',
       'I confirm this is the correct Transfer of Certificate of Title (TCT) for this deal.'),
  (10, 'property_title',
       'Property Title',
       'Upload the new property title issued in the buyer''s name.',
       'title_transfer', 'land_only',
       'I confirm this is the correct Property Title for this deal.'),
  (11, 'title_certified_true_copies',
       'Certified True Copies of the Title',
       'Upload certified true copies of the new title.',
       'title_transfer', 'land_only',
       'I confirm this is the correct Certified True Copies of the Title for this deal.'),
  (12, 'original_documents_transmittal',
       'Transmittal of unit''s Original Documents to new Owner',
       'Upload the transmittal receipt for the original documents handed over to the new owner.',
       'title_transfer', 'always',
       'I confirm this is the correct Transmittal of unit''s Original Documents to new Owner for this deal.'),
  (13, 'real_property_declaration',
       'Original Copy of Declaration of Real Property',
       'Upload the original Declaration of Real Property.',
       'tax_declaration', 'always',
       'I confirm this is the correct Original Copy of Declaration of Real Property for this deal.'),
  (14, 'rpt_non_delinquency_certified',
       'Certified True Copy of Certificate of Non-Delinquency on Real Property Tax',
       'Upload the certified true copy of the non-delinquency certificate.',
       'tax_declaration', 'always',
       'I confirm this is the correct Certified True Copy of Certificate of Non-Delinquency on Real Property Tax for this deal.'),
  (15, 'rpt_receipt_updated',
       'Original Copy of Updated Real Property Tax Receipt',
       'Upload the updated RPT receipt.',
       'tax_declaration', 'always',
       'I confirm this is the correct Original Copy of Updated Real Property Tax Receipt for this deal.'),
  (16, 'new_tax_declaration_buyer',
       'New Tax Declaration under Buyer''s name',
       'Upload the new tax declaration issued under the buyer''s name. Final step.',
       'tax_declaration', 'always',
       'I confirm this is the correct New Tax Declaration under Buyer''s name for this deal.')
) AS v(step_index, key, title, description, phase, branch, attestation_text)
ON CONFLICT (template_id, key) DO NOTHING;

-- =====================================================================
-- 2. lease_v1
-- =====================================================================

INSERT INTO public.workflow_templates (key, title, description, applies_to, active)
VALUES (
  'lease_v1',
  'Lease documents',
  'Post-signing document checklist for rental/lease deals: signed lease, tenant ID, deposit/advance receipts.',
  'lease',
  true
)
ON CONFLICT (key) DO NOTHING;

WITH t AS (
  SELECT id FROM public.workflow_templates WHERE key = 'lease_v1'
)
INSERT INTO public.workflow_template_steps
  (template_id, step_index, key, title, description, phase, branch, attestation_text)
SELECT t.id, v.step_index, v.key, v.title, v.description, v.phase, 'always', v.attestation_text
FROM t, (VALUES
  (1, 'signed_lease_contract',
      'Signed lease contract (final executed copy)',
      'Upload the signed and dated lease contract.',
      'lease_documents',
      'I confirm this is the correct Signed lease contract (final executed copy) for this deal.'),
  (2, 'tenant_valid_id',
      'Tenant''s valid government ID',
      'Upload a scan/photo of the tenant''s valid government-issued ID.',
      'lease_documents',
      'I confirm this is the correct Tenant''s valid government ID for this deal.'),
  (3, 'security_deposit_receipt',
      'Proof of security deposit + advance rent payment',
      'Upload the receipt(s) for the security deposit and advance rent payment.',
      'lease_documents',
      'I confirm this is the correct Proof of security deposit + advance rent payment for this deal.')
) AS v(step_index, key, title, description, phase, attestation_text)
ON CONFLICT (template_id, key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply the migration**

Apply via Supabase CLI / dashboard.

- [ ] **Step 3: Smoke-test seed**

```sql
SELECT key, applies_to, active FROM public.workflow_templates ORDER BY key;
-- lease_v1, lease, true
-- sale_transfer_v1, sale, true

SELECT count(*) FROM public.workflow_template_steps
  WHERE template_id = (SELECT id FROM public.workflow_templates WHERE key='sale_transfer_v1');
-- 16

SELECT count(*) FROM public.workflow_template_steps
  WHERE template_id = (SELECT id FROM public.workflow_templates WHERE key='lease_v1');
-- 3

-- Verify branch distribution on sale template
SELECT branch, count(*) FROM public.workflow_template_steps
 WHERE template_id = (SELECT id FROM public.workflow_templates WHERE key='sale_transfer_v1')
 GROUP BY branch ORDER BY branch;
-- always, 11
-- condo_only, 2
-- land_only, 3
```

Expected: counts match exactly (16 sale, 3 lease; 11 always + 2 condo + 3 land).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260512000002_workflow_templates_seed.sql
git commit -m "feat(db): seed sale_transfer_v1 + lease_v1 workflow templates"
```

---

## Task 3: Per-Deal Tables Migration

**Files:**
- Create: `supabase/migrations/20260512000003_deal_workflows_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply migration**

Apply via Supabase CLI / dashboard. Verify with `pnpm check:migrations` (zero pending).

- [ ] **Step 3: Smoke-test schema**

```sql
-- Tables exist
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public'
   AND table_name IN ('deal_workflows','deal_workflow_steps');
-- both rows present

-- Direct INSERT should fail (RLS blocks)
INSERT INTO public.deal_workflows (deal_id, template_key, started_via)
VALUES (gen_random_uuid(), 'sale_transfer_v1', 'manual');
-- ERROR: new row violates row-level security policy
```

Expected: tables exist; direct insert rejected by RLS.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260512000003_deal_workflows_tables.sql
git commit -m "feat(db): deal_workflows + deal_workflow_steps snapshot tables"
```

---

## Task 4: RPCs

**Files:**
- Create: `supabase/migrations/20260512000004_deal_workflows_rpcs.sql`

- [ ] **Step 1: Write the RPCs migration**

```sql
-- Three SECURITY DEFINER RPCs that own the deal workflow state machine.
-- Pattern mirrors envelope_send / envelope_recipient_advance /
-- envelope_void in 20260507000048_document_envelopes.sql.
--
-- See: docs/superpowers/specs/2026-05-12-post-signing-document-workflow-design.md
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.deal_workflow_start(uuid, text, text, text, uuid);
--   DROP FUNCTION IF EXISTS public.deal_workflow_advance(uuid, uuid, text);
--   DROP FUNCTION IF EXISTS public.deal_workflow_abandon(uuid, text);


-- =====================================================================
-- 1. deal_workflow_start
-- =====================================================================
CREATE OR REPLACE FUNCTION public.deal_workflow_start(
  p_deal_id      uuid,
  p_template_key text,
  p_title_branch text,             -- 'condo' | 'land' | NULL (lease)
  p_started_via  text,             -- 'envelope_auto' | 'manual'
  p_envelope_id  uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template      record;
  v_workflow_id   uuid;
  v_first_step_id uuid;
  v_step_count    int;
BEGIN
  IF NOT (
    public.deal_can_write(p_deal_id)
    OR session_user IN ('postgres','supabase_admin','service_role')
  ) THEN
    RAISE EXCEPTION 'deal_workflow_start: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_started_via NOT IN ('envelope_auto','manual') THEN
    RAISE EXCEPTION 'deal_workflow_start: invalid started_via %', p_started_via;
  END IF;

  IF p_title_branch IS NOT NULL AND p_title_branch NOT IN ('condo','land') THEN
    RAISE EXCEPTION 'deal_workflow_start: invalid title_branch %', p_title_branch;
  END IF;

  IF EXISTS (SELECT 1 FROM public.deal_workflows WHERE deal_id = p_deal_id) THEN
    RAISE EXCEPTION 'deal_workflow_start: workflow already exists for this deal'
      USING ERRCODE = '23505';
  END IF;

  SELECT id, key, applies_to, active INTO v_template
    FROM public.workflow_templates WHERE key = p_template_key;
  IF NOT FOUND OR v_template.active = false THEN
    RAISE EXCEPTION 'deal_workflow_start: template % not found or not active', p_template_key
      USING ERRCODE = 'P0002';
  END IF;

  -- Sale templates must have a title_branch; lease must NOT.
  IF v_template.applies_to = 'sale' AND p_title_branch IS NULL THEN
    RAISE EXCEPTION 'deal_workflow_start: sale workflows require title_branch (condo|land)';
  END IF;
  IF v_template.applies_to = 'lease' AND p_title_branch IS NOT NULL THEN
    RAISE EXCEPTION 'deal_workflow_start: lease workflows do not take a title_branch';
  END IF;

  -- Insert workflow shell. current_step_id filled below after snapshotting.
  INSERT INTO public.deal_workflows
    (deal_id, template_id, template_key, title_branch, status,
     started_via, envelope_id, started_by, started_at)
  VALUES
    (p_deal_id, v_template.id, p_template_key, p_title_branch, 'active',
     p_started_via, p_envelope_id, auth.uid(), now())
  RETURNING id INTO v_workflow_id;

  -- Snapshot every template step. Branch filter sets land_only/condo_only
  -- steps that don't match to 'skipped'; the first matching step becomes
  -- 'active'; the rest stay 'locked'.
  INSERT INTO public.deal_workflow_steps
    (workflow_id, step_index, key, title, description, phase, attestation_text,
     status, skip_reason)
  SELECT
    v_workflow_id,
    ts.step_index,
    ts.key,
    ts.title,
    ts.description,
    ts.phase,
    ts.attestation_text,
    CASE
      WHEN ts.branch = 'always'                                        THEN 'locked'
      WHEN ts.branch = 'condo_only' AND p_title_branch = 'condo'       THEN 'locked'
      WHEN ts.branch = 'land_only'  AND p_title_branch = 'land'        THEN 'locked'
      ELSE 'skipped'
    END,
    CASE
      WHEN ts.branch = 'condo_only' AND p_title_branch <> 'condo'
        THEN 'title_branch=' || coalesce(p_title_branch,'NULL') || '; step requires condo'
      WHEN ts.branch = 'land_only'  AND p_title_branch <> 'land'
        THEN 'title_branch=' || coalesce(p_title_branch,'NULL') || '; step requires land'
      ELSE NULL
    END
  FROM public.workflow_template_steps ts
  WHERE ts.template_id = v_template.id
  ORDER BY ts.step_index;

  -- Promote the first non-skipped step to 'active'.
  UPDATE public.deal_workflow_steps
     SET status = 'active'
   WHERE id = (
     SELECT id FROM public.deal_workflow_steps
      WHERE workflow_id = v_workflow_id
        AND status = 'locked'
      ORDER BY step_index ASC
      LIMIT 1
   )
  RETURNING id INTO v_first_step_id;

  IF v_first_step_id IS NULL THEN
    -- Template had zero non-skipped steps — pathological but possible
    -- with a misconfigured branch on a single-step template.
    UPDATE public.deal_workflows
       SET status='completed', completed_at=now()
     WHERE id = v_workflow_id;
  ELSE
    UPDATE public.deal_workflows
       SET current_step_id = v_first_step_id
     WHERE id = v_workflow_id;
  END IF;

  SELECT count(*) INTO v_step_count
    FROM public.deal_workflow_steps WHERE workflow_id = v_workflow_id;

  PERFORM public.log_activity(
    'deal_workflow_started',
    'deal',
    p_deal_id,
    jsonb_build_object(
      'workflow_id',   v_workflow_id,
      'template_key',  p_template_key,
      'title_branch',  p_title_branch,
      'started_via',   p_started_via,
      'envelope_id',   p_envelope_id,
      'step_count',    v_step_count
    )
  );

  RETURN v_workflow_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.deal_workflow_start(uuid, text, text, text, uuid) TO authenticated;


-- =====================================================================
-- 2. deal_workflow_advance
-- =====================================================================
CREATE OR REPLACE FUNCTION public.deal_workflow_advance(
  p_step_id               uuid,
  p_document_id           uuid,
  p_attestation_signature text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_step       record;
  v_workflow   record;
  v_next_id    uuid;
  v_completed_at timestamptz := now();
BEGIN
  -- Lock the workflow row to serialize concurrent advances.
  SELECT s.*, w.deal_id AS w_deal_id, w.status AS w_status, w.id AS w_id
    INTO v_step
  FROM public.deal_workflow_steps s
  JOIN public.deal_workflows w ON w.id = s.workflow_id
  WHERE s.id = p_step_id
  FOR UPDATE OF w;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal_workflow_advance: step % not found', p_step_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.deal_can_write(v_step.w_deal_id)
    OR session_user IN ('postgres','supabase_admin','service_role')
  ) THEN
    RAISE EXCEPTION 'deal_workflow_advance: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF v_step.w_status <> 'active' THEN
    RAISE EXCEPTION 'deal_workflow_advance: workflow is %, cannot advance', v_step.w_status;
  END IF;

  IF v_step.status <> 'active' THEN
    RAISE EXCEPTION 'deal_workflow_advance: step is %, only active steps can advance', v_step.status;
  END IF;

  IF coalesce(p_attestation_signature,'') = '' THEN
    RAISE EXCEPTION 'deal_workflow_advance: attestation_signature is required';
  END IF;

  -- Document must exist and belong to the same deal.
  IF NOT EXISTS (
    SELECT 1 FROM public.documents
     WHERE id = p_document_id AND deal_id = v_step.w_deal_id
  ) THEN
    RAISE EXCEPTION 'deal_workflow_advance: document does not belong to this deal';
  END IF;

  -- Complete the step.
  UPDATE public.deal_workflow_steps
     SET status                = 'completed',
         document_id           = p_document_id,
         attested_at           = v_completed_at,
         attested_by           = auth.uid(),
         attestation_signature = p_attestation_signature,
         completed_at          = v_completed_at
   WHERE id = p_step_id;

  -- Find next locked step (skipped rows naturally fall through).
  SELECT id INTO v_next_id
  FROM public.deal_workflow_steps
  WHERE workflow_id = v_step.workflow_id
    AND status = 'locked'
    AND step_index > v_step.step_index
  ORDER BY step_index ASC
  LIMIT 1;

  IF v_next_id IS NULL THEN
    -- Workflow complete.
    UPDATE public.deal_workflows
       SET status='completed',
           current_step_id=NULL,
           completed_at=v_completed_at
     WHERE id = v_step.workflow_id;

    PERFORM public.log_activity(
      'deal_workflow_completed',
      'deal',
      v_step.w_deal_id,
      jsonb_build_object(
        'workflow_id', v_step.workflow_id,
        'completed_at', v_completed_at,
        'final_step_key', v_step.key
      )
    );
    RETURN NULL;
  END IF;

  -- Advance pointer + activate next step.
  UPDATE public.deal_workflow_steps
     SET status = 'active'
   WHERE id = v_next_id;

  UPDATE public.deal_workflows
     SET current_step_id = v_next_id
   WHERE id = v_step.workflow_id;

  PERFORM public.log_activity(
    'deal_workflow_step_completed',
    'deal',
    v_step.w_deal_id,
    jsonb_build_object(
      'workflow_id',         v_step.workflow_id,
      'completed_step_key',  v_step.key,
      'next_step_id',        v_next_id,
      'step_index',          v_step.step_index
    )
  );

  RETURN v_next_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.deal_workflow_advance(uuid, uuid, text) TO authenticated;


-- =====================================================================
-- 3. deal_workflow_abandon
-- =====================================================================
CREATE OR REPLACE FUNCTION public.deal_workflow_abandon(
  p_workflow_id uuid,
  p_reason      text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workflow record;
  v_active_step record;
BEGIN
  SELECT * INTO v_workflow FROM public.deal_workflows WHERE id = p_workflow_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal_workflow_abandon: workflow % not found', p_workflow_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.deal_can_write(v_workflow.deal_id)
    OR public.has_permission('deal_workflows.abandon')
    OR session_user IN ('postgres','supabase_admin','service_role')
  ) THEN
    RAISE EXCEPTION 'deal_workflow_abandon: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF v_workflow.status IN ('completed','abandoned') THEN
    RAISE EXCEPTION 'deal_workflow_abandon: workflow is in terminal status %', v_workflow.status;
  END IF;

  IF coalesce(p_reason,'') = '' THEN
    RAISE EXCEPTION 'deal_workflow_abandon: reason is required';
  END IF;

  -- Capture the step we were on for the audit row.
  SELECT step_index, key INTO v_active_step
    FROM public.deal_workflow_steps
   WHERE id = v_workflow.current_step_id;

  UPDATE public.deal_workflows
     SET status='abandoned',
         abandoned_at=now(),
         abandon_reason=p_reason
   WHERE id = p_workflow_id;

  PERFORM public.log_activity(
    'deal_workflow_abandoned',
    'deal',
    v_workflow.deal_id,
    jsonb_build_object(
      'workflow_id', p_workflow_id,
      'reason', p_reason,
      'abandoned_at_step_index', v_active_step.step_index,
      'abandoned_at_step_key',   v_active_step.key
    )
  );

  RETURN p_workflow_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.deal_workflow_abandon(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply migration**

Apply via Supabase CLI / dashboard.

- [ ] **Step 3: Smoke-test RPCs exist**

```sql
SELECT proname FROM pg_proc
 WHERE proname LIKE 'deal_workflow_%';
-- deal_workflow_advance, deal_workflow_abandon, deal_workflow_start
```

Expected: 3 functions present.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260512000004_deal_workflows_rpcs.sql
git commit -m "feat(db): SECURITY DEFINER RPCs for deal workflow state machine"
```

---

## Task 5: SQL-level RPC Test Script

**Files:**
- Create: `scripts/test-workflow-rpcs.mjs`

- [ ] **Step 1: Write the failing test script**

```javascript
#!/usr/bin/env node
// scripts/test-workflow-rpcs.mjs
//
// Exercises the deal workflow RPCs against the linked Supabase DB.
// Same env discipline as scripts/check-migrations.mjs.
//
// Usage:
//   pnpm test:workflow-rpcs
//
// Exit codes:
//   0  all assertions pass
//   1  one or more failed
//   2  configuration / connection error

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

function readEnv(name) {
  if (process.env[name]) return process.env[name]
  try {
    const envFile = fs.readFileSync(path.resolve('.env'), 'utf8')
    const match = envFile.match(new RegExp(`^${name}=(.+)$`, 'm'))
    return match ? match[1].replace(/^["']|["']$/g, '').trim() : ''
  } catch {
    return ''
  }
}

const url = readEnv('SUPABASE_URL')
const key = readEnv('SUPABASE_SERVICE_KEY') || readEnv('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) {
  console.error('Missing SUPABASE_URL or service key')
  process.exit(2)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else      { failed++; console.error(`  ✗ ${msg}`) }
}

async function setup() {
  // Create a throwaway deal owned by the first admin profile we can find.
  // Avoids RLS on the SELECT by using service-role.
  const { data: admin } = await sb.from('profiles').select('id').limit(1).maybeSingle()
  if (!admin?.id) throw new Error('No profiles available in DB')
  // Need a listing FK target.
  const { data: listing } = await sb.from('listings').select('id').limit(1).maybeSingle()
  if (!listing?.id) throw new Error('No listings available in DB')
  const { data: deal, error } = await sb.from('deals').insert({
    listing_id: listing.id,
    stage_key: 'documentation',
    title: '__test_workflow_rpcs_' + Date.now(),
    buyer_agent_user_id: admin.id,
    created_by: admin.id,
  }).select('id').single()
  if (error) throw error
  return deal.id
}

async function teardown(dealId) {
  // Cleanup is best-effort. CASCADE on deal_workflows -> deal_workflow_steps
  // and on deals -> deal_workflows handles the dependents.
  await sb.from('deals').delete().eq('id', dealId)
}

async function testHappyPathCondo(dealId) {
  console.log('\n• sale_transfer_v1 / condo happy path')
  const { data: wfId, error } = await sb.rpc('deal_workflow_start', {
    p_deal_id: dealId,
    p_template_key: 'sale_transfer_v1',
    p_title_branch: 'condo',
    p_started_via: 'manual',
    p_envelope_id: null,
  })
  assert(!error && wfId, 'deal_workflow_start returns workflow_id')

  const { data: steps } = await sb.from('deal_workflow_steps')
    .select('step_index, status, key, branch:phase')   // include phase for context
    .eq('workflow_id', wfId).order('step_index')

  // 16 total; 3 skipped (land_only); 1 active (step_index=1, cgt_computation); rest locked.
  assert(steps.length === 16, '16 step rows snapshotted')
  assert(steps.filter(s => s.status === 'skipped').length === 3, '3 land_only steps skipped')
  assert(steps[0].status === 'active' && steps[0].key === 'cgt_computation',
         'first step is active = cgt_computation')

  // Advance through every non-skipped step.
  // We need a real documents row per step. Create one quickly per step.
  const { data: anyUser } = await sb.from('profiles').select('id').limit(1).maybeSingle()
  const nonSkipped = steps.filter(s => s.status !== 'skipped')
  for (let i = 0; i < nonSkipped.length; i++) {
    const stepRow = nonSkipped[i]
    // Refetch step id (we only selected step_index above)
    const { data: stepFull } = await sb.from('deal_workflow_steps')
      .select('id, attestation_text')
      .eq('workflow_id', wfId).eq('step_index', stepRow.step_index).maybeSingle()
    const { data: doc, error: docErr } = await sb.from('documents').insert({
      created_by: anyUser.id,
      document_type: `workflow_step_${stepRow.key ?? 'unknown'}`,
      s3_key: `test/${Date.now()}-${i}.pdf`,
      file_name: `step-${stepRow.step_index}.pdf`,
      deal_id: dealId,
    }).select('id').single()
    if (docErr) throw docErr
    const { data: nextId, error: advErr } = await sb.rpc('deal_workflow_advance', {
      p_step_id: stepFull.id,
      p_document_id: doc.id,
      p_attestation_signature: stepFull.attestation_text,
    })
    assert(!advErr, `advance step_index=${stepRow.step_index} succeeds`)
    if (i < nonSkipped.length - 1) {
      assert(nextId, `advance returns next step id (i=${i})`)
    } else {
      assert(nextId === null, 'final advance returns NULL')
    }
  }

  const { data: wf } = await sb.from('deal_workflows').select('status').eq('id', wfId).maybeSingle()
  assert(wf.status === 'completed', 'workflow status=completed')
}

async function testDuplicateStart(dealId) {
  console.log('\n• duplicate start is rejected')
  const { error } = await sb.rpc('deal_workflow_start', {
    p_deal_id: dealId,
    p_template_key: 'sale_transfer_v1',
    p_title_branch: 'land',
    p_started_via: 'manual',
    p_envelope_id: null,
  })
  assert(!!error, 'second deal_workflow_start raises (workflow already exists)')
}

async function testLeaseFlow() {
  console.log('\n• lease_v1 happy path')
  const dealId = await setup()
  try {
    const { data: wfId } = await sb.rpc('deal_workflow_start', {
      p_deal_id: dealId,
      p_template_key: 'lease_v1',
      p_title_branch: null,
      p_started_via: 'manual',
      p_envelope_id: null,
    })
    const { data: steps } = await sb.from('deal_workflow_steps')
      .select('step_index, status').eq('workflow_id', wfId).order('step_index')
    assert(steps.length === 3, 'lease has 3 steps')
    assert(steps.filter(s => s.status === 'skipped').length === 0, 'lease has no skipped steps')
    assert(steps[0].status === 'active', 'first lease step is active')
  } finally { await teardown(dealId) }
}

async function testAbandon() {
  console.log('\n• abandon mid-flow')
  const dealId = await setup()
  try {
    const { data: wfId } = await sb.rpc('deal_workflow_start', {
      p_deal_id: dealId,
      p_template_key: 'sale_transfer_v1',
      p_title_branch: 'condo',
      p_started_via: 'manual',
      p_envelope_id: null,
    })
    const { error } = await sb.rpc('deal_workflow_abandon', {
      p_workflow_id: wfId, p_reason: 'wrong branch picked',
    })
    assert(!error, 'abandon succeeds')
    const { data: wf } = await sb.from('deal_workflows').select('status').eq('id', wfId).maybeSingle()
    assert(wf.status === 'abandoned', 'status=abandoned')

    const { error: abandonAgain } = await sb.rpc('deal_workflow_abandon', {
      p_workflow_id: wfId, p_reason: 'again',
    })
    assert(!!abandonAgain, 'second abandon is rejected (terminal)')
  } finally { await teardown(dealId) }
}

async function main() {
  console.log('Running deal workflow RPC tests…')
  const dealId = await setup()
  try {
    await testHappyPathCondo(dealId)
    await testDuplicateStart(dealId)
  } finally { await teardown(dealId) }

  await testLeaseFlow()
  await testAbandon()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
```

- [ ] **Step 2: Add npm script**

Edit `package.json`, add to `"scripts"`:

```json
"test:workflow-rpcs": "node scripts/test-workflow-rpcs.mjs"
```

- [ ] **Step 3: Run the script — initially all tests pass**

Run: `pnpm test:workflow-rpcs`

Expected output: `N passed, 0 failed` with exit code 0.

If anything fails, debug the RPC migration (Task 4). The script is the canonical regression suite.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-workflow-rpcs.mjs package.json
git commit -m "test(db): script-level coverage for deal workflow RPCs"
```

---

## Task 6: Workflows Repository

**Files:**
- Create: `server/repositories/workflows.repo.ts`

- [ ] **Step 1: Write the repo**

```typescript
// Workflow repository — reads from deal_workflows/deal_workflow_steps and
// proxies RPC calls. Mirrors the pattern in server/repositories/deals.repo.ts.
//
// All callers must pass an H3 event for serverSupabaseClient(event) to
// pick up the user's session. RLS does the auth lifting on reads;
// SECURITY DEFINER RPCs do it on writes.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

export type WorkflowStep = {
  id: string
  step_index: number
  key: string
  title: string
  description: string | null
  phase: string
  attestation_text: string
  status: 'locked' | 'active' | 'completed' | 'skipped'
  document_id: string | null
  attested_at: string | null
  attested_by: string | null
  attestation_signature: string | null
  completed_at: string | null
  skip_reason: string | null
}

export type Workflow = {
  id: string
  deal_id: string
  template_id: string | null
  template_key: string
  title_branch: 'condo' | 'land' | null
  status: 'active' | 'completed' | 'abandoned'
  current_step_id: string | null
  started_via: 'envelope_auto' | 'manual'
  envelope_id: string | null
  started_by: string | null
  started_at: string
  completed_at: string | null
  abandoned_at: string | null
  abandon_reason: string | null
  steps: WorkflowStep[]
}

export const workflowsRepo = {
  /** Returns the deal's workflow + ordered step list, or null if no workflow exists. */
  async getByDealId({ event, dealId }: { event: H3Event; dealId: string }): Promise<Workflow | null> {
    const supabase = await serverSupabaseClient(event)
    const { data: wf, error } = await (supabase as any)
      .from('deal_workflows')
      .select('*')
      .eq('deal_id', dealId)
      .maybeSingle()
    if (error) throw error
    if (!wf) return null

    const { data: steps, error: stepsErr } = await (supabase as any)
      .from('deal_workflow_steps')
      .select('*')
      .eq('workflow_id', wf.id)
      .order('step_index')
    if (stepsErr) throw stepsErr

    return { ...(wf as Workflow), steps: (steps ?? []) as WorkflowStep[] }
  },

  async start({
    event, dealId, templateKey, titleBranch, startedVia, envelopeId,
  }: {
    event: H3Event
    dealId: string
    templateKey: string
    titleBranch: 'condo' | 'land' | null
    startedVia: 'envelope_auto' | 'manual'
    envelopeId: string | null
  }): Promise<string> {
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('deal_workflow_start', {
      p_deal_id: dealId,
      p_template_key: templateKey,
      p_title_branch: titleBranch,
      p_started_via: startedVia,
      p_envelope_id: envelopeId,
    })
    if (error) throw error
    return data as string
  },

  async advance({
    event, stepId, documentId, attestationSignature,
  }: {
    event: H3Event
    stepId: string
    documentId: string
    attestationSignature: string
  }): Promise<string | null> {
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('deal_workflow_advance', {
      p_step_id: stepId,
      p_document_id: documentId,
      p_attestation_signature: attestationSignature,
    })
    if (error) throw error
    return (data ?? null) as string | null
  },

  async abandon({
    event, workflowId, reason,
  }: {
    event: H3Event
    workflowId: string
    reason: string
  }): Promise<string> {
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('deal_workflow_abandon', {
      p_workflow_id: workflowId,
      p_reason: reason,
    })
    if (error) throw error
    return data as string
  },
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`

Expected: no new errors (file is unused yet but should compile).

- [ ] **Step 3: Commit**

```bash
git add server/repositories/workflows.repo.ts
git commit -m "feat(server): workflows repo — RPC pass-through + reads"
```

---

## Task 7: GET workflow endpoint

**Files:**
- Create: `server/api/deals/[id]/workflow.get.ts`

- [ ] **Step 1: Write the handler**

```typescript
// GET /api/deals/:id/workflow
// Returns null when no workflow exists for the deal.
// RLS via deal_can_read drops non-participants to null naturally.

import { workflowsRepo } from '~~/server/repositories/workflows.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    return await workflowsRepo.getByDealId({ event, dealId: id })
  },
})
```

- [ ] **Step 2: Smoke-test via curl**

Start dev server: `pnpm dev`. With a valid session cookie + a deal id, call:

```
curl http://localhost:3002/api/deals/<deal-id>/workflow -H "Cookie: <auth>"
```

Expected: `null` for a deal without a workflow; the workflow JSON otherwise.

- [ ] **Step 3: Commit**

```bash
git add server/api/deals/[id]/workflow.get.ts
git commit -m "feat(server): GET /api/deals/[id]/workflow"
```

---

## Task 8: POST workflow endpoints

**Files:**
- Create: `server/api/deals/[id]/workflow/start.post.ts`
- Create: `server/api/deals/[id]/workflow/advance.post.ts`
- Create: `server/api/deals/[id]/workflow/abandon.post.ts`

- [ ] **Step 1: Write start.post.ts**

```typescript
// POST /api/deals/:id/workflow/start
// Body: { templateKey, titleBranch?, startedVia, envelopeId? }
// Returns: { workflowId }

import { z } from 'zod'
import { workflowsRepo } from '~~/server/repositories/workflows.repo'

const Body = z.object({
  templateKey: z.string().min(1),
  titleBranch: z.enum(['condo', 'land']).nullable().optional(),
  startedVia: z.enum(['envelope_auto', 'manual']),
  envelopeId: z.string().uuid().nullable().optional(),
})

export default defineApiHandler({
  auth: 'required',
  body: Body,
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    const workflowId = await workflowsRepo.start({
      event,
      dealId: id,
      templateKey: body.templateKey,
      titleBranch: body.titleBranch ?? null,
      startedVia: body.startedVia,
      envelopeId: body.envelopeId ?? null,
    })
    return { workflowId }
  },
})
```

- [ ] **Step 2: Write advance.post.ts**

```typescript
// POST /api/deals/:id/workflow/advance
// Body: { stepId, documentId, attestationSignature }
// Returns: { nextStepId: string | null }
//
// :id is the deal id; we validate the step belongs to the deal's workflow
// inside the RPC (cross-deal binding is rejected there too).

import { z } from 'zod'
import { workflowsRepo } from '~~/server/repositories/workflows.repo'

const Body = z.object({
  stepId: z.string().uuid(),
  documentId: z.string().uuid(),
  attestationSignature: z.string().min(1),
})

export default defineApiHandler({
  auth: 'required',
  body: Body,
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    const nextStepId = await workflowsRepo.advance({
      event,
      stepId: body.stepId,
      documentId: body.documentId,
      attestationSignature: body.attestationSignature,
    })
    return { nextStepId }
  },
})
```

- [ ] **Step 3: Write abandon.post.ts**

```typescript
// POST /api/deals/:id/workflow/abandon
// Body: { workflowId, reason }

import { z } from 'zod'
import { workflowsRepo } from '~~/server/repositories/workflows.repo'

const Body = z.object({
  workflowId: z.string().uuid(),
  reason: z.string().min(1),
})

export default defineApiHandler({
  auth: 'required',
  body: Body,
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid deal id' })
    }
    await workflowsRepo.abandon({
      event,
      workflowId: body.workflowId,
      reason: body.reason,
    })
    return { ok: true }
  },
})
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add server/api/deals/[id]/workflow/start.post.ts \
        server/api/deals/[id]/workflow/advance.post.ts \
        server/api/deals/[id]/workflow/abandon.post.ts
git commit -m "feat(server): POST workflow start / advance / abandon endpoints"
```

---

## Task 9: DealWorkflowStepRow.vue

**Files:**
- Create: `app/components/deals/DealWorkflowStepRow.vue`

- [ ] **Step 1: Write the component**

```vue
<script setup lang="ts">
/**
 * One row in the deal workflow stepper. Three visual variants:
 *   - `completed`: ✓ + collapsed summary. Click to expand for doc preview.
 *   - `active`:    full upload + attestation + advance affordance.
 *   - `locked`:    🔒 + label only.
 *  `skipped` rows are filtered out by the parent and never rendered.
 */
import { ref, computed } from 'vue'
import { showToast } from '~/helpers/helpers'
import type { WorkflowStep } from '~~/server/repositories/workflows.repo'

const props = defineProps<{
  dealId: string
  step: WorkflowStep
}>()
const emit = defineEmits<{
  /** Emitted on successful advance — parent re-fetches workflow. */
  (e: 'advanced', payload: { nextStepId: string | null }): void
}>()

const file = ref<File | null>(null)
const uploadedDocId = ref<string | null>(null)
const attestChecked = ref(false)
const submitting = ref(false)
const expanded = ref(false)

const canAdvance = computed(
  () => props.step.status === 'active' && !!uploadedDocId.value && attestChecked.value,
)

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  const picked = target.files?.[0]
  if (!picked) return
  file.value = picked
  uploadedDocId.value = null
  // Upload via the existing documents pipeline. document_type carries the
  // workflow step key so future analytics can filter cleanly.
  const fd = new FormData()
  fd.append('file', picked)
  fd.append('deal_id', props.dealId)
  fd.append('document_type', `workflow_step_${props.step.key}`)
  try {
    submitting.value = true
    const res = await $fetch<{ id: string }>('/api/documents/upload', {
      method: 'POST',
      body: fd,
    })
    uploadedDocId.value = res.id
    showToast({ title: 'File uploaded.', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Upload failed',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

async function advance() {
  if (!canAdvance.value || !uploadedDocId.value) return
  submitting.value = true
  try {
    const res = await $fetch<{ nextStepId: string | null }>(
      `/api/deals/${props.dealId}/workflow/advance`,
      {
        method: 'POST',
        body: {
          stepId: props.step.id,
          documentId: uploadedDocId.value,
          attestationSignature: props.step.attestation_text,
        },
      },
    )
    emit('advanced', { nextStepId: res.nextStepId })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not save step',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

const statusBadge = computed(() => {
  switch (props.step.status) {
    case 'completed': return { label: '✓', cls: 'bg-success/15 text-success' }
    case 'active':    return { label: '●', cls: 'bg-primary/15 text-primary' }
    case 'locked':    return { label: '🔒', cls: 'bg-muted text-muted-foreground' }
    default:          return { label: '·', cls: 'bg-muted text-muted-foreground' }
  }
})

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <div
    class="rounded-lg border border-border bg-card p-3"
    :class="step.status === 'active' ? 'ring-2 ring-primary/40' : ''"
  >
    <header class="flex items-center gap-2">
      <span class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold" :class="statusBadge.cls">
        {{ statusBadge.label }}
      </span>
      <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Step {{ step.step_index }}
      </span>
      <span class="text-sm font-semibold text-foreground">{{ step.title }}</span>
      <span v-if="step.status === 'completed' && step.completed_at" class="ml-auto text-xs text-muted-foreground">
        {{ formatDate(step.completed_at) }}
      </span>
      <button
        v-if="step.status === 'completed'"
        type="button"
        class="ml-auto text-xs text-muted-foreground hover:text-foreground"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Hide' : 'Details' }}
      </button>
    </header>

    <!-- Active step: upload + attest + advance -->
    <div v-if="step.status === 'active'" class="mt-3 space-y-3">
      <p v-if="step.description" class="text-sm text-foreground/80">{{ step.description }}</p>
      <div>
        <input
          type="file"
          accept="application/pdf,image/*"
          class="block w-full text-sm text-foreground"
          :disabled="submitting"
          @change="onFileChange"
        />
        <p v-if="uploadedDocId" class="mt-1 text-xs text-success">File uploaded — ready to attest.</p>
      </div>
      <label class="flex items-start gap-2 text-sm text-foreground">
        <input
          v-model="attestChecked"
          type="checkbox"
          class="mt-0.5"
          :disabled="!uploadedDocId || submitting"
        />
        <span>{{ step.attestation_text }}</span>
      </label>
      <button
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
        :disabled="!canAdvance || submitting"
        @click="advance"
      >
        {{ submitting ? 'Saving…' : 'Save & continue' }}
      </button>
    </div>

    <!-- Completed step: show signature when expanded -->
    <div v-else-if="step.status === 'completed' && expanded" class="mt-3 space-y-1 text-xs text-muted-foreground">
      <p><strong>Attested:</strong> {{ step.attestation_signature }}</p>
      <p v-if="step.attested_at"><strong>When:</strong> {{ formatDate(step.attested_at) }}</p>
    </div>

    <!-- Locked: nothing else to show -->
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/deals/DealWorkflowStepRow.vue
git commit -m "feat(deals): DealWorkflowStepRow.vue — single step UI"
```

---

## Task 10: DealWorkflowPanel.vue

**Files:**
- Create: `app/components/deals/DealWorkflowPanel.vue`

- [ ] **Step 1: Write the panel**

```vue
<script setup lang="ts">
/**
 * Deal workflow stepper. Fetches workflow + steps from
 * GET /api/deals/:id/workflow and renders an ordered list of
 * DealWorkflowStepRow components, filtering out 'skipped' rows.
 * Subscribes to realtime updates on deal_workflows so an admin
 * abandon refreshes the panel without manual reload.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import DealWorkflowStepRow from '~/components/deals/DealWorkflowStepRow.vue'
import type { Workflow } from '~~/server/repositories/workflows.repo'

const props = defineProps<{
  dealId: string
  /** True iff the caller has admin/manager privileges to abandon. */
  canAbandon: boolean
}>()
const emit = defineEmits<{
  (e: 'workflow-changed'): void
}>()

const supabase = useSupabaseClient()
const workflow = ref<Workflow | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
let channel: any = null

async function load() {
  loading.value = true
  error.value = null
  try {
    workflow.value = await $fetch<Workflow | null>(`/api/deals/${props.dealId}/workflow`)
  } catch (err: any) {
    error.value = err?.statusMessage || err?.message || 'Failed to load workflow'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  // Realtime: listen for workflow row changes so admin actions reflect live.
  channel = (supabase as any)
    .channel(`deal_workflow_${props.dealId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'deal_workflows', filter: `deal_id=eq.${props.dealId}` },
      () => { void load() },
    )
    .subscribe()
})

onUnmounted(() => {
  if (channel) (supabase as any).removeChannel(channel)
})

watch(() => props.dealId, async () => { await load() })

defineExpose({ refresh: load })

const visibleSteps = computed(() =>
  (workflow.value?.steps ?? []).filter((s) => s.status !== 'skipped'),
)
const completedCount = computed(() =>
  visibleSteps.value.filter((s) => s.status === 'completed').length,
)
const totalVisible = computed(() => visibleSteps.value.length)
const branchLabel = computed(() => {
  if (!workflow.value?.title_branch) return ''
  return workflow.value.title_branch === 'condo' ? 'Condo (CCT)' : 'House/Land (TCT)'
})

async function onAdvanced() {
  await load()
  emit('workflow-changed')
}

async function abandon() {
  if (!workflow.value) return
  const reason = window.prompt('Reason for abandoning this workflow?')
  if (!reason || !reason.trim()) return
  try {
    await $fetch(`/api/deals/${props.dealId}/workflow/abandon`, {
      method: 'POST',
      body: { workflowId: workflow.value.id, reason: reason.trim() },
    })
    showToast({ title: 'Workflow abandoned.', icon: 'success' })
    await load()
    emit('workflow-changed')
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not abandon',
      icon: 'error',
    })
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <section v-if="!loading && workflow" class="rounded-xl border border-border bg-background p-4">
    <header class="mb-4 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Transfer document progress</h3>
        <p class="text-xs text-muted-foreground">
          <template v-if="workflow.status === 'completed'">All steps complete — {{ formatDate(workflow.completed_at) }}</template>
          <template v-else-if="workflow.status === 'abandoned'">
            Workflow abandoned · {{ workflow.abandon_reason }}
          </template>
          <template v-else>
            {{ completedCount }} / {{ totalVisible }} complete
            <span v-if="branchLabel"> · Branch: {{ branchLabel }}</span>
            · Started {{ formatDate(workflow.started_at) }}
          </template>
        </p>
      </div>
      <button
        v-if="canAbandon && workflow.status === 'active'"
        type="button"
        class="text-xs text-destructive hover:underline"
        @click="abandon"
      >
        Abandon
      </button>
    </header>

    <div class="space-y-2">
      <DealWorkflowStepRow
        v-for="step in visibleSteps"
        :key="step.id"
        :deal-id="dealId"
        :step="step"
        @advanced="onAdvanced"
      />
    </div>
  </section>
  <section v-else-if="loading" class="rounded-xl border border-border bg-background p-4">
    <div class="h-4 w-1/2 animate-pulse rounded bg-muted" />
  </section>
  <section v-else-if="error" class="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
    {{ error }}
  </section>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/deals/DealWorkflowPanel.vue
git commit -m "feat(deals): DealWorkflowPanel.vue — stepper + realtime"
```

---

## Task 11: DealWorkflowKickoffCard.vue

**Files:**
- Create: `app/components/deals/DealWorkflowKickoffCard.vue`

- [ ] **Step 1: Write the kickoff card**

```vue
<script setup lang="ts">
/**
 * Shown on /deals/:id when:
 *   - No deal_workflows row exists for this deal, AND
 *   - Either an envelope linked to this deal is in status='completed',
 *     OR the broker clicked the manual entry button.
 *
 * Resolves the right template (sale_transfer_v1 vs lease_v1) from the
 * deal's listing flags (for_sale / for_rent). For sale flows, prompts
 * the operator to pick condo vs land before starting.
 */
import { ref, computed } from 'vue'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  dealId: string
  /** Listing flags — drive template selection. */
  listingForSale: boolean
  listingForRent: boolean
  /** Envelope id if auto-eligible; null for manual. */
  eligibleEnvelopeId: string | null
}>()
const emit = defineEmits<{
  (e: 'started'): void
}>()

const templateKey = computed<'sale_transfer_v1' | 'lease_v1' | null>(() => {
  if (props.listingForSale) return 'sale_transfer_v1'
  if (props.listingForRent) return 'lease_v1'
  return null
})

const isSale = computed(() => templateKey.value === 'sale_transfer_v1')
const titleBranch = ref<'condo' | 'land' | null>(null)
const submitting = ref(false)

const startedVia = computed<'envelope_auto' | 'manual'>(() =>
  props.eligibleEnvelopeId ? 'envelope_auto' : 'manual',
)

const canStart = computed(() => {
  if (!templateKey.value) return false
  if (isSale.value && !titleBranch.value) return false
  return true
})

async function start() {
  if (!canStart.value || !templateKey.value) return
  submitting.value = true
  try {
    await $fetch(`/api/deals/${props.dealId}/workflow/start`, {
      method: 'POST',
      body: {
        templateKey: templateKey.value,
        titleBranch: isSale.value ? titleBranch.value : null,
        startedVia: startedVia.value,
        envelopeId: props.eligibleEnvelopeId,
      },
    })
    showToast({ title: 'Transfer process started.', icon: 'success' })
    emit('started')
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not start workflow',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section
    v-if="templateKey"
    class="rounded-xl border-2 border-primary/40 bg-primary/5 p-5"
  >
    <h3 class="text-lg font-bold text-foreground">🎉 Contract signed!</h3>
    <p class="mt-1 text-sm text-foreground/80">
      <template v-if="isSale">
        Start the transfer-document workflow to track CGT, DST, the BIR-issued CAR,
        transfer tax, title transfer, and final tax declaration. Each step is
        gated by its predecessor.
      </template>
      <template v-else>
        Start the lease document checklist: signed lease, tenant ID, deposit + advance receipts.
      </template>
    </p>

    <fieldset v-if="isSale" class="mt-4 space-y-2">
      <legend class="text-sm font-semibold text-foreground">This deal is for a:</legend>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="titleBranch" type="radio" value="condo" />
        Condo unit (CCT-based title transfer)
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="titleBranch" type="radio" value="land" />
        House / Land (TCT-based title transfer)
      </label>
    </fieldset>

    <button
      type="button"
      class="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
      :disabled="!canStart || submitting"
      @click="start"
    >
      {{ submitting ? 'Starting…' : 'Start transfer process' }}
    </button>
  </section>
  <section v-else class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
    The deal's listing has neither sale nor rent flagged — fix the listing before starting the
    transfer workflow.
  </section>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/deals/DealWorkflowKickoffCard.vue
git commit -m "feat(deals): DealWorkflowKickoffCard.vue — start-or-not card"
```

---

## Task 12: Wire workflow into deal page

**Files:**
- Modify: `app/pages/deals/[id].vue`

- [ ] **Step 1: Inspect current top-of-page region**

Open `app/pages/deals/[id].vue`. Relevant line refs:
- Imports block: lines 20-29
- `<template v-else-if="deal">` opens at line 369
- Header `<UiCard padding="md">` opens at line 371, closes `</UiCard>` at line 412
- Next card (Client) opens at line 418
- Insert workflow components between lines 412 and 418
- `onMounted` is at line 92
- `load()` is at line 56; `errorMsg` declared at line 40

- [ ] **Step 2: Add imports + state**

Add to the import block (after line 29):

```typescript
import DealWorkflowPanel from '~/components/deals/DealWorkflowPanel.vue'
import DealWorkflowKickoffCard from '~/components/deals/DealWorkflowKickoffCard.vue'
import type { Workflow } from '~~/server/repositories/workflows.repo'
```

In the script body, after the `errorMsg` declaration at line 40, add:

```typescript
const workflowState = ref<Workflow | null>(null)
const eligibleEnvelopeId = ref<string | null>(null)
const userRole = ref<string>('agent')

async function loadWorkflowState() {
  try {
    workflowState.value = await $fetch<Workflow | null>(`/api/deals/${dealId.value}/workflow`)
  } catch { workflowState.value = null }
}

async function loadEnvelopeEligibility() {
  if (workflowState.value) { eligibleEnvelopeId.value = null; return }
  const { data } = await (supabase as any)
    .from('document_envelopes')
    .select('id')
    .eq('deal_id', dealId.value)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  eligibleEnvelopeId.value = (data?.id as string) ?? null
}

async function loadUserRole() {
  const { data } = await (supabase as any).rpc('current_user_role')
  userRole.value = (data as string) ?? 'agent'
}

const canAbandonWorkflow = computed(
  () => userRole.value === 'admin' || userRole.value === 'manager',
)

const showKickoff = computed(
  () => !workflowState.value && (eligibleEnvelopeId.value !== null || /* manual */ true),
)

const listingForSale = computed<boolean>(() => Boolean(deal.value?.listing?.for_sale))
const listingForRent = computed<boolean>(() => Boolean(deal.value?.listing?.for_rent))
```

Change the existing `onMounted` at line 92 from:

```typescript
onMounted(() => { load(); loadTimeline() })
```

to:

```typescript
onMounted(async () => {
  load()
  loadTimeline()
  // Workflow state depends on deal loading first only for the `deal.listing.*`
  // flags read by the kickoff card; the workflow + envelope fetches are
  // independent and safe to start in parallel with load().
  await loadWorkflowState()
  await loadEnvelopeEligibility()
  await loadUserRole()
})
```

- [ ] **Step 3: Mount components in the template**

Insert between line 412 (closing `</UiCard>` of the header card) and line 418 (opening `<UiCard>` of the Client card):

```vue
<DealWorkflowPanel
  v-if="workflowState"
  :deal-id="dealId"
  :can-abandon="canAbandonWorkflow"
  @workflow-changed="() => { loadWorkflowState(); loadEnvelopeEligibility() }"
/>
<DealWorkflowKickoffCard
  v-else-if="showKickoff && deal"
  :deal-id="dealId"
  :listing-for-sale="listingForSale"
  :listing-for-rent="listingForRent"
  :eligible-envelope-id="eligibleEnvelopeId"
  @started="() => { loadWorkflowState(); loadEnvelopeEligibility() }"
/>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`

Expected: no new errors.

- [ ] **Step 5: Dev-run smoke test**

```
pnpm dev
```

Open a deal in the browser. Verify:
- No workflow + envelope completed → kickoff card visible.
- Pick branch → click Start → panel appears with step 1 active.
- Upload + attest → next step becomes active.

If anything misbehaves, fix before committing.

- [ ] **Step 6: Commit**

```bash
git add app/pages/deals/[id].vue
git commit -m "feat(deals): mount workflow kickoff + panel on deal detail page"
```

---

## Task 13: Kanban progress chip

**Files:**
- Modify: `app/components/deals/DealsPipelineCard.vue`

- [ ] **Step 1: Inspect the component**

Open `app/components/deals/DealsPipelineCard.vue`. It receives a `deal` prop and renders one kanban tile. We want a small `📋 N/M` chip when an active workflow exists, with M = non-skipped step count and N = completed step count.

The deal API doesn't currently return workflow progress. Cheapest path: a small additional fetch on the card. To avoid N+1 fetches across the entire board, we'll let the parent board batch-fetch progress.

- [ ] **Step 2: Add a batched progress fetch on the board**

Open `app/components/deals/DealsPipelineBoard.vue`. Relevant refs: `load()` at line 94, `onMounted(load)` at line 115. We'll add progress fetching to run after the deals query inside `load()`. Add this state + function near the existing `loading` ref (line 83):

```typescript
const workflowProgressByDealId = ref<Record<string, { completed: number; total: number; status: string }>>({})

async function loadWorkflowProgress(dealIds: string[]) {
  if (dealIds.length === 0) { workflowProgressByDealId.value = {}; return }
  // Pull active+completed workflows; group steps client-side.
  const { data: wfs } = await (supabase as any)
    .from('deal_workflows')
    .select('id, deal_id, status')
    .in('deal_id', dealIds)
  if (!wfs || wfs.length === 0) { workflowProgressByDealId.value = {}; return }
  const wfIds = wfs.map((w: any) => w.id as string)
  const { data: steps } = await (supabase as any)
    .from('deal_workflow_steps')
    .select('workflow_id, status')
    .in('workflow_id', wfIds)
  const byWf: Record<string, { completed: number; total: number }> = {}
  for (const s of (steps ?? []) as Array<{ workflow_id: string; status: string }>) {
    if (s.status === 'skipped') continue
    if (!byWf[s.workflow_id]) byWf[s.workflow_id] = { completed: 0, total: 0 }
    byWf[s.workflow_id].total += 1
    if (s.status === 'completed') byWf[s.workflow_id].completed += 1
  }
  const next: Record<string, { completed: number; total: number; status: string }> = {}
  for (const w of wfs as Array<{ id: string; deal_id: string; status: string }>) {
    const p = byWf[w.id] ?? { completed: 0, total: 0 }
    next[w.deal_id] = { ...p, status: w.status }
  }
  workflowProgressByDealId.value = next
}
```

Inside `load()` (line 94), right before the `finally` block that flips `loading.value = false`, call:

```typescript
await loadWorkflowProgress(deals.value.map((d) => d.id))
```

Note: `deals` is the existing component-level ref that holds the loaded array; verify the exact variable name in `load()` and use it. Don't add a second roundtrip — chain this onto the existing `try` block.

Pass the progress down to each card:

```vue
<DealsPipelineCard
  v-for="deal in stageDeals"
  :key="deal.id"
  :deal="deal"
  :workflow-progress="workflowProgressByDealId[deal.id] ?? null"
/>
```

- [ ] **Step 3: Render the chip in DealsPipelineCard**

In `app/components/deals/DealsPipelineCard.vue`, accept the new prop:

```typescript
const props = defineProps<{
  deal: any
  workflowProgress?: { completed: number; total: number; status: string } | null
}>()
```

Add to the template, near the existing badges/labels:

```vue
<span
  v-if="workflowProgress && workflowProgress.status === 'active'"
  class="ml-2 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
  :title="`Transfer workflow: ${workflowProgress.completed} / ${workflowProgress.total} steps complete`"
>
  📋 {{ workflowProgress.completed }}/{{ workflowProgress.total }}
</span>
<span
  v-else-if="workflowProgress && workflowProgress.status === 'completed'"
  class="ml-2 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success"
  title="Transfer workflow complete"
>
  ✓ Transfer
</span>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/components/deals/DealsPipelineCard.vue app/components/deals/DealsPipelineBoard.vue
git commit -m "feat(deals): workflow progress chip on pipeline kanban cards"
```

---

## Task 14: Playwright — sale-condo happy path

**Files:**
- Create: `tests/e2e/workflow-sale-condo.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
import { test, expect } from '@playwright/test'

// Workflow E2E #1: full sale-condo happy path through the wizard.
//
// Preconditions (set up before running locally):
//   - admin user can log in with E2E_ADMIN_EMAIL/PASSWORD
//   - a deal seeded via /api/admin/seed/* OR manually:
//     env DEAL_ID_FOR_WORKFLOW_E2E points at a condo-type deal
//     whose linked envelope is in status=completed.

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@admin.com'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'administrator'
const DEAL_ID = process.env.DEAL_ID_FOR_WORKFLOW_E2E

test.skip(!DEAL_ID, 'Set DEAL_ID_FOR_WORKFLOW_E2E to enable')

test('sale-condo workflow: kickoff → 13 steps → completion', async ({ page }) => {
  // Login
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  await page.goto(`/deals/${DEAL_ID}`)

  // Kickoff card visible
  await expect(page.getByText(/Contract signed/i)).toBeVisible({ timeout: 10_000 })
  await page.getByLabel(/Condo unit/i).check()
  await page.getByRole('button', { name: /Start transfer process/i }).click()

  // Panel appears, 13 visible steps
  await expect(page.getByText(/Transfer document progress/i)).toBeVisible()
  await expect(page.getByText(/0 \/ 13 complete/i)).toBeVisible()

  // Walk through every active step. Each iteration:
  //   - upload a 1-byte test pdf
  //   - tick the attestation
  //   - click Save & continue
  for (let i = 0; i < 13; i++) {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: `step-${i + 1}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test'),
    })
    // Wait for upload-complete toast/text
    await expect(page.getByText(/File uploaded/i).first()).toBeVisible({ timeout: 15_000 })

    const attestCheckbox = page.locator('input[type="checkbox"]').first()
    await attestCheckbox.check()

    await page.getByRole('button', { name: /Save & continue/i }).first().click()

    // Progress counter ticks up
    await expect(page.getByText(new RegExp(`${i + 1} / 13 complete`, 'i'))).toBeVisible({ timeout: 15_000 })
  }

  // Completion state
  await expect(page.getByText(/All steps complete/i)).toBeVisible({ timeout: 15_000 })
})
```

- [ ] **Step 2: Run the spec locally (after seeding a test deal)**

```
DEAL_ID_FOR_WORKFLOW_E2E=<uuid> pnpm e2e tests/e2e/workflow-sale-condo.spec.ts
```

Expected: PASS. If it fails, debug iteratively; the most common failures are upload race conditions — extend the timeouts before declaring a bug.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/workflow-sale-condo.spec.ts
git commit -m "test(e2e): sale-condo workflow happy path"
```

---

## Task 15: Playwright — lease + abandon

**Files:**
- Create: `tests/e2e/workflow-lease.spec.ts`
- Create: `tests/e2e/workflow-abandon.spec.ts`

- [ ] **Step 1: Write the lease spec**

```typescript
import { test, expect } from '@playwright/test'

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@admin.com'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'administrator'
const DEAL_ID = process.env.DEAL_ID_FOR_WORKFLOW_LEASE_E2E

test.skip(!DEAL_ID, 'Set DEAL_ID_FOR_WORKFLOW_LEASE_E2E to enable')

test('lease workflow: kickoff (no branch picker) → 3 steps → completion', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  await page.goto(`/deals/${DEAL_ID}`)

  await expect(page.getByText(/lease document checklist/i)).toBeVisible({ timeout: 10_000 })
  // No condo/land radio on lease
  await expect(page.getByLabel(/Condo unit/i)).toHaveCount(0)

  await page.getByRole('button', { name: /Start transfer process/i }).click()
  await expect(page.getByText(/0 \/ 3 complete/i)).toBeVisible()

  for (let i = 0; i < 3; i++) {
    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: `lease-step-${i + 1}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test'),
    })
    await expect(page.getByText(/File uploaded/i).first()).toBeVisible({ timeout: 15_000 })
    await page.locator('input[type="checkbox"]').first().check()
    await page.getByRole('button', { name: /Save & continue/i }).first().click()
    await expect(page.getByText(new RegExp(`${i + 1} / 3 complete`, 'i'))).toBeVisible({ timeout: 15_000 })
  }
  await expect(page.getByText(/All steps complete/i)).toBeVisible({ timeout: 15_000 })
})
```

- [ ] **Step 2: Write the abandon spec**

```typescript
import { test, expect } from '@playwright/test'

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@admin.com'
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'administrator'
const DEAL_ID = process.env.DEAL_ID_FOR_WORKFLOW_ABANDON_E2E

test.skip(!DEAL_ID, 'Set DEAL_ID_FOR_WORKFLOW_ABANDON_E2E to enable')

test('admin can abandon a mid-flow workflow and broker can restart', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(EMAIL)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

  await page.goto(`/deals/${DEAL_ID}`)

  // Start workflow first (pick condo for sale deals; the spec assumes a sale deal seed).
  await expect(page.getByText(/Contract signed/i)).toBeVisible({ timeout: 10_000 })
  await page.getByLabel(/Condo unit/i).check()
  await page.getByRole('button', { name: /Start transfer process/i }).click()
  await expect(page.getByText(/0 \/ 13 complete/i)).toBeVisible()

  // Abandon. The component uses window.prompt; we intercept.
  page.once('dialog', (d) => d.accept('wrong branch picked'))
  await page.getByRole('button', { name: /Abandon/i }).click()
  await expect(page.getByText(/Workflow abandoned/i)).toBeVisible({ timeout: 10_000 })

  // Kickoff card returns; restart on the correct branch.
  await expect(page.getByText(/Contract signed/i)).toBeVisible({ timeout: 10_000 })
  await page.getByLabel(/House \/ Land/i).check()
  await page.getByRole('button', { name: /Start transfer process/i }).click()
  await expect(page.getByText(/0 \/ 14 complete/i)).toBeVisible()
})
```

- [ ] **Step 3: Run both specs locally**

```
DEAL_ID_FOR_WORKFLOW_LEASE_E2E=<uuid>     pnpm e2e tests/e2e/workflow-lease.spec.ts
DEAL_ID_FOR_WORKFLOW_ABANDON_E2E=<uuid>   pnpm e2e tests/e2e/workflow-abandon.spec.ts
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/workflow-lease.spec.ts tests/e2e/workflow-abandon.spec.ts
git commit -m "test(e2e): workflow lease stub + admin abandon flows"
```

---

## Task 16: Manual smoke + launch readiness check

**Files:** none (verification only)

- [ ] **Step 1: Apply every migration to a fresh DB**

Run: `pnpm check:migrations`

Expected: zero pending.

- [ ] **Step 2: Run the RPC test script end-to-end**

Run: `pnpm test:workflow-rpcs`

Expected: all assertions pass.

- [ ] **Step 3: Run typecheck + e2e**

```
pnpm typecheck
pnpm e2e tests/e2e/workflow-*.spec.ts
```

Expected: no type errors; all workflow specs pass (assuming seed deal env vars are set).

- [ ] **Step 4: Live dev-server walk**

```
pnpm dev
```

In a browser:
1. Complete an envelope on a sale deal → confirm kickoff card appears
2. Pick condo → workflow starts with 13 steps
3. Upload + attest the first 3 steps → progress chip on kanban card shows `📋 3/13`
4. As admin user, click Abandon with a reason → kickoff card returns
5. Restart on land branch → 14 steps now

Confirm each item visually before declaring complete.

- [ ] **Step 5: Final commit (if needed)**

If smoke testing surfaced any cleanup, commit it now. Otherwise:

```bash
git log --oneline -16    # confirm the workflow commit chain
```

---

## Notes for the implementer

- **Test database setup.** The RPC test script wants a profile + listing in the DB. If running against an empty test instance, seed the bare minimum first (one profile, one listing) or skip the script and rely on E2E.
- **Realtime channel.** The panel uses Supabase realtime on `deal_workflows`. If realtime is disabled in the target env, the panel still works — `load()` is called on every advance via the emit chain.
- **Document upload endpoint.** This plan assumes `/api/documents/upload` accepts multipart FormData with `file`, `deal_id`, `document_type`. If the existing endpoint has a different shape, adapt the `onFileChange` body in `DealWorkflowStepRow.vue` only — no other files need to change.
- **Migration ordering.** Tasks 1 → 2 → 3 → 4 MUST be applied in order. Task 4's RPC body references the table shapes from Task 3 and the templates from Task 2.
- **Rollback discipline.** Every migration has a `-- ROLLBACK:` header. To unwind the entire feature, run them in reverse: 4, 3, 2, 1 (each ROLLBACK block contains the exact DROPs).
