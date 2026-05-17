-- Platform Commission Rules  (commission-only monetization).
--
-- Replaces B4 plans + B6 subscriptions. Platform takes a configurable
-- percentage of each closed deal's broker commission. Default: 5% of
-- the broker's net commission. Operator tunes via
-- /api/admin/platform-commission-rule.
--
-- Two new tables:
--   platform_commission_rules     -- single-row config
--   platform_fee_charges          -- the platform's revenue ledger
--
-- One trigger: on deal close (closed_won), auto-insert a projected
-- platform_fee_charge for the buyer agent.
--
-- One RPC: platform_fee_settlement_run(period_end) — sweeps projected
-- charges, creates invoices (B6), marks charges 'invoiced'.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS deals_auto_platform_fee_projection ON public.deals;
--   DROP FUNCTION IF EXISTS public.deals_create_platform_fee_projection_fn();
--   DROP FUNCTION IF EXISTS public.platform_fee_settlement_run(date);
--   DROP FUNCTION IF EXISTS public.platform_fee_mark_paid(uuid);
--   DROP FUNCTION IF EXISTS public.next_platform_fee_charge_no();
--   DROP TABLE IF EXISTS public.platform_fee_charges;
--   DROP TABLE IF EXISTS public.platform_commission_rules;
--   DROP SEQUENCE IF EXISTS public.platform_fee_charge_seq;
--   DELETE FROM public.role_permissions WHERE permission = 'platform_fees.manage';
--   DELETE FROM public.permissions WHERE name = 'platform_fees.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.platform_commission_rules', 'public.platform_fee_charges');


-- =====================================================================
-- 1. platform_commission_rules — single-row config
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.platform_commission_rules (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Default percentage. 5.0 = 5%.
  default_pct     numeric(6,4) NOT NULL DEFAULT 5.0
                       CHECK (default_pct >= 0 AND default_pct <= 100),

  -- 'percent_of_commission' = take pct of broker's net commission
  -- 'percent_of_deal_value' = take pct of full deal_value
  -- 'fixed' = flat amount per deal (default_pct interpreted as PHP centavos)
  basis_kind      text NOT NULL DEFAULT 'percent_of_commission'
                       CHECK (basis_kind IN
                         ('percent_of_commission',
                          'percent_of_deal_value',
                          'fixed')),

  -- Which lease/sale types the rule applies to.
  applies_to      text[] NOT NULL DEFAULT ARRAY['sale', 'lease']::text[],

  -- Per-deal-stage overrides: { 'sale': 5.0, 'lease': 3.0 }
  by_stage        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Per-org overrides: { '<org-uuid>': 4.5 }. Operator-curated.
  by_org          jsonb NOT NULL DEFAULT '{}'::jsonb,

  active          boolean NOT NULL DEFAULT true,
  effective_at    timestamptz NOT NULL DEFAULT now(),
  notes           text,

  updated_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_platform_commission_rules_updated_at ON public.platform_commission_rules;
CREATE TRIGGER set_platform_commission_rules_updated_at
  BEFORE UPDATE ON public.platform_commission_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.platform_commission_rules IS
  'Single-row config for platform monetization. Default: 5% of broker net commission. Operator tunes via admin endpoints.';

-- Seed the default rule.
INSERT INTO public.platform_commission_rules
  (id, default_pct, basis_kind, notes)
VALUES
  (1, 5.0, 'percent_of_commission',
   'Default platform take: 5% of broker net commission. Tune via /api/admin/platform-commission-rule.')
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 2. platform_fee_charge sequence + helper
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS public.platform_fee_charge_seq START 1000;

CREATE OR REPLACE FUNCTION public.next_platform_fee_charge_no()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN format(
    'PF-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.platform_fee_charge_seq')::text, 6, '0')
  );
END;
$$;


-- =====================================================================
-- 3. platform_fee_charges — the revenue ledger
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.platform_fee_charges (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_no                   text NOT NULL UNIQUE
                                   DEFAULT public.next_platform_fee_charge_no(),

  deal_id                     uuid NOT NULL REFERENCES public.deals(id) ON DELETE RESTRICT,

  -- Whom the platform is billing. At least one MUST be set:
  --   user_id        — the agent who closed the deal (default)
  --   organization_id — the brokerage org (when configured)
  organization_id             uuid   REFERENCES public.organizations(id) ON DELETE SET NULL,
  user_id                     uuid   REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- How the amount was computed.
  basis_kind                  text NOT NULL CHECK (basis_kind IN
                                   ('percent_of_commission',
                                    'percent_of_deal_value',
                                    'fixed')),
  basis_value                 numeric(10,4) NOT NULL,
  -- The reference amount the basis applied to (commission total or deal value)
  -- in minor units. NULL when basis_kind='fixed'.
  basis_reference_minor       bigint,

  amount_minor                bigint NOT NULL CHECK (amount_minor > 0),
  currency                    text NOT NULL DEFAULT 'PHP',

  -- Lifecycle.
  status                      text NOT NULL DEFAULT 'projected'
                                   CHECK (status IN
                                     ('projected', 'invoiced', 'paid', 'void')),

  -- B6 invoice link, set by settlement run.
  invoice_id                  uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  invoiced_at                 timestamptz,
  paid_at                     timestamptz,
  voided_at                   timestamptz,
  void_reason                 text,

  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes                       text,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CHECK (
    user_id IS NOT NULL OR organization_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS platform_fee_charges_deal_idx
  ON public.platform_fee_charges(deal_id);
CREATE INDEX IF NOT EXISTS platform_fee_charges_user_idx
  ON public.platform_fee_charges(user_id, status, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_fee_charges_org_idx
  ON public.platform_fee_charges(organization_id, status, created_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_fee_charges_status_idx
  ON public.platform_fee_charges(status, created_at DESC);
CREATE INDEX IF NOT EXISTS platform_fee_charges_invoice_idx
  ON public.platform_fee_charges(invoice_id) WHERE invoice_id IS NOT NULL;

-- One projected charge per (deal, user_id) — prevents trigger
-- double-firing race.
CREATE UNIQUE INDEX IF NOT EXISTS platform_fee_charges_one_per_deal_user
  ON public.platform_fee_charges(deal_id, user_id)
  WHERE user_id IS NOT NULL AND status <> 'void';

DROP TRIGGER IF EXISTS set_platform_fee_charges_updated_at ON public.platform_fee_charges;
CREATE TRIGGER set_platform_fee_charges_updated_at
  BEFORE UPDATE ON public.platform_fee_charges
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.platform_fee_charges IS
  'Platform revenue ledger. One row per closed deal × billed party. status: projected -> invoiced -> paid (or void). Auto-created on deal closed_won via deals_auto_platform_fee_projection trigger.';


-- =====================================================================
-- 4. deals_create_platform_fee_projection_fn — trigger function
-- =====================================================================
--
-- Fires AFTER UPDATE OF closed_won when the deal flips to closed_won.
-- Computes the platform fee per the active rule and inserts a
-- 'projected' platform_fee_charge for the buyer agent.

CREATE OR REPLACE FUNCTION public.deals_create_platform_fee_projection_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_rule              record;
  v_pct               numeric;
  v_basis_kind        text;
  v_basis_ref_minor   bigint;
  v_amount_minor      bigint;
  v_commission_total  numeric;
BEGIN
  -- Only act when transitioning into closed_won.
  IF NOT (NEW.closed_won = true
          AND (OLD.closed_won IS NULL OR OLD.closed_won = false)) THEN
    RETURN NEW;
  END IF;

  -- Need a buyer_agent to bill. (No agent → no projection; ops creates manually.)
  IF NEW.buyer_agent_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip if a non-void projection already exists for this (deal, agent).
  IF EXISTS (
    SELECT 1 FROM public.platform_fee_charges
     WHERE deal_id = NEW.id
       AND user_id = NEW.buyer_agent_user_id
       AND status <> 'void'
  ) THEN
    RETURN NEW;
  END IF;

  -- Look up active rule.
  SELECT default_pct, basis_kind, by_org
    INTO v_rule
  FROM public.platform_commission_rules
  WHERE active = true AND id = 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_pct        := v_rule.default_pct;
  v_basis_kind := v_rule.basis_kind;

  -- Per-org override (advisory; only fires when buyer_agent's org is in
  -- the by_org map). For now we don't resolve agent->org here; future
  -- enhancement.

  IF v_basis_kind = 'percent_of_commission' THEN
    -- Sum the broker net commissions for this deal. Skip if none recorded.
    SELECT coalesce(sum(net_amount), 0)
      INTO v_commission_total
    FROM public.deal_commissions
    WHERE deal_id = NEW.id
      AND status NOT IN ('clawback');

    IF v_commission_total <= 0 THEN
      -- No commission recorded yet → defer; ops creates manually post-fact.
      RETURN NEW;
    END IF;

    v_basis_ref_minor := (v_commission_total * 100)::bigint;
    v_amount_minor    := round(v_basis_ref_minor::numeric * v_pct / 100.0)::bigint;

  ELSIF v_basis_kind = 'percent_of_deal_value' THEN
    IF NEW.deal_value IS NULL OR NEW.deal_value <= 0 THEN
      RETURN NEW;
    END IF;
    v_basis_ref_minor := (NEW.deal_value * 100)::bigint;
    v_amount_minor    := round(v_basis_ref_minor::numeric * v_pct / 100.0)::bigint;

  ELSE -- 'fixed'
    -- default_pct interpreted as PHP centavos.
    v_basis_ref_minor := NULL;
    v_amount_minor    := round(v_pct)::bigint;
  END IF;

  IF v_amount_minor <= 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.platform_fee_charges
    (deal_id, user_id, basis_kind, basis_value, basis_reference_minor,
     amount_minor, currency, status, notes)
  VALUES
    (NEW.id, NEW.buyer_agent_user_id, v_basis_kind, v_pct, v_basis_ref_minor,
     v_amount_minor, coalesce(NEW.currency, 'PHP'), 'projected',
     'Auto-generated on deal closed_won by trigger.');

  RETURN NEW;
EXCEPTION
  -- Defensive: never block the deal write because of a fee-projection failure.
  WHEN OTHERS THEN
    -- Best-effort log (writes go to Postgres log; admin reviews via ops).
    RAISE WARNING 'deals_create_platform_fee_projection: % (%)', SQLERRM, SQLSTATE;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_auto_platform_fee_projection ON public.deals;
CREATE TRIGGER deals_auto_platform_fee_projection
  AFTER UPDATE OF closed_won ON public.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.deals_create_platform_fee_projection_fn();


-- =====================================================================
-- 5. platform_fee_settlement_run RPC — monthly batch
-- =====================================================================
--
-- Sweeps projected charges (older than now() - p_period_end_offset_days
-- defaulting to today). Groups by user_id (or organization_id), creates
-- one B6 invoice per group, marks charges as 'invoiced' with invoice_id.
--
-- Invoice payment continues via the existing B6 webhook flow. When
-- B6 invoice_mark_paid fires, the platform_fee_mark_paid RPC (below)
-- can be called to flip linked charges to 'paid'.
--
-- For v1, this RPC creates per-USER invoices (each agent gets their own
-- bill). Future: per-org consolidation when org payment routing matures.

CREATE OR REPLACE FUNCTION public.platform_fee_settlement_run(
  p_period_end date DEFAULT current_date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    uuid;
  v_org_id     uuid;
  v_charge_ids uuid[];
  v_total      bigint;
  v_currency   text;
  v_invoice_id uuid;
  v_account_id uuid;
  v_invoices   int := 0;
  v_charges    int := 0;
  v_skipped    int := 0;
  v_line_items jsonb;
BEGIN
  IF NOT (
    public.has_permission('platform_fees.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'platform_fee_settlement_run: permission denied' USING ERRCODE = '42501';
  END IF;

  -- Group by (user_id, currency) and create one invoice per group.
  FOR v_user_id, v_currency IN
    SELECT user_id, currency
    FROM public.platform_fee_charges
    WHERE status = 'projected'
      AND user_id IS NOT NULL
      AND created_at::date <= p_period_end
    GROUP BY user_id, currency
  LOOP
    -- Find or create a billing_account for the agent's primary org.
    -- For v1: use the agent's first active org membership.
    SELECT om.organization_id INTO v_org_id
    FROM public.organization_memberships om
    WHERE om.user_id = v_user_id AND om.status = 'active'
    ORDER BY om.created_at ASC
    LIMIT 1;

    IF v_org_id IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Find or create billing_account for that org.
    SELECT id INTO v_account_id
    FROM public.billing_accounts
    WHERE organization_id = v_org_id;

    IF v_account_id IS NULL THEN
      INSERT INTO public.billing_accounts (organization_id, provider)
      VALUES (v_org_id, 'manual')
      RETURNING id INTO v_account_id;
    END IF;

    -- Aggregate this batch.
    SELECT array_agg(id), sum(amount_minor)
      INTO v_charge_ids, v_total
    FROM public.platform_fee_charges
    WHERE status = 'projected'
      AND user_id = v_user_id
      AND currency = v_currency
      AND created_at::date <= p_period_end;

    -- Build line_items for the invoice.
    SELECT jsonb_agg(jsonb_build_object(
      'description', format('Platform fee for deal %s (%s)', pfc.deal_id, pfc.charge_no),
      'quantity', 1,
      'unit_amount_minor', pfc.amount_minor,
      'total_minor', pfc.amount_minor,
      'platform_fee_charge_id', pfc.id
    ))
      INTO v_line_items
    FROM public.platform_fee_charges pfc
    WHERE pfc.id = ANY(v_charge_ids);

    -- Create the invoice.
    INSERT INTO public.invoices (
      billing_account_id, organization_id, currency,
      subtotal_minor, total_minor, status, issued_at, due_at,
      period_end, line_items, metadata
    )
    VALUES (
      v_account_id, v_org_id, v_currency,
      v_total, v_total, 'open', now(),
      now() + interval '30 days',
      p_period_end,
      v_line_items,
      jsonb_build_object(
        'kind',                  'platform_fee_settlement',
        'platform_fee_charges',  v_charge_ids,
        'agent_user_id',         v_user_id
      )
    )
    RETURNING id INTO v_invoice_id;

    -- Mark charges 'invoiced'.
    UPDATE public.platform_fee_charges
       SET status      = 'invoiced',
           invoiced_at = now(),
           invoice_id  = v_invoice_id
     WHERE id = ANY(v_charge_ids);

    v_invoices := v_invoices + 1;
    v_charges  := v_charges + array_length(v_charge_ids, 1);
  END LOOP;

  RETURN jsonb_build_object(
    'period_end', p_period_end,
    'invoices_created', v_invoices,
    'charges_invoiced', v_charges,
    'agents_skipped_no_org', v_skipped
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_fee_settlement_run(date) TO authenticated;


-- =====================================================================
-- 6. platform_fee_mark_paid RPC — settle from B6 webhook
-- =====================================================================
--
-- Called from the B6 payment webhook handler when the platform-fee
-- invoice gets paid. Flips linked platform_fee_charges to 'paid'.

CREATE OR REPLACE FUNCTION public.platform_fee_mark_paid(p_invoice_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  -- Service-role / admin only.
  IF NOT (
    public.has_permission('platform_fees.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'platform_fee_mark_paid: permission denied' USING ERRCODE = '42501';
  END IF;

  WITH updated AS (
    UPDATE public.platform_fee_charges
       SET status   = 'paid',
           paid_at  = now()
     WHERE invoice_id = p_invoice_id
       AND status = 'invoiced'
     RETURNING id
  )
  SELECT count(*) INTO v_count FROM updated;

  RETURN coalesce(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_fee_mark_paid(uuid) TO authenticated;


-- =====================================================================
-- 7. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('platform_fees.manage',
   'Manage platform commission rules and run settlements',
   'platform')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'platform_fees.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 8. RLS
-- =====================================================================

ALTER TABLE public.platform_commission_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_commission_rules_select ON public.platform_commission_rules;
CREATE POLICY platform_commission_rules_select ON public.platform_commission_rules FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS platform_commission_rules_modify ON public.platform_commission_rules;
CREATE POLICY platform_commission_rules_modify ON public.platform_commission_rules FOR ALL
  TO authenticated
  USING (
    public.has_permission('platform_fees.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('platform_fees.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.platform_fee_charges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_fee_charges_select ON public.platform_fee_charges;
CREATE POLICY platform_fee_charges_select ON public.platform_fee_charges FOR SELECT
  TO authenticated
  USING (
    public.has_permission('platform_fees.manage')
    OR public.has_permission('admin.access')
    OR user_id = auth.uid()
    OR (
      organization_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.organization_memberships om
         WHERE om.organization_id = platform_fee_charges.organization_id
           AND om.user_id = auth.uid()
           AND om.status = 'active'
           AND om.org_role = 'brokerage_owner'
      )
    )
  );

DROP POLICY IF EXISTS platform_fee_charges_modify ON public.platform_fee_charges;
CREATE POLICY platform_fee_charges_modify ON public.platform_fee_charges FOR ALL
  TO authenticated
  USING (
    public.has_permission('platform_fees.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('platform_fees.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 9. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.platform_commission_rules', 'table', 'userportal',
   ARRAY['userportal']::text[], 'Single-row platform commission config',  false),
  ('public.platform_fee_charges',      'table', 'userportal',
   ARRAY['userportal']::text[], 'Platform revenue ledger (per closed deal)', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
