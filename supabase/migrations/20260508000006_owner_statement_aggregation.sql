-- Owner Statement aggregation cron.
--
-- Mirror of 20260508000005 (tenant statement aggregation) but rolls
-- up at the *owner* level: for each property_owners row with an
-- active policy, walk the owner's active unit_owners rows, aggregate
-- the period's owner-billed property_charges (kind='dues' typically;
-- billing_target='owner') AND tenant rent paid (so the owner can see
-- gross rent collected on their behalf), AND vendor work_orders with
-- billing_target='owner' (expenses), then insert an owner_statements
-- row.
--
-- Aggregation math (v1):
--   rent_collected     = sum of paid 'rent' charges on the owner's
--                        active leases during the period
--   dues_collected     = sum of paid 'dues' charges (billing_target=
--                        'owner') on the owner's units during the period
--   expenses           = sum of work_orders.cost_actual_minor where
--                        billing_target='owner' AND completed in period
--   management_fee     = 0 (deferred — would read from a future
--                        platform_commission_rules.owner_share)
--   tax_withheld       = 0 (deferred — BIR 2307 generation is its own
--                        track)
--   net_disbursement   = rent_collected + dues_collected - expenses
--                        - management_fee - tax_withheld
--
-- payment_runs.run_kind CHECK widened additively to include
-- 'owner_statement' (drift-safe pattern).
--
-- Daily cron at 05:30 UTC — after tenant statements (05:00) so
-- payment posting from the tenant side is settled.
--
-- Existing surfaces preserved:
--   - owner_statements + post_guard (unchanged; we only INSERT)
--   - statement_mark_issued() (called for auto_issue branch)
--   - property_charges, work_orders, unit_owners (read-only)
--   - has_permission, governance, audit
--
-- ROLLBACK:
--   SELECT cron.unschedule('owner_statements_generate_daily')
--    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'owner_statements_generate_daily');
--   DROP FUNCTION IF EXISTS public.generate_owner_statements(date);
--   DROP TABLE IF EXISTS public.owner_statement_policies;
--   ALTER TABLE public.payment_runs DROP CONSTRAINT IF EXISTS payment_runs_run_kind_check;
--   ALTER TABLE public.payment_runs
--     ADD CONSTRAINT payment_runs_run_kind_check
--     CHECK (run_kind IN ('rent', 'dues', 'manual', 'late_fee', 'statement'));
--   DELETE FROM public.role_permissions WHERE permission = 'owner_statements.manage';
--   DELETE FROM public.permissions WHERE name = 'owner_statements.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.owner_statement_policies',
--      'public.generate_owner_statements');


-- =====================================================================
-- 0. Hard preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='property_owners') THEN
    v_missing := v_missing || 'public.property_owners';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='unit_owners') THEN
    v_missing := v_missing || 'public.unit_owners';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='owner_statements') THEN
    v_missing := v_missing || 'public.owner_statements';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='property_charges') THEN
    v_missing := v_missing || 'public.property_charges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='work_orders') THEN
    v_missing := v_missing || 'public.work_orders';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 20260508000006 requires tables: %. These come from earlier migrations (20260507000055 owners_tenants_statements, 20260507000056 maintenance_vendors_work_orders, 20260507000057 rent_dues_charges). Apply the missing migrations first, then re-run this one.', array_to_string(v_missing, ', ');
  END IF;
END $$;


-- =====================================================================
-- 1. payment_runs.run_kind CHECK widening — additive, drift-safe
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'payment_runs'
  ) THEN
    EXECUTE 'ALTER TABLE public.payment_runs DROP CONSTRAINT IF EXISTS payment_runs_run_kind_check';
    EXECUTE $stmt$
      ALTER TABLE public.payment_runs
        ADD CONSTRAINT payment_runs_run_kind_check
        CHECK (run_kind IN ('rent', 'dues', 'manual', 'late_fee', 'statement', 'owner_statement'))
    $stmt$;
  ELSE
    RAISE NOTICE 'payment_runs absent — skipping run_kind CHECK widening. Run audit will be a no-op for the owner-statement cron until migration 20260507000057_rent_dues_charges.sql is applied.';
  END IF;
END $$;


-- =====================================================================
-- 2. owner_statement_policies — per-owner opt-in
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.owner_statement_policies (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_owner_id           uuid NOT NULL
                                  REFERENCES public.property_owners(id) ON DELETE CASCADE,

  cadence                     text NOT NULL DEFAULT 'monthly'
                                  CHECK (cadence IN ('monthly', 'quarterly')),
  fire_day_of_period          int NOT NULL DEFAULT 1
                                  CHECK (fire_day_of_period BETWEEN 1 AND 28),

  -- If true, the cron flips status='draft' → 'disbursed' is too far
  -- (that's a real-world disbursement event); we only flip to 'issued'.
  -- Operators flip 'issued' → 'disbursed' when they actually wire
  -- funds to the owner.
  auto_issue                  boolean NOT NULL DEFAULT false,

  status                      text NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'paused')),

  next_run_at                 date NOT NULL,
  last_generated_period_start date,

  effective_at                timestamptz NOT NULL DEFAULT now(),
  ended_at                    timestamptz,

  notes                       text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CHECK (ended_at IS NULL OR ended_at > effective_at)
);

CREATE INDEX IF NOT EXISTS owner_statement_policies_owner_idx
  ON public.owner_statement_policies(property_owner_id, status);

CREATE INDEX IF NOT EXISTS owner_statement_policies_next_run_idx
  ON public.owner_statement_policies(next_run_at)
  WHERE status = 'active' AND ended_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS owner_statement_policies_one_active_per_owner
  ON public.owner_statement_policies(property_owner_id)
  WHERE status = 'active' AND ended_at IS NULL;

DROP TRIGGER IF EXISTS set_owner_statement_policies_updated_at
  ON public.owner_statement_policies;
CREATE TRIGGER set_owner_statement_policies_updated_at
  BEFORE UPDATE ON public.owner_statement_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.owner_statement_policies IS
  'Per-owner statement aggregation schedule (opt-in). generate_owner_statements() reads this on the daily cron at 05:30 UTC.';


-- =====================================================================
-- 3. generate_owner_statements — daily cron RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.generate_owner_statements(
  p_today date DEFAULT current_date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id            uuid;
  v_processed         int := 0;
  v_created           int := 0;
  v_skipped           int := 0;
  v_failed            int := 0;
  v_errors            jsonb := '[]'::jsonb;
  v_policy            record;
  v_period_start      date;
  v_period_end        date;
  v_next_run_at       date;
  v_existing_id       uuid;
  v_statement_id      uuid;
  v_unit_ids          uuid[];
  v_lease_ids         uuid[];
  v_rent_collected    bigint;
  v_dues_collected    bigint;
  v_expenses          bigint;
  v_net               bigint;
  v_line_items        jsonb;
BEGIN
  IF NOT (
    public.has_permission('owner_statements.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'generate_owner_statements: permission denied'
      USING ERRCODE = '42501';
  END IF;

  -- Drift-safe run audit.
  BEGIN
    INSERT INTO public.payment_runs (run_kind, period_for, triggered_by)
    VALUES ('owner_statement', p_today, auth.uid())
    RETURNING id INTO v_run_id;
  EXCEPTION WHEN undefined_table THEN
    v_run_id := NULL;
  END;

  FOR v_policy IN
    SELECT id, property_owner_id, cadence, fire_day_of_period, auto_issue,
           next_run_at, last_generated_period_start
    FROM public.owner_statement_policies
    WHERE status = 'active'
      AND (ended_at IS NULL OR ended_at > now())
      AND next_run_at <= p_today
  LOOP
    v_processed := v_processed + 1;

    -- Compute the prior calendar period.
    IF v_policy.cadence = 'monthly' THEN
      v_period_start := (date_trunc('month', v_policy.next_run_at::timestamp) - interval '1 month')::date;
      v_period_end   := (date_trunc('month', v_policy.next_run_at::timestamp) - interval '1 day')::date;
      v_next_run_at  := (v_policy.next_run_at + interval '1 month')::date;
    ELSE
      v_period_start := (date_trunc('quarter', v_policy.next_run_at::timestamp) - interval '3 months')::date;
      v_period_end   := (date_trunc('quarter', v_policy.next_run_at::timestamp) - interval '1 day')::date;
      v_next_run_at  := (v_policy.next_run_at + interval '3 months')::date;
    END IF;

    -- Idempotency guard.
    SELECT id INTO v_existing_id
      FROM public.owner_statements
     WHERE owner_id = v_policy.property_owner_id
       AND period_start = v_period_start
       AND period_end = v_period_end
       AND status <> 'void'
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      v_skipped := v_skipped + 1;
      UPDATE public.owner_statement_policies
         SET next_run_at = v_next_run_at,
             last_generated_period_start = v_period_start
       WHERE id = v_policy.id;
      CONTINUE;
    END IF;

    BEGIN
      -- Resolve the owner's active unit set + active leases (both
      -- snapshotted at p_today; we don't try to backdate ownership
      -- changes for v1).
      SELECT array_agg(uo.unit_id) INTO v_unit_ids
      FROM public.unit_owners uo
      WHERE uo.owner_id = v_policy.property_owner_id
        AND uo.ended_at IS NULL;

      IF v_unit_ids IS NULL OR array_length(v_unit_ids, 1) IS NULL THEN
        -- No active units; emit an empty statement so the owner sees
        -- "this period: nothing happened" rather than a missing row.
        v_unit_ids := ARRAY[]::uuid[];
      END IF;

      SELECT array_agg(l.id) INTO v_lease_ids
      FROM public.leases l
      WHERE l.unit_id = ANY(v_unit_ids)
        AND l.status IN ('active', 'expired', 'terminated');

      IF v_lease_ids IS NULL THEN
        v_lease_ids := ARRAY[]::uuid[];
      END IF;

      -- rent_collected: paid 'rent' charges on owner's leases during the period.
      SELECT coalesce(sum(amount_paid_minor), 0)
        INTO v_rent_collected
      FROM public.property_charges
      WHERE lease_id = ANY(v_lease_ids)
        AND kind = 'rent'
        AND status = 'paid'
        AND paid_at >= v_period_start::timestamptz
        AND paid_at <  (v_period_end::timestamptz + interval '1 day');

      -- dues_collected: paid 'dues' charges on owner's units (billing_target='owner').
      SELECT coalesce(sum(amount_paid_minor), 0)
        INTO v_dues_collected
      FROM public.property_charges
      WHERE unit_id = ANY(v_unit_ids)
        AND kind = 'dues'
        AND billing_target = 'owner'
        AND status = 'paid'
        AND paid_at >= v_period_start::timestamptz
        AND paid_at <  (v_period_end::timestamptz + interval '1 day');

      -- expenses: completed work_orders charged to the owner.
      SELECT coalesce(sum(cost_actual_minor), 0)
        INTO v_expenses
      FROM public.work_orders
      WHERE unit_id = ANY(v_unit_ids)
        AND billing_target = 'owner'
        AND status = 'completed'
        AND completed_at IS NOT NULL
        AND completed_at >= v_period_start::timestamptz
        AND completed_at <  (v_period_end::timestamptz + interval '1 day')
        AND cost_actual_minor IS NOT NULL;

      v_net := v_rent_collected + v_dues_collected - v_expenses;

      -- Build line items: one entry per source, with traceability.
      WITH rent_lines AS (
        SELECT jsonb_build_object(
          'kind', 'rent',
          'charge_no', pc.charge_no,
          'description', format('Rent collected (lease %s)', substr(pc.lease_id::text, 1, 8)),
          'unit_id', pc.unit_id,
          'amount_minor', pc.amount_paid_minor,
          'paid_at', pc.paid_at
        ) AS item
        FROM public.property_charges pc
        WHERE pc.lease_id = ANY(v_lease_ids)
          AND pc.kind = 'rent' AND pc.status = 'paid'
          AND pc.paid_at >= v_period_start::timestamptz
          AND pc.paid_at <  (v_period_end::timestamptz + interval '1 day')
      ),
      dues_lines AS (
        SELECT jsonb_build_object(
          'kind', 'dues',
          'charge_no', pc.charge_no,
          'description', 'Dues collected',
          'unit_id', pc.unit_id,
          'amount_minor', pc.amount_paid_minor,
          'paid_at', pc.paid_at
        ) AS item
        FROM public.property_charges pc
        WHERE pc.unit_id = ANY(v_unit_ids)
          AND pc.kind = 'dues' AND pc.billing_target = 'owner' AND pc.status = 'paid'
          AND pc.paid_at >= v_period_start::timestamptz
          AND pc.paid_at <  (v_period_end::timestamptz + interval '1 day')
      ),
      expense_lines AS (
        SELECT jsonb_build_object(
          'kind', 'expense_maintenance',
          'work_order_no', wo.work_order_no,
          'description', wo.title,
          'unit_id', wo.unit_id,
          'amount_minor', wo.cost_actual_minor,
          'completed_at', wo.completed_at
        ) AS item
        FROM public.work_orders wo
        WHERE wo.unit_id = ANY(v_unit_ids)
          AND wo.billing_target = 'owner'
          AND wo.status = 'completed'
          AND wo.completed_at IS NOT NULL
          AND wo.completed_at >= v_period_start::timestamptz
          AND wo.completed_at <  (v_period_end::timestamptz + interval '1 day')
          AND wo.cost_actual_minor IS NOT NULL
      )
      SELECT coalesce(jsonb_agg(item), '[]'::jsonb) INTO v_line_items
      FROM (
        SELECT item FROM rent_lines
        UNION ALL SELECT item FROM dues_lines
        UNION ALL SELECT item FROM expense_lines
      ) all_lines;

      -- INSERT. management_fee + tax_withheld stay 0 in v1 (deferred).
      INSERT INTO public.owner_statements
        (owner_id, period_start, period_end, currency,
         rent_collected_minor, dues_collected_minor, expenses_minor,
         management_fee_minor, tax_withheld_minor, net_disbursement_minor,
         line_items, status, metadata, created_by)
      VALUES
        (v_policy.property_owner_id, v_period_start, v_period_end, 'PHP',
         v_rent_collected, v_dues_collected, v_expenses,
         0, 0, v_net,
         v_line_items, 'draft',
         jsonb_build_object(
           'policy_id', v_policy.id,
           'payment_run_id', v_run_id,
           'cadence', v_policy.cadence,
           'auto_generated', true,
           'unit_count', coalesce(array_length(v_unit_ids, 1), 0),
           'lease_count', coalesce(array_length(v_lease_ids, 1), 0)
         ),
         auth.uid())
      RETURNING id INTO v_statement_id;

      IF v_policy.auto_issue THEN
        PERFORM public.statement_mark_issued(v_statement_id, 'owner');
      END IF;

      v_created := v_created + 1;

      UPDATE public.owner_statement_policies
         SET next_run_at = v_next_run_at,
             last_generated_period_start = v_period_start
       WHERE id = v_policy.id;
    EXCEPTION
      WHEN OTHERS THEN
        v_failed := v_failed + 1;
        v_errors := v_errors || jsonb_build_object(
          'policy_id', v_policy.id,
          'period_start', v_period_start,
          'error_code', SQLSTATE,
          'message', SQLERRM
        );
    END;
  END LOOP;

  IF v_run_id IS NOT NULL THEN
    BEGIN
      UPDATE public.payment_runs
         SET schedules_processed = v_processed,
             charges_created     = v_created,
             charges_failed      = v_failed,
             errors              = v_errors,
             status              = 'completed',
             completed_at        = now()
       WHERE id = v_run_id;
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'policies_processed', v_processed,
    'statements_created', v_created,
    'skipped', v_skipped,
    'errors', v_failed
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_owner_statements(date) TO authenticated;


-- =====================================================================
-- 4. Cron — daily 05:30 UTC, after tenant statements (05:00)
-- =====================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('owner_statements_generate_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'owner_statements_generate_daily');
  PERFORM cron.schedule(
    'owner_statements_generate_daily',
    '30 5 * * *',
    $cron$ SELECT public.generate_owner_statements(current_date); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'owner_statements_generate cron: pg_cron unavailable; skipping schedule';
END $$;


-- =====================================================================
-- 5. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('owner_statements.manage', 'Manage owner-statement aggregation policies and trigger generation', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'owner_statements.manage'),
  ('manager', 'owner_statements.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 6. RLS
-- =====================================================================

ALTER TABLE public.owner_statement_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_statement_policies_select ON public.owner_statement_policies;
CREATE POLICY owner_statement_policies_select
  ON public.owner_statement_policies FOR SELECT
  TO authenticated
  USING (
    public.has_permission('owner_statements.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    -- Owner sees their own policy (so the future portal can show
    -- "next statement: April 1").
    OR EXISTS (
      SELECT 1 FROM public.property_owners po
       WHERE po.id = owner_statement_policies.property_owner_id
         AND po.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS owner_statement_policies_modify ON public.owner_statement_policies;
CREATE POLICY owner_statement_policies_modify
  ON public.owner_statement_policies FOR ALL
  TO authenticated
  USING (
    public.has_permission('owner_statements.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('owner_statements.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 7. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.owner_statement_policies', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Per-owner statement aggregation cadence (opt-in)', false),
  ('public.generate_owner_statements', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Daily cron RPC: aggregates owner-billed property_charges + work_orders into owner_statements', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
