-- Closing Milestones + Commission Ledger.
--
-- B1 of the post-audit roadmap. Augments the existing deals pipeline
-- (mig 20260507000021) with two complementary systems:
--
--   1. Closing checklist — milestones + reusable templates per
--      deal_type so the free-form deals.stage_key composes into
--      structured closing gates. Required milestones must complete
--      before a deal is "closeable" — surfaced via deal_closing_status
--      (advisory; the operator-driven stage_key transition is NOT
--      blocked server-side).
--
--   2. Commission ledger — event-based line-item ledger that augments
--      the existing deal_commissions "what's owed" tracker. Each
--      ledger entry is one economic event (projection / earning /
--      invoice / payment / payout / reversal / adjustment). Entries
--      are append-only once status='posted'; corrections are new
--      entries with parent_entry_id set.
--
-- Existing surfaces preserved (NOT replaced):
--   - deal_commissions               — kept; remains the per-
--                                       participant headline payout row.
--   - deal_can_read / deal_can_write — reused for new RLS policies.
--   - permissions / role_permissions — additive seeds.
--   - notifications / activities     — new free-form kinds & verbs.
--   - documents.deal_id              — unchanged.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.commission_ledger_summary;
--   DROP VIEW IF EXISTS public.deal_closing_status;
--   DROP FUNCTION IF EXISTS public.apply_milestone_template(uuid, uuid, timestamptz);
--   DROP TRIGGER IF EXISTS commission_ledger_post_guard ON public.commission_ledger;
--   DROP FUNCTION IF EXISTS public.commission_ledger_post_guard_fn();
--   DROP TABLE IF EXISTS public.commission_ledger;
--   DROP TABLE IF EXISTS public.deal_milestones;
--   DROP TABLE IF EXISTS public.deal_milestone_template_items;
--   DROP TABLE IF EXISTS public.deal_milestone_templates;
--   DELETE FROM public.role_permissions WHERE permission IN
--     ('deals.milestones.write', 'commissions.ledger.read.team',
--      'commissions.ledger.write.team');
--   DELETE FROM public.permissions WHERE name IN
--     ('deals.milestones.write', 'commissions.ledger.read.team',
--      'commissions.ledger.write.team');
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.deal_milestones',
--      'public.deal_milestone_templates',
--      'public.deal_milestone_template_items',
--      'public.commission_ledger',
--      'public.deal_closing_status',
--      'public.commission_ledger_summary');


-- =====================================================================
-- 1. deal_milestone_templates — reusable closing checklists
-- =====================================================================
--
-- One row per template. deal_type is free-form text matching the
-- spirit of deals.stage_key — operators can extend without migration.
-- Documented values: 'sale', 'lease', 'rental', 'commercial',
-- 'reservation_only'. is_default is partial-unique per deal_type so
-- new deals know which template to offer first.

CREATE TABLE IF NOT EXISTS public.deal_milestone_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  deal_type       text NOT NULL,
  name            text NOT NULL,
  description     text,

  is_default      boolean NOT NULL DEFAULT false,
  -- false = retained for existing deals but no longer offered for
  -- new ones. Soft-deprecation. Hard-delete is admin-driven.
  active          boolean NOT NULL DEFAULT true,

  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One default per deal_type at a time. Partial UNIQUE so multiple
-- inactive defaults can coexist (history) and an operator can flip
-- the default by deactivating the old row first.
CREATE UNIQUE INDEX IF NOT EXISTS deal_milestone_templates_one_default_per_type
  ON public.deal_milestone_templates(deal_type)
  WHERE is_default = true AND active = true;

CREATE INDEX IF NOT EXISTS deal_milestone_templates_type_idx
  ON public.deal_milestone_templates(deal_type, active);

DROP TRIGGER IF EXISTS set_deal_milestone_templates_updated_at ON public.deal_milestone_templates;
CREATE TRIGGER set_deal_milestone_templates_updated_at
  BEFORE UPDATE ON public.deal_milestone_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.deal_milestone_templates IS
  'Closing checklist templates per deal_type. Partial unique index enforces at most one default per (deal_type) where is_default=true AND active=true. Two PH defaults seeded by mig 20260507000046.';


-- =====================================================================
-- 2. deal_milestone_template_items — items inside a template
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.deal_milestone_template_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id              uuid NOT NULL REFERENCES public.deal_milestone_templates(id) ON DELETE CASCADE,

  -- Milestone identity within the template. snake_case so it
  -- composes with stage_key conventions and is greppable across
  -- deals. UNIQUE within a template.
  milestone_key            text NOT NULL,

  title                    text NOT NULL,
  description              text,

  -- Display / completion order. Templates render top-to-bottom by
  -- sequence ASC. Soft ordering — non-required items can be skipped
  -- without affecting can_close.
  sequence                 int  NOT NULL DEFAULT 0,

  -- Required milestones gate can_close. Optional items can complete
  -- or skip without affecting closure state.
  required                 boolean NOT NULL DEFAULT true,

  -- Default due date offset relative to the template-apply anchor
  -- timestamp, in hours. NULL = no auto-computed due date.
  default_due_offset_hours int,

  -- Free-form policy hooks consumed by the application layer.
  -- Documented today: { min_evidence_kind: 'document'|'note'|... }.
  -- Extending the jsonb avoids a migration when policies grow.
  policy                   jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at               timestamptz NOT NULL DEFAULT now(),

  UNIQUE (template_id, milestone_key)
);

CREATE INDEX IF NOT EXISTS deal_milestone_template_items_template_idx
  ON public.deal_milestone_template_items(template_id, sequence);


-- =====================================================================
-- 3. deal_milestones — milestone instances per deal
-- =====================================================================
--
-- Snapshotted from a template at apply time — editing the template
-- later does NOT retroactively rewrite past deals. The deal owns its
-- own milestone history.

CREATE TABLE IF NOT EXISTS public.deal_milestones (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  deal_id                  uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,

  -- Optional pointers back to the template that materialized this
  -- row. NULL for one-off milestones added ad-hoc on a deal.
  source_template_id       uuid REFERENCES public.deal_milestone_templates(id) ON DELETE SET NULL,
  source_template_item_id  uuid REFERENCES public.deal_milestone_template_items(id) ON DELETE SET NULL,

  milestone_key            text NOT NULL,
  title                    text NOT NULL,
  description              text,
  sequence                 int  NOT NULL DEFAULT 0,
  required                 boolean NOT NULL DEFAULT true,

  -- State machine. 'blocked' is non-terminal — set by an operator
  -- when an external dependency (financing, government doc) prevents
  -- progress.
  status                   text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'in_progress',
                                                  'completed', 'skipped', 'blocked')),

  due_at                   timestamptz,
  started_at               timestamptz,
  completed_at             timestamptz,
  completed_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  blocked_reason           text,
  skipped_reason           text,

  -- Polymorphic evidence pointer. jsonb avoids cross-table FK
  -- fragility (documents.id type has drifted between repos).
  -- Shape: { kind: 'document'|'note'|'external'|'commission_ledger',
  --          ref: <id-or-url>, label: <text> }
  evidence                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  notes                    text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  UNIQUE (deal_id, milestone_key)
);

CREATE INDEX IF NOT EXISTS deal_milestones_deal_idx
  ON public.deal_milestones(deal_id, sequence);

-- Hot indexes for the deal-detail and reminder queries.
CREATE INDEX IF NOT EXISTS deal_milestones_open_idx
  ON public.deal_milestones(deal_id, due_at)
  WHERE status IN ('pending', 'in_progress', 'blocked');

CREATE INDEX IF NOT EXISTS deal_milestones_completed_idx
  ON public.deal_milestones(deal_id, completed_at DESC)
  WHERE status = 'completed';

DROP TRIGGER IF EXISTS set_deal_milestones_updated_at ON public.deal_milestones;
CREATE TRIGGER set_deal_milestones_updated_at
  BEFORE UPDATE ON public.deal_milestones
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.deal_milestones IS
  'Per-deal milestone instances. Snapshotted from a template — editing the template does not rewrite past deals. evidence jsonb is polymorphic; documented kinds: document, note, external, commission_ledger.';


-- =====================================================================
-- 4. commission_ledger — event-based ledger
-- =====================================================================
--
-- Augments deal_commissions: that table records the per-participant
-- headline ("X is owed Y, status payable"); this table records every
-- transition that got it there. Append-only when status='posted';
-- corrections are new entries with parent_entry_id set.
--
-- The ledger CAN exist without a deal_commissions row (e.g., advance
-- / retainer / platform fee); deal_commission_id NULL in that case.

CREATE TABLE IF NOT EXISTS public.commission_ledger (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  deal_id                     uuid NOT NULL REFERENCES public.deals(id) ON DELETE RESTRICT,
  -- Roll-up to the per-participant headline row, when one exists.
  deal_commission_id          uuid REFERENCES public.deal_commissions(id) ON DELETE SET NULL,
  -- Reversals/adjustments reference the entry they correct.
  parent_entry_id             uuid REFERENCES public.commission_ledger(id) ON DELETE RESTRICT,

  -- Whom this entry concerns. At least one MUST be set (CHECK below).
  -- A platform user is preferred; contact and organization handle the
  -- off-platform recipient cases (referrals to outside agents,
  -- platform fees to the operating company, etc.).
  participant_user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  participant_contact_id      bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  participant_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,

  -- Free-form role descriptor — documented values: listing_agent,
  -- buyer_agent, co_broker, referrer, brokerage, platform_fee,
  -- override, manager_split.
  participant_role            text NOT NULL,

  -- The event kind. Each posting advances the deal's economic state.
  entry_kind                  text NOT NULL CHECK (entry_kind IN (
                                   'projection',  -- expected, before close
                                   'earning',     -- crystallized at closed_won
                                   'invoice',     -- invoice issued to payer
                                   'payment',     -- money received by brokerage
                                   'payout',      -- money disbursed to participant
                                   'reversal',    -- clawback of a prior entry
                                   'adjustment'   -- manual correction
                                )),

  -- Money. amount is signed: positive for inflows to the participant,
  -- negative for outflows or reversals. Stored numeric(14,2) — same
  -- shape as deal_commissions.gross_amount.
  amount                      numeric(14,2) NOT NULL,
  currency                    text NOT NULL DEFAULT 'PHP',

  -- Computational provenance. basis_type explains how `amount` was
  -- derived; basis_value is the operative number (e.g., 0.025 for
  -- 2.5% of deal_value). Both nullable when the entry is a flat
  -- adjustment with no formula.
  basis_type                  text CHECK (basis_type IS NULL OR basis_type IN (
                                   'percent_of_deal_value',
                                   'percent_of_commission',
                                   'fixed',
                                   'split_of_parent')),
  basis_value                 numeric(10,4),

  -- Lifecycle. draft entries are mutable; posted entries are
  -- append-only (correction = new reversal/adjustment); void
  -- preserves the row for audit but excludes from totals.
  status                      text NOT NULL DEFAULT 'draft'
                                   CHECK (status IN ('draft', 'posted', 'void')),

  -- External references. invoice_no / receipt_no — free-form text;
  -- the brokerage's accounting system owns the format.
  external_reference          text,

  -- Timestamps. occurred_at is the BUSINESS event time (when the
  -- bank posted the payment, etc.); created_at is row insertion.
  -- Reports filter by occurred_at; audit by created_at.
  occurred_at                 timestamptz NOT NULL DEFAULT now(),
  posted_at                   timestamptz,
  voided_at                   timestamptz,
  void_reason                 text,

  notes                       text,

  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- At least one participant identifier MUST be set.
  CHECK (
    participant_user_id IS NOT NULL
    OR participant_contact_id IS NOT NULL
    OR participant_organization_id IS NOT NULL
  ),

  -- Reversals / adjustments must reference a parent.
  CHECK (
    entry_kind NOT IN ('reversal', 'adjustment')
    OR parent_entry_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS commission_ledger_deal_idx
  ON public.commission_ledger(deal_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS commission_ledger_user_idx
  ON public.commission_ledger(participant_user_id, status, occurred_at DESC)
  WHERE participant_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commission_ledger_org_idx
  ON public.commission_ledger(participant_organization_id, status, occurred_at DESC)
  WHERE participant_organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commission_ledger_parent_idx
  ON public.commission_ledger(parent_entry_id)
  WHERE parent_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commission_ledger_status_idx
  ON public.commission_ledger(status, occurred_at DESC);

DROP TRIGGER IF EXISTS set_commission_ledger_updated_at ON public.commission_ledger;
CREATE TRIGGER set_commission_ledger_updated_at
  BEFORE UPDATE ON public.commission_ledger
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.commission_ledger IS
  'Event-based commission ledger. One row per economic event. Append-only once status=posted; corrections are new entries (entry_kind=reversal/adjustment) with parent_entry_id set. Augments deal_commissions, does not replace it.';


-- =====================================================================
-- 5. commission_ledger_post_guard — append-only enforcement
-- =====================================================================
--
-- Drafts are freely mutable. Posted rows allow ONLY the status->void
-- transition (with void_reason set); every economic field is locked
-- to OLD. Void rows are terminal. Any other update on a posted row
-- raises — operators must create a reversal/adjustment entry.

CREATE OR REPLACE FUNCTION public.commission_ledger_post_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Drafts: free-form. Auto-stamp posted_at on the draft->posted edge.
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'posted' AND NEW.posted_at IS NULL THEN
      NEW.posted_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- Posted: only allow status->void (with reason); economic fields
  -- locked to OLD.
  IF OLD.status = 'posted' THEN
    IF NEW.status = 'void' THEN
      IF NEW.voided_at IS NULL THEN NEW.voided_at := now(); END IF;
      IF coalesce(NEW.void_reason, '') = '' THEN
        RAISE EXCEPTION 'commission_ledger: voiding a posted entry requires void_reason';
      END IF;
      NEW.amount                       := OLD.amount;
      NEW.entry_kind                   := OLD.entry_kind;
      NEW.participant_user_id          := OLD.participant_user_id;
      NEW.participant_contact_id       := OLD.participant_contact_id;
      NEW.participant_organization_id  := OLD.participant_organization_id;
      NEW.deal_id                      := OLD.deal_id;
      NEW.deal_commission_id           := OLD.deal_commission_id;
      NEW.parent_entry_id              := OLD.parent_entry_id;
      NEW.basis_type                   := OLD.basis_type;
      NEW.basis_value                  := OLD.basis_value;
      NEW.currency                     := OLD.currency;
      NEW.occurred_at                  := OLD.occurred_at;
      NEW.posted_at                    := OLD.posted_at;
      RETURN NEW;
    END IF;

    -- Allow soft-field edits (notes, external_reference) without
    -- mutating economic state.
    IF NEW.amount             IS DISTINCT FROM OLD.amount
       OR NEW.entry_kind                   IS DISTINCT FROM OLD.entry_kind
       OR NEW.participant_user_id          IS DISTINCT FROM OLD.participant_user_id
       OR NEW.participant_contact_id       IS DISTINCT FROM OLD.participant_contact_id
       OR NEW.participant_organization_id  IS DISTINCT FROM OLD.participant_organization_id
       OR NEW.deal_id                      IS DISTINCT FROM OLD.deal_id
       OR NEW.deal_commission_id           IS DISTINCT FROM OLD.deal_commission_id
       OR NEW.parent_entry_id              IS DISTINCT FROM OLD.parent_entry_id
       OR NEW.basis_type                   IS DISTINCT FROM OLD.basis_type
       OR NEW.basis_value                  IS DISTINCT FROM OLD.basis_value
       OR NEW.currency                     IS DISTINCT FROM OLD.currency
       OR NEW.occurred_at                  IS DISTINCT FROM OLD.occurred_at
       OR NEW.status                       IS DISTINCT FROM OLD.status
    THEN
      RAISE EXCEPTION 'commission_ledger: posted entries are append-only. Insert a reversal or adjustment entry instead.';
    END IF;
    RETURN NEW;
  END IF;

  -- Void: terminal.
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'commission_ledger: void entries cannot be modified.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commission_ledger_post_guard ON public.commission_ledger;
CREATE TRIGGER commission_ledger_post_guard
  BEFORE UPDATE ON public.commission_ledger
  FOR EACH ROW EXECUTE FUNCTION public.commission_ledger_post_guard_fn();


-- =====================================================================
-- 6. deal_closing_status — derived gate state
-- =====================================================================

CREATE OR REPLACE VIEW public.deal_closing_status AS
WITH per_deal AS (
  SELECT
    m.deal_id,
    count(*) FILTER (WHERE m.required = true)                               AS required_total,
    count(*) FILTER (WHERE m.required = true AND m.status IN ('completed', 'skipped'))
                                                                            AS required_done,
    count(*) FILTER (WHERE m.required = true AND m.status = 'blocked')      AS required_blocked,
    count(*)                                                                AS total,
    count(*) FILTER (WHERE m.status = 'completed')                          AS done
  FROM public.deal_milestones m
  GROUP BY m.deal_id
)
SELECT
  d.id AS deal_id,
  coalesce(pd.required_total, 0)   AS required_total,
  coalesce(pd.required_done, 0)    AS required_done,
  coalesce(pd.required_blocked, 0) AS required_blocked,
  coalesce(pd.total, 0)            AS total,
  coalesce(pd.done, 0)             AS done,
  CASE
    WHEN coalesce(pd.required_total, 0) = 0 THEN false
    WHEN pd.required_done >= pd.required_total THEN true
    ELSE false
  END AS can_close,
  CASE
    WHEN coalesce(pd.total, 0) = 0 THEN 0::numeric
    ELSE round((pd.done::numeric / pd.total::numeric) * 100, 1)
  END AS pct_complete,
  (SELECT m2.id FROM public.deal_milestones m2
    WHERE m2.deal_id = d.id
      AND m2.status NOT IN ('completed', 'skipped')
    ORDER BY m2.sequence ASC, m2.created_at ASC
    LIMIT 1
  ) AS next_milestone_id
FROM public.deals d
LEFT JOIN per_deal pd ON pd.deal_id = d.id;

GRANT SELECT ON public.deal_closing_status TO authenticated;

COMMENT ON VIEW public.deal_closing_status IS
  'Derived per-deal closing gate. can_close = all required milestones in (completed, skipped). Advisory only — the deals.stage_key state machine is operator-driven; the UI surfaces this view as a gate but the server does not enforce it.';


-- =====================================================================
-- 7. commission_ledger_summary — per-deal/participant rollups
-- =====================================================================

CREATE OR REPLACE VIEW public.commission_ledger_summary AS
SELECT
  cl.deal_id,
  cl.participant_user_id,
  cl.participant_organization_id,
  cl.currency,
  sum(cl.amount) FILTER (WHERE cl.status = 'posted' AND cl.entry_kind = 'projection') AS projected_total,
  sum(cl.amount) FILTER (WHERE cl.status = 'posted' AND cl.entry_kind = 'earning')    AS earned_total,
  sum(cl.amount) FILTER (WHERE cl.status = 'posted' AND cl.entry_kind = 'invoice')    AS invoiced_total,
  sum(cl.amount) FILTER (WHERE cl.status = 'posted' AND cl.entry_kind = 'payment')    AS payment_total,
  sum(cl.amount) FILTER (WHERE cl.status = 'posted' AND cl.entry_kind = 'payout')     AS payout_total,
  sum(cl.amount) FILTER (WHERE cl.status = 'posted' AND cl.entry_kind = 'reversal')   AS reversal_total,
  sum(cl.amount) FILTER (WHERE cl.status = 'posted' AND cl.entry_kind = 'adjustment') AS adjustment_total,
  sum(cl.amount) FILTER (WHERE cl.status = 'posted')                                  AS net_total,
  count(*)        FILTER (WHERE cl.status = 'posted')                                 AS posted_count,
  count(*)        FILTER (WHERE cl.status = 'draft')                                  AS draft_count
FROM public.commission_ledger cl
GROUP BY cl.deal_id, cl.participant_user_id, cl.participant_organization_id, cl.currency;

GRANT SELECT ON public.commission_ledger_summary TO authenticated;


-- =====================================================================
-- 8. apply_milestone_template — explicit operator action
-- =====================================================================
--
-- Materializes a template's items into deal_milestones rows for the
-- given deal. Idempotent on (deal_id, milestone_key) — re-running adds
-- new milestones from the template that aren't already present, but
-- does NOT overwrite existing per-deal milestone state.
--
-- session_user bypass keeps SQL-editor smoke runs working without
-- authenticating as a real user (matches the convention from
-- governance / saved-search RPCs).

CREATE OR REPLACE FUNCTION public.apply_milestone_template(
  p_deal_id      uuid,
  p_template_id  uuid,
  p_anchor_at    timestamptz DEFAULT now()
)
RETURNS TABLE (created_count int, skipped_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created      int := 0;
  v_template_total int := 0;
BEGIN
  IF NOT (
    public.deal_can_write(p_deal_id)
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'apply_milestone_template: permission denied for deal %', p_deal_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.deal_milestone_templates t
                  WHERE t.id = p_template_id AND t.active = true) THEN
    RAISE EXCEPTION 'apply_milestone_template: template % not found or inactive', p_template_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO v_template_total
  FROM public.deal_milestone_template_items
  WHERE template_id = p_template_id;

  WITH inserted AS (
    INSERT INTO public.deal_milestones (
      deal_id, source_template_id, source_template_item_id,
      milestone_key, title, description, sequence, required, due_at
    )
    SELECT
      p_deal_id,
      p_template_id,
      ti.id,
      ti.milestone_key,
      ti.title,
      ti.description,
      ti.sequence,
      ti.required,
      CASE
        WHEN ti.default_due_offset_hours IS NULL THEN NULL
        ELSE p_anchor_at + (ti.default_due_offset_hours::text || ' hours')::interval
      END
    FROM public.deal_milestone_template_items ti
    WHERE ti.template_id = p_template_id
    ON CONFLICT (deal_id, milestone_key) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_created FROM inserted;

  RETURN QUERY SELECT v_created, GREATEST(v_template_total - v_created, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_milestone_template(uuid, uuid, timestamptz) TO authenticated;


-- =====================================================================
-- 9. Permissions catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('deals.milestones.write',         'Create and update deal milestones',                  'deals'),
  ('commissions.ledger.read.team',   'Read commission ledger entries for the caller team', 'deals'),
  ('commissions.ledger.write.team',  'Create / post commission ledger entries',            'deals')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'deals.milestones.write'),
  ('admin',   'commissions.ledger.read.team'),
  ('admin',   'commissions.ledger.write.team'),
  ('manager', 'deals.milestones.write'),
  ('manager', 'commissions.ledger.read.team'),
  ('manager', 'commissions.ledger.write.team')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 10. RLS policies — milestones + templates + ledger
-- =====================================================================

-- Templates are platform-wide. Every authenticated user can list
-- (deal participants need to see the catalog when applying a
-- template); only deals.write.team holders can create/edit.
ALTER TABLE public.deal_milestone_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_milestone_templates_select ON public.deal_milestone_templates;
CREATE POLICY deal_milestone_templates_select ON public.deal_milestone_templates FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS deal_milestone_templates_insert ON public.deal_milestone_templates;
CREATE POLICY deal_milestone_templates_insert ON public.deal_milestone_templates FOR INSERT
  TO authenticated WITH CHECK (public.has_permission('deals.write.team'));

DROP POLICY IF EXISTS deal_milestone_templates_update ON public.deal_milestone_templates;
CREATE POLICY deal_milestone_templates_update ON public.deal_milestone_templates FOR UPDATE
  TO authenticated
  USING (public.has_permission('deals.write.team'))
  WITH CHECK (public.has_permission('deals.write.team'));


ALTER TABLE public.deal_milestone_template_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_milestone_template_items_select ON public.deal_milestone_template_items;
CREATE POLICY deal_milestone_template_items_select ON public.deal_milestone_template_items FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS deal_milestone_template_items_insert ON public.deal_milestone_template_items;
CREATE POLICY deal_milestone_template_items_insert ON public.deal_milestone_template_items FOR INSERT
  TO authenticated WITH CHECK (public.has_permission('deals.write.team'));

DROP POLICY IF EXISTS deal_milestone_template_items_update ON public.deal_milestone_template_items;
CREATE POLICY deal_milestone_template_items_update ON public.deal_milestone_template_items FOR UPDATE
  TO authenticated
  USING (public.has_permission('deals.write.team'))
  WITH CHECK (public.has_permission('deals.write.team'));

DROP POLICY IF EXISTS deal_milestone_template_items_delete ON public.deal_milestone_template_items;
CREATE POLICY deal_milestone_template_items_delete ON public.deal_milestone_template_items FOR DELETE
  TO authenticated USING (public.has_permission('deals.write.team'));


-- Milestones inherit deal visibility via deal_can_read / deal_can_write.
ALTER TABLE public.deal_milestones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_milestones_select ON public.deal_milestones;
CREATE POLICY deal_milestones_select ON public.deal_milestones FOR SELECT
  TO authenticated USING (public.deal_can_read(deal_id));

DROP POLICY IF EXISTS deal_milestones_insert ON public.deal_milestones;
CREATE POLICY deal_milestones_insert ON public.deal_milestones FOR INSERT
  TO authenticated WITH CHECK (public.deal_can_write(deal_id));

DROP POLICY IF EXISTS deal_milestones_update ON public.deal_milestones;
CREATE POLICY deal_milestones_update ON public.deal_milestones FOR UPDATE
  TO authenticated
  USING (public.deal_can_write(deal_id))
  WITH CHECK (public.deal_can_write(deal_id));

DROP POLICY IF EXISTS deal_milestones_delete ON public.deal_milestones;
CREATE POLICY deal_milestones_delete ON public.deal_milestones FOR DELETE
  TO authenticated USING (public.deal_can_write(deal_id));


-- Ledger is sensitive. SELECT gated to the participant themselves OR
-- platform-wide commissions readers OR the new team-level reader perm.
ALTER TABLE public.commission_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commission_ledger_select ON public.commission_ledger;
CREATE POLICY commission_ledger_select ON public.commission_ledger FOR SELECT
  TO authenticated
  USING (
    participant_user_id = auth.uid()
    OR public.has_permission('commissions.view.platform')
    OR public.has_permission('commissions.ledger.read.team')
  );

DROP POLICY IF EXISTS commission_ledger_insert ON public.commission_ledger;
CREATE POLICY commission_ledger_insert ON public.commission_ledger FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('commissions.ledger.write.team')
    OR public.has_permission('commissions.view.platform')
    OR public.deal_can_write(deal_id)
  );

DROP POLICY IF EXISTS commission_ledger_update ON public.commission_ledger;
CREATE POLICY commission_ledger_update ON public.commission_ledger FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('commissions.ledger.write.team')
    OR public.has_permission('commissions.view.platform')
  )
  WITH CHECK (
    public.has_permission('commissions.ledger.write.team')
    OR public.has_permission('commissions.view.platform')
  );

-- DELETE intentionally not exposed. Use status='void' transition.


-- =====================================================================
-- 11. Schema governance contract registration
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.deal_milestones',                'table', 'userportal',
   ARRAY['userportal']::text[],  'Per-deal closing checklist instances', false),
  ('public.deal_milestone_templates',       'table', 'userportal',
   ARRAY['userportal']::text[],  'Reusable closing checklists per deal_type', false),
  ('public.deal_milestone_template_items',  'table', 'userportal',
   ARRAY['userportal']::text[],  'Items within a milestone template', false),
  ('public.commission_ledger',              'table', 'userportal',
   ARRAY['userportal']::text[],  'Event-based commission ledger', false),
  ('public.deal_closing_status',            'view',  'userportal',
   ARRAY['userportal']::text[],  'Derived per-deal closing gate', false),
  ('public.commission_ledger_summary',      'view',  'userportal',
   ARRAY['userportal']::text[],  'Per-deal/participant ledger rollup', false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- 12. Default templates — PH residential sale + lease
-- =====================================================================
--
-- Idempotent: SELECT-then-INSERT pattern instead of ON CONFLICT
-- because the partial unique index on (deal_type) WHERE
-- is_default=true AND active=true requires explicit predicate
-- handling that doesn't always cooperate with the planner.

DO $$
DECLARE
  v_sale_id  uuid;
  v_lease_id uuid;
BEGIN
  -- Sale template
  SELECT id INTO v_sale_id FROM public.deal_milestone_templates
   WHERE deal_type = 'sale' AND is_default = true AND active = true
   LIMIT 1;

  IF v_sale_id IS NULL THEN
    INSERT INTO public.deal_milestone_templates
      (deal_type, name, description, is_default, active)
    VALUES
      ('sale',
       'PH Standard Residential Sale Closing',
       'Default closing checklist for PH residential property sales (Reservation -> CTS -> BIR -> RD -> turnover).',
       true, true)
    RETURNING id INTO v_sale_id;
  END IF;

  INSERT INTO public.deal_milestone_template_items
    (template_id, milestone_key, title, sequence, required, default_due_offset_hours)
  VALUES
    (v_sale_id, 'reservation_paid',     'Reservation fee received',                              10, true,    24),
    (v_sale_id, 'loi_executed',         'Letter of Intent executed',                             20, false,   72),
    (v_sale_id, 'cts_signed',           'Contract to Sell signed and notarized',                 30, true,   336),
    (v_sale_id, 'down_payment_received','Down payment received',                                 40, true,   720),
    (v_sale_id, 'financing_resolved',   'Bank loan approved or cash payment confirmed',          50, true,  1440),
    (v_sale_id, 'cgt_dst_paid',         'CGT and DST paid; eCAR issued',                         60, true,  2160),
    (v_sale_id, 'transfer_tax_paid',    'LGU transfer tax paid',                                 70, true,  2160),
    (v_sale_id, 'title_transferred',    'Title transferred at Registry of Deeds',                80, true,  2880),
    (v_sale_id, 'tax_dec_transferred',  'Tax declaration transferred at Assessor',               90, true,  3600),
    (v_sale_id, 'keys_handed_over',     'Keys handed over to buyer',                            100, true,  3600)
  ON CONFLICT (template_id, milestone_key) DO NOTHING;

  -- Lease template
  SELECT id INTO v_lease_id FROM public.deal_milestone_templates
   WHERE deal_type = 'lease' AND is_default = true AND active = true
   LIMIT 1;

  IF v_lease_id IS NULL THEN
    INSERT INTO public.deal_milestone_templates
      (deal_type, name, description, is_default, active)
    VALUES
      ('lease',
       'PH Standard Residential Lease Move-In',
       'Default move-in checklist for PH residential leases.',
       true, true)
    RETURNING id INTO v_lease_id;
  END IF;

  INSERT INTO public.deal_milestone_template_items
    (template_id, milestone_key, title, sequence, required, default_due_offset_hours)
  VALUES
    (v_lease_id, 'lease_signed',          'Lease agreement signed and notarized',          10, true,  168),
    (v_lease_id, 'security_deposit_paid', 'Security deposit and advance rent received',    20, true,  168),
    (v_lease_id, 'move_in_inspection',    'Move-in inspection completed',                  30, false, 336),
    (v_lease_id, 'keys_handed_over',      'Keys handed over to tenant',                    40, true,  336),
    (v_lease_id, 'first_rent_posted',     'Initial rent posted to ledger',                 50, true,  720)
  ON CONFLICT (template_id, milestone_key) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';
