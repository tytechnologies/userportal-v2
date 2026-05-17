-- Subscriptions + PH Payments — Billing layer.
--
-- B6 of the post-audit roadmap. Adds the financial ledger that
-- backs B4's plans + organization_subscriptions:
--
--   - billing_accounts        — one per organization
--   - payment_methods         — gateway-tokenized only (no raw cards)
--   - plan_prices             — per-plan recurring pricing
--   - invoices                — billing-period invoice ledger
--   - payment_intents         — payment attempts
--   - payment_gateway_events  — append-only webhook log
--
-- ALL money lives in *_minor bigint columns (smallest currency unit;
-- centavos for PHP). Currency is text — application enforces no
-- cross-currency math.
--
-- Live gateway HTTP integration (PayMongo, Maya) is INTENTIONALLY
-- DEFERRED to a follow-up turn — that step needs API keys and is
-- environment-specific. The webhook receiver here records events
-- with signature_verified boolean; handlers only dispatch on
-- verified rows.
--
-- Existing surfaces preserved:
--   - plans, plan_features (B4)              — unchanged
--   - organization_subscriptions (B4)         — kept; flipped via RPCs
--   - has_permission, deal_can_*              — unchanged
--
-- ROLLBACK:
--   SELECT cron.unschedule('invoices_check_past_due_daily');
--   DROP FUNCTION IF EXISTS public.invoices_check_past_due_fn();
--   DROP FUNCTION IF EXISTS public.record_payment_gateway_event(text, text, text, jsonb, boolean);
--   DROP FUNCTION IF EXISTS public.invoice_record_failure(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.invoice_mark_paid(uuid, bigint, uuid);
--   DROP FUNCTION IF EXISTS public.next_invoice_number();
--   DROP VIEW IF EXISTS public.organization_billing_summary;
--   DROP TABLE IF EXISTS public.payment_gateway_events;
--   DROP TABLE IF EXISTS public.payment_intents;
--   DROP TABLE IF EXISTS public.invoices;
--   DROP TABLE IF EXISTS public.plan_prices;
--   DROP TABLE IF EXISTS public.payment_methods;
--   DROP TABLE IF EXISTS public.billing_accounts;
--   DROP SEQUENCE IF EXISTS public.invoice_number_seq;
--   DELETE FROM public.role_permissions WHERE permission IN
--     ('billing.read.own', 'billing.write.own', 'billing.manage.platform');
--   DELETE FROM public.permissions WHERE name IN
--     ('billing.read.own', 'billing.write.own', 'billing.manage.platform');
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.billing_accounts',
--      'public.payment_methods',
--      'public.plan_prices',
--      'public.invoices',
--      'public.payment_intents',
--      'public.payment_gateway_events',
--      'public.organization_billing_summary');


-- =====================================================================
-- 1. billing_accounts — one per organization
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.billing_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Documented providers: 'paymongo', 'maya', 'manual', 'comp'.
  -- Free-form text so adding a new gateway doesn't need a migration.
  provider              text NOT NULL DEFAULT 'manual',
  provider_customer_id  text,

  default_payment_method_id uuid,  -- soft self-ref; FK added below

  billing_email         text,
  -- Stored as { line1, line2, city, province, postal_code, country }.
  billing_address       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- PH BIR Tax Identification Number for OR receipts.
  tax_id                text,

  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_accounts_provider_customer_idx
  ON public.billing_accounts(provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_billing_accounts_updated_at ON public.billing_accounts;
CREATE TRIGGER set_billing_accounts_updated_at
  BEFORE UPDATE ON public.billing_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 2. payment_methods — gateway-tokenized methods
-- =====================================================================
--
-- DOES NOT STORE RAW CARD DATA. provider_method_id IS the token.
-- last4 + card_brand only for display.

CREATE TABLE IF NOT EXISTS public.payment_methods (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id    uuid NOT NULL REFERENCES public.billing_accounts(id) ON DELETE CASCADE,

  provider              text NOT NULL,
  provider_method_id    text NOT NULL,

  -- Documented kinds: 'card', 'gcash', 'maya_wallet', 'bank_transfer'.
  method_kind           text NOT NULL,
  last4                 text CHECK (last4 IS NULL OR length(last4) = 4),
  card_brand            text,
  exp_month             int CHECK (exp_month IS NULL OR (exp_month BETWEEN 1 AND 12)),
  exp_year              int CHECK (exp_year IS NULL OR exp_year >= 2025),

  is_default            boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'expired', 'detached')),

  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_method_id)
);

-- Single default per billing account.
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_one_default
  ON public.payment_methods(billing_account_id)
  WHERE is_default = true AND status = 'active';

CREATE INDEX IF NOT EXISTS payment_methods_account_idx
  ON public.payment_methods(billing_account_id, status);

DROP TRIGGER IF EXISTS set_payment_methods_updated_at ON public.payment_methods;
CREATE TRIGGER set_payment_methods_updated_at
  BEFORE UPDATE ON public.payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

-- Now resolve the soft self-ref on billing_accounts.
-- ALTER ADD CONSTRAINT IF NOT EXISTS isn't supported pre-PG 17; use
-- DO block to add it idempotently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'billing_accounts_default_method_fkey'
  ) THEN
    ALTER TABLE public.billing_accounts
      ADD CONSTRAINT billing_accounts_default_method_fkey
      FOREIGN KEY (default_payment_method_id)
      REFERENCES public.payment_methods(id)
      ON DELETE SET NULL;
  END IF;
END $$;


-- =====================================================================
-- 3. plan_prices — recurring pricing per plan
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.plan_prices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id               uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,

  currency              text NOT NULL DEFAULT 'PHP',
  -- Smallest currency unit: centavos for PHP, cents for USD.
  amount_minor          bigint NOT NULL CHECK (amount_minor >= 0),
  -- Documented values: 'month', 'year'.
  interval              text NOT NULL CHECK (interval IN ('month', 'year')),
  interval_count        int  NOT NULL DEFAULT 1 CHECK (interval_count > 0),

  active                boolean NOT NULL DEFAULT true,

  -- Provider lookup (NULL until registered with the gateway).
  provider              text,
  provider_price_id     text,

  description           text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_price_id)
);

CREATE INDEX IF NOT EXISTS plan_prices_plan_idx
  ON public.plan_prices(plan_id, active);

DROP TRIGGER IF EXISTS set_plan_prices_updated_at ON public.plan_prices;
CREATE TRIGGER set_plan_prices_updated_at
  BEFORE UPDATE ON public.plan_prices
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 4. invoice_number sequence + helper
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq START 1000;

CREATE OR REPLACE FUNCTION public.next_invoice_number()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Format: INV-YYYY-NNNNNN, where NNNNNN is the next sequence value.
  RETURN format(
    'INV-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.invoice_number_seq')::text, 6, '0')
  );
END;
$$;


-- =====================================================================
-- 5. invoices — billing-period invoice ledger
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  billing_account_id    uuid NOT NULL REFERENCES public.billing_accounts(id) ON DELETE RESTRICT,
  -- Denormalized for query convenience; also lets RLS check membership
  -- without joining through billing_accounts.
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  subscription_id       uuid REFERENCES public.organization_subscriptions(id) ON DELETE SET NULL,

  invoice_no            text NOT NULL UNIQUE DEFAULT public.next_invoice_number(),

  currency              text NOT NULL DEFAULT 'PHP',
  subtotal_minor        bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor             bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor           bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  amount_paid_minor     bigint NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),

  -- Lifecycle.
  status                text NOT NULL DEFAULT 'draft'
                             CHECK (status IN
                               ('draft', 'open', 'paid',
                                'past_due', 'void', 'uncollectible')),

  issued_at             timestamptz,
  due_at                timestamptz,
  paid_at               timestamptz,
  voided_at             timestamptz,
  void_reason           text,

  -- Period this invoice covers.
  period_start          timestamptz,
  period_end            timestamptz,

  -- Line items: array of
  --   { description, quantity, unit_amount_minor, total_minor }
  line_items            jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Provider's invoice ID, if hosted invoicing was used.
  external_reference    text,

  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CHECK (period_end IS NULL OR period_end > period_start)
);

CREATE INDEX IF NOT EXISTS invoices_org_idx
  ON public.invoices(organization_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS invoices_status_idx
  ON public.invoices(status, due_at)
  WHERE status IN ('open', 'past_due');
CREATE INDEX IF NOT EXISTS invoices_subscription_idx
  ON public.invoices(subscription_id)
  WHERE subscription_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_invoices_updated_at ON public.invoices;
CREATE TRIGGER set_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 6. payment_intents — one per payment attempt
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.payment_intents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  billing_account_id    uuid NOT NULL REFERENCES public.billing_accounts(id) ON DELETE RESTRICT,
  payment_method_id     uuid REFERENCES public.payment_methods(id) ON DELETE SET NULL,

  provider              text NOT NULL,
  provider_intent_id    text NOT NULL,

  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  currency              text NOT NULL DEFAULT 'PHP',

  -- Documented states (mirrors provider conventions broadly):
  status                text NOT NULL DEFAULT 'requires_payment_method'
                             CHECK (status IN
                               ('requires_payment_method',
                                'requires_confirmation',
                                'processing',
                                'succeeded',
                                'failed',
                                'cancelled',
                                'refunded',
                                'partially_refunded')),

  attempt_count         int NOT NULL DEFAULT 0,
  failure_code          text,
  failure_message       text,

  succeeded_at          timestamptz,
  failed_at             timestamptz,
  refunded_at           timestamptz,

  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_intent_id)
);

CREATE INDEX IF NOT EXISTS payment_intents_invoice_idx
  ON public.payment_intents(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_intents_account_idx
  ON public.payment_intents(billing_account_id, status, created_at DESC);

DROP TRIGGER IF EXISTS set_payment_intents_updated_at ON public.payment_intents;
CREATE TRIGGER set_payment_intents_updated_at
  BEFORE UPDATE ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 7. payment_gateway_events — append-only webhook log
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.payment_gateway_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL,
  -- The provider's event id. UNIQUE per provider for idempotent reads.
  event_id              text NOT NULL,
  event_type            text NOT NULL,

  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature_verified    boolean NOT NULL DEFAULT false,

  processing_status     text NOT NULL DEFAULT 'received'
                             CHECK (processing_status IN
                               ('received', 'processed', 'failed', 'ignored')),
  processing_error      text,
  processed_at          timestamptz,

  related_invoice_id    uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  related_intent_id     uuid REFERENCES public.payment_intents(id) ON DELETE SET NULL,

  received_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS payment_gateway_events_provider_idx
  ON public.payment_gateway_events(provider, received_at DESC);
CREATE INDEX IF NOT EXISTS payment_gateway_events_status_idx
  ON public.payment_gateway_events(processing_status, received_at DESC);
CREATE INDEX IF NOT EXISTS payment_gateway_events_unverified_idx
  ON public.payment_gateway_events(provider, received_at DESC)
  WHERE signature_verified = false;

COMMENT ON TABLE public.payment_gateway_events IS
  'Append-only webhook event log. UNIQUE (provider, event_id) for idempotent processing. signature_verified=false events are recorded for spoofing audit but never trigger handlers.';


-- =====================================================================
-- 8. invoice_mark_paid — atomic payment outcome
-- =====================================================================

CREATE OR REPLACE FUNCTION public.invoice_mark_paid(
  p_invoice_id    uuid,
  p_amount_minor  bigint,
  p_intent_id     uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice record;
  v_subscription_id uuid;
BEGIN
  IF NOT (
    public.has_permission('billing.manage.platform')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'invoice_mark_paid: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_mark_paid: invoice not found' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent on already-paid.
  IF v_invoice.status = 'paid' THEN
    RETURN p_invoice_id;
  END IF;
  IF v_invoice.status IN ('void', 'uncollectible') THEN
    RAISE EXCEPTION 'invoice_mark_paid: invoice in terminal status %', v_invoice.status;
  END IF;

  UPDATE public.invoices
     SET status            = 'paid',
         paid_at           = now(),
         amount_paid_minor = greatest(amount_paid_minor, p_amount_minor)
   WHERE id = p_invoice_id;

  -- If a subscription was past_due because of this invoice, restore.
  v_subscription_id := v_invoice.subscription_id;
  IF v_subscription_id IS NOT NULL THEN
    UPDATE public.organization_subscriptions
       SET status = 'active'
     WHERE id = v_subscription_id
       AND status = 'past_due';
  END IF;

  -- Record on the intent (if provided + present).
  IF p_intent_id IS NOT NULL THEN
    UPDATE public.payment_intents
       SET status        = 'succeeded',
           succeeded_at  = now()
     WHERE id = p_intent_id
       AND status NOT IN ('succeeded', 'refunded', 'partially_refunded');
  END IF;

  RETURN p_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.invoice_mark_paid(uuid, bigint, uuid) TO authenticated;


-- =====================================================================
-- 9. invoice_record_failure — payment attempt failed
-- =====================================================================

CREATE OR REPLACE FUNCTION public.invoice_record_failure(
  p_invoice_id    uuid,
  p_failure_code  text,
  p_message       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice record;
BEGIN
  IF NOT (
    public.has_permission('billing.manage.platform')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'invoice_record_failure: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_record_failure: invoice not found' USING ERRCODE = 'P0002';
  END IF;

  -- Already paid → no-op (a previous attempt succeeded between this
  -- failure event and our processing).
  IF v_invoice.status = 'paid' THEN
    RETURN p_invoice_id;
  END IF;
  IF v_invoice.status IN ('void', 'uncollectible') THEN
    RETURN p_invoice_id;
  END IF;

  UPDATE public.invoices
     SET status   = 'past_due',
         metadata = metadata || jsonb_build_object(
           'last_failure_code',    p_failure_code,
           'last_failure_message', p_message,
           'last_failure_at',      now()::text
         )
   WHERE id = p_invoice_id;

  IF v_invoice.subscription_id IS NOT NULL THEN
    UPDATE public.organization_subscriptions
       SET status = 'past_due'
     WHERE id = v_invoice.subscription_id
       AND status = 'active';
  END IF;

  RETURN p_invoice_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.invoice_record_failure(uuid, text, text) TO authenticated;


-- =====================================================================
-- 10. record_payment_gateway_event — idempotent webhook insert
-- =====================================================================

CREATE OR REPLACE FUNCTION public.record_payment_gateway_event(
  p_provider           text,
  p_event_id           text,
  p_event_type         text,
  p_payload            jsonb,
  p_signature_verified boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Service-role only: webhooks come in via the service-role client.
  IF session_user NOT IN ('postgres', 'supabase_admin', 'service_role') THEN
    RAISE EXCEPTION 'record_payment_gateway_event: service-role only'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.payment_gateway_events
    (provider, event_id, event_type, payload, signature_verified)
  VALUES
    (p_provider, p_event_id, p_event_type, coalesce(p_payload, '{}'::jsonb),
     p_signature_verified)
  ON CONFLICT (provider, event_id) DO UPDATE
    SET signature_verified = EXCLUDED.signature_verified
    -- Re-receiving the same event is idempotent. We update only the
    -- signature flag (in case the verifier changed) and return the
    -- existing id.
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_payment_gateway_event(text, text, text, jsonb, boolean)
  TO authenticated;


-- =====================================================================
-- 11. invoices_check_past_due_fn — daily cron
-- =====================================================================
--
-- Open invoices past due_at → past_due.
-- past_due > 14 days → uncollectible + subscription cancelled.

CREATE OR REPLACE FUNCTION public.invoices_check_past_due_fn()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flagged_past_due int;
  v_uncollectible    int;
BEGIN
  WITH flipped AS (
    UPDATE public.invoices
       SET status = 'past_due'
     WHERE status = 'open'
       AND due_at IS NOT NULL
       AND due_at < now()
     RETURNING id, subscription_id
  ), sub_flips AS (
    UPDATE public.organization_subscriptions os
       SET status = 'past_due'
      FROM flipped f
     WHERE os.id = f.subscription_id
       AND os.status = 'active'
     RETURNING os.id
  )
  SELECT count(*) INTO v_flagged_past_due FROM flipped;

  WITH uncollectible AS (
    UPDATE public.invoices
       SET status = 'uncollectible'
     WHERE status = 'past_due'
       AND due_at IS NOT NULL
       AND due_at < (now() - interval '14 days')
     RETURNING id, subscription_id
  ), sub_cancel AS (
    UPDATE public.organization_subscriptions os
       SET status        = 'cancelled',
           cancelled_at  = now(),
           cancel_reason = 'invoice_uncollectible_after_grace'
      FROM uncollectible u
     WHERE os.id = u.subscription_id
       AND os.status IN ('active', 'past_due')
     RETURNING os.id
  )
  SELECT count(*) INTO v_uncollectible FROM uncollectible;

  RETURN jsonb_build_object(
    'flagged_past_due', coalesce(v_flagged_past_due, 0),
    'uncollectible',    coalesce(v_uncollectible, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.invoices_check_past_due_fn() TO authenticated;

-- Schedule daily at 03:15 UTC.
DO $$
BEGIN
  PERFORM cron.unschedule('invoices_check_past_due_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'invoices_check_past_due_daily');

  PERFORM cron.schedule(
    'invoices_check_past_due_daily',
    '15 3 * * *',
    $cron$ SELECT public.invoices_check_past_due_fn(); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'invoices_check_past_due: pg_cron unavailable; skipping schedule';
END $$;


-- =====================================================================
-- 12. organization_billing_summary view
-- =====================================================================

CREATE OR REPLACE VIEW public.organization_billing_summary AS
SELECT
  o.id           AS organization_id,
  o.name         AS organization_name,
  ba.id          AS billing_account_id,
  ba.provider    AS billing_provider,
  ba.billing_email,
  ba.tax_id,
  os.id          AS subscription_id,
  os.status      AS subscription_status,
  os.effective_at,
  os.expires_at,
  p.code         AS plan_code,
  p.tier         AS plan_tier,
  (SELECT count(*)
     FROM public.invoices i
    WHERE i.organization_id = o.id
      AND i.status IN ('open', 'past_due')
  ) AS open_invoice_count,
  (SELECT coalesce(sum(i.total_minor - i.amount_paid_minor), 0)
     FROM public.invoices i
    WHERE i.organization_id = o.id
      AND i.status IN ('open', 'past_due')
  ) AS open_balance_minor,
  (SELECT max(i.paid_at)
     FROM public.invoices i
    WHERE i.organization_id = o.id
      AND i.status = 'paid'
  ) AS last_paid_at
FROM public.organizations o
LEFT JOIN public.billing_accounts ba ON ba.organization_id = o.id
LEFT JOIN public.organization_subscriptions os
       ON os.organization_id = o.id
      AND os.status IN ('active', 'trialing', 'past_due')
LEFT JOIN public.plans p ON p.id = os.plan_id;

GRANT SELECT ON public.organization_billing_summary TO authenticated;


-- =====================================================================
-- 13. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('billing.read.own',         'Read billing data for own organization',         'billing'),
  ('billing.write.own',        'Update billing details for own organization',    'billing'),
  ('billing.manage.platform',  'Manage billing across all orgs (platform admin)','billing')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'billing.manage.platform'),
  ('admin',   'billing.read.own'),
  ('admin',   'billing.write.own'),
  ('manager', 'billing.read.own')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 14. RLS
-- =====================================================================

-- Helper: caller is a brokerage_owner of the org owning this billing account?
CREATE OR REPLACE FUNCTION public.billing_account_can_manage(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('billing.manage.platform')
    OR EXISTS (
      SELECT 1 FROM public.billing_accounts ba
      JOIN public.organization_memberships om
        ON om.organization_id = ba.organization_id
       AND om.user_id = auth.uid()
       AND om.status = 'active'
       AND om.org_role = 'brokerage_owner'
     WHERE ba.id = p_account_id
    );
$$;
GRANT EXECUTE ON FUNCTION public.billing_account_can_manage(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.billing_account_can_read(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('billing.manage.platform')
    OR EXISTS (
      SELECT 1 FROM public.billing_accounts ba
      JOIN public.organization_memberships om
        ON om.organization_id = ba.organization_id
       AND om.user_id = auth.uid()
       AND om.status = 'active'
     WHERE ba.id = p_account_id
    );
$$;
GRANT EXECUTE ON FUNCTION public.billing_account_can_read(uuid) TO authenticated;


ALTER TABLE public.billing_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_accounts_select ON public.billing_accounts;
CREATE POLICY billing_accounts_select ON public.billing_accounts FOR SELECT
  TO authenticated USING (public.billing_account_can_read(id));

DROP POLICY IF EXISTS billing_accounts_modify ON public.billing_accounts;
CREATE POLICY billing_accounts_modify ON public.billing_accounts FOR ALL
  TO authenticated
  USING (public.billing_account_can_manage(id))
  WITH CHECK (public.billing_account_can_manage(id));


ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_methods_select ON public.payment_methods;
CREATE POLICY payment_methods_select ON public.payment_methods FOR SELECT
  TO authenticated USING (public.billing_account_can_read(billing_account_id));

DROP POLICY IF EXISTS payment_methods_modify ON public.payment_methods;
CREATE POLICY payment_methods_modify ON public.payment_methods FOR ALL
  TO authenticated
  USING (public.billing_account_can_manage(billing_account_id))
  WITH CHECK (public.billing_account_can_manage(billing_account_id));


-- plan_prices: readable by any authenticated; writes admin-only.
ALTER TABLE public.plan_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_prices_select ON public.plan_prices;
CREATE POLICY plan_prices_select ON public.plan_prices FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS plan_prices_modify ON public.plan_prices;
CREATE POLICY plan_prices_modify ON public.plan_prices FOR ALL
  TO authenticated
  USING (public.has_permission('plans.manage'))
  WITH CHECK (public.has_permission('plans.manage'));


ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoices_select ON public.invoices;
CREATE POLICY invoices_select ON public.invoices FOR SELECT
  TO authenticated
  USING (
    public.has_permission('billing.manage.platform')
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
       WHERE om.organization_id = invoices.organization_id
         AND om.user_id = auth.uid()
         AND om.status = 'active'
    )
  );

-- INSERT/UPDATE/DELETE blocked from authenticated. RPCs (SECURITY
-- DEFINER) write the rows.


ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_intents_select ON public.payment_intents;
CREATE POLICY payment_intents_select ON public.payment_intents FOR SELECT
  TO authenticated USING (public.billing_account_can_read(billing_account_id));


ALTER TABLE public.payment_gateway_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_gateway_events_select ON public.payment_gateway_events;
CREATE POLICY payment_gateway_events_select ON public.payment_gateway_events FOR SELECT
  TO authenticated USING (public.has_permission('billing.manage.platform'));


-- =====================================================================
-- 15. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.billing_accounts',             'table', 'userportal',
   ARRAY['userportal']::text[], 'Per-org billing identity',                   false),
  ('public.payment_methods',              'table', 'userportal',
   ARRAY['userportal']::text[], 'Gateway-tokenized methods (no raw cards)',   false),
  ('public.plan_prices',                  'table', 'userportal',
   ARRAY['userportal']::text[], 'Recurring pricing per plan',                 false),
  ('public.invoices',                     'table', 'userportal',
   ARRAY['userportal']::text[], 'Billing-period invoice ledger',              false),
  ('public.payment_intents',              'table', 'userportal',
   ARRAY['userportal']::text[], 'Payment attempts',                           false),
  ('public.payment_gateway_events',       'table', 'userportal',
   ARRAY['userportal']::text[], 'Append-only webhook log',                    false),
  ('public.organization_billing_summary', 'view',  'userportal',
   ARRAY['userportal']::text[], 'Per-org billing rollup',                     false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- 16. Seed placeholder plan_prices (provider='manual')
-- =====================================================================
--
-- Operators replace these with real provider-registered prices when
-- the gateway integration lands. Free plan has no price. Centavos.

INSERT INTO public.plan_prices
  (plan_id, currency, amount_minor, interval, provider, description)
SELECT p.id, 'PHP',  150000, 'month', 'manual', 'Starter monthly (placeholder)'
  FROM public.plans p WHERE p.code = 'starter'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_prices
  (plan_id, currency, amount_minor, interval, provider, description)
SELECT p.id, 'PHP',  500000, 'month', 'manual', 'Professional monthly (placeholder)'
  FROM public.plans p WHERE p.code = 'professional'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_prices
  (plan_id, currency, amount_minor, interval, provider, description)
SELECT p.id, 'PHP', 2500000, 'month', 'manual', 'Enterprise monthly (placeholder)'
  FROM public.plans p WHERE p.code = 'enterprise'
ON CONFLICT DO NOTHING;


NOTIFY pgrst, 'reload schema';
