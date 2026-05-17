-- Tenant Statement aggregation cron.
--
-- Closes the second half of the PM billing loop: tenant_statements
-- exists as a structure (with append-only post_guard) but was
-- manual-only until today. This migration adds:
--
--   tenant_statement_policies     — per-lease, opt-in. Cadence
--                                   (monthly|quarterly), fire-day,
--                                   auto-issue flag, next_run_at
--                                   bookkeeping.
--   generate_tenant_statements()  — daily cron. For each active
--                                   policy whose next_run_at <= today,
--                                   aggregates property_charges over
--                                   the period and inserts a
--                                   tenant_statements row (draft or
--                                   issued per policy). Idempotent
--                                   via SELECT-before-INSERT against
--                                   the (lease, period) tuple.
--
-- Daily cron at 05:00 UTC — after late fees (04:00) so the day's
-- late_fee charges are included in the statement.
--
-- payment_runs.run_kind CHECK widened additively to include 'statement'.
--
-- Existing surfaces preserved:
--   - tenant_statements table + post_guard (unchanged)
--   - statement_mark_issued() RPC (called by the auto-issue branch)
--   - property_charges (read-only aggregation)
--   - has_permission, governance, audit (unchanged)
--
-- ROLLBACK:
--   SELECT cron.unschedule('tenant_statements_generate_daily')
--    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tenant_statements_generate_daily');
--   DROP FUNCTION IF EXISTS public.generate_tenant_statements(date);
--   DROP TABLE IF EXISTS public.tenant_statement_policies;
--   ALTER TABLE public.payment_runs DROP CONSTRAINT IF EXISTS payment_runs_run_kind_check;
--   ALTER TABLE public.payment_runs
--     ADD CONSTRAINT payment_runs_run_kind_check
--     CHECK (run_kind IN ('rent', 'dues', 'manual', 'late_fee'));
--   DELETE FROM public.role_permissions WHERE permission = 'statements.manage';
--   DELETE FROM public.permissions WHERE name = 'statements.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.tenant_statement_policies',
--      'public.generate_tenant_statements');


-- =====================================================================
-- 0. Hard preconditions
-- =====================================================================
--
-- The cron's core work reads property_charges and writes
-- tenant_statements; both must exist or this migration is meaningless.
-- payment_runs is treated as soft (drift-safe in section 1) because
-- it's audit-only — losing it degrades observability but not function.

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='leases') THEN
    v_missing := v_missing || 'public.leases';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='lease_parties') THEN
    v_missing := v_missing || 'public.lease_parties';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='tenant_statements') THEN
    v_missing := v_missing || 'public.tenant_statements';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='property_charges') THEN
    v_missing := v_missing || 'public.property_charges';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 20260508000005 requires tables: %. These come from earlier migrations (20260507000054 leases, 20260507000055 owners_tenants_statements, 20260507000057 rent_dues_charges). Apply the missing migrations first, then re-run this one.', array_to_string(v_missing, ', ');
  END IF;
END $$;


-- =====================================================================
-- 1. payment_runs.run_kind CHECK widening — additive, drift-safe
-- =====================================================================
--
-- payment_runs lives in 20260507000057_rent_dues_charges.sql. On
-- drifted DBs that haven't applied that migration the table is
-- absent; we skip the CHECK widening (and the RPC below degrades
-- the run audit to a no-op) so this migration still applies.

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
        CHECK (run_kind IN ('rent', 'dues', 'manual', 'late_fee', 'statement'))
    $stmt$;
  ELSE
    RAISE NOTICE 'payment_runs absent — skipping run_kind CHECK widening. Run audit will be a no-op for the statement cron until migration 20260507000057_rent_dues_charges.sql is applied.';
  END IF;
END $$;


-- =====================================================================
-- 2. tenant_statement_policies — per-lease opt-in
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.tenant_statement_policies (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                    uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,

  -- 'monthly' aggregates the prior month; 'quarterly' the prior quarter.
  cadence                     text NOT NULL DEFAULT 'monthly'
                                  CHECK (cadence IN ('monthly', 'quarterly')),

  -- Day of month/quarter to fire. 1 = first day of period (issuing
  -- the prior period's statement). 28 cap avoids month-length issues.
  fire_day_of_period          int NOT NULL DEFAULT 1
                                  CHECK (fire_day_of_period BETWEEN 1 AND 28),

  -- If true, the cron flips status='draft' → 'issued' immediately
  -- (notify() then fires the statement.tenant_issued email).
  -- If false, statements stay in draft for operator review/edit.
  auto_issue                  boolean NOT NULL DEFAULT false,

  status                      text NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'paused')),

  -- Bookkeeping: when does the cron next fire for this policy?
  next_run_at                 date NOT NULL,
  -- Latest period_start that's already been emitted. Used to skip
  -- back-fills when a paused policy is re-activated.
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

CREATE INDEX IF NOT EXISTS tenant_statement_policies_lease_idx
  ON public.tenant_statement_policies(lease_id, status);

-- Cron working-set index — covers the active+next_run_at scan.
CREATE INDEX IF NOT EXISTS tenant_statement_policies_next_run_idx
  ON public.tenant_statement_policies(next_run_at)
  WHERE status = 'active' AND ended_at IS NULL;

-- One active policy per lease at a time.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_statement_policies_one_active_per_lease
  ON public.tenant_statement_policies(lease_id)
  WHERE status = 'active' AND ended_at IS NULL;

DROP TRIGGER IF EXISTS set_tenant_statement_policies_updated_at
  ON public.tenant_statement_policies;
CREATE TRIGGER set_tenant_statement_policies_updated_at
  BEFORE UPDATE ON public.tenant_statement_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.tenant_statement_policies IS
  'Per-lease tenant-statement aggregation schedule (opt-in). generate_tenant_statements() reads this on the daily cron at 05:00 UTC.';


-- =====================================================================
-- 3. generate_tenant_statements — daily cron RPC
-- =====================================================================
--
-- For each active policy whose next_run_at <= p_today:
--   1. Compute the prior period the statement should cover.
--      (monthly: previous calendar month; quarterly: previous calendar
--      quarter — both anchored on the natural calendar, not on
--      lease.effective_at.)
--   2. SELECT-before-INSERT against tenant_statements for the same
--      (lease_id, period_start, period_end) to keep the cron idempotent
--      when the policy gets re-run for the same day.
--   3. Aggregate property_charges where period_start (fallback to
--      created_at::date for adhoc charges) falls in [period_start,
--      period_end].
--   4. INSERT the tenant_statements row with computed totals + line items.
--   5. If auto_issue, call statement_mark_issued().
--   6. Advance next_run_at by cadence; stamp last_generated_period_start.
--
-- Records to payment_runs (run_kind='statement') with policies_processed
-- in schedules_processed, statements_created in charges_created.

CREATE OR REPLACE FUNCTION public.generate_tenant_statements(
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
  v_lease             record;
  v_period_start      date;
  v_period_end        date;
  v_next_run_at       date;
  v_existing_id       uuid;
  v_statement_id      uuid;
  v_rent_billed       bigint;
  v_other_charges     bigint;
  v_payments          bigint;
  v_balance_due       bigint;
  v_line_items        jsonb;
BEGIN
  IF NOT (
    public.has_permission('statements.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'generate_tenant_statements: permission denied'
      USING ERRCODE = '42501';
  END IF;

  -- Run audit. On drifted DBs without payment_runs we degrade to a
  -- no-op (v_run_id stays NULL); the cron's core work continues.
  BEGIN
    INSERT INTO public.payment_runs (run_kind, period_for, triggered_by)
    VALUES ('statement', p_today, auth.uid())
    RETURNING id INTO v_run_id;
  EXCEPTION WHEN undefined_table THEN
    v_run_id := NULL;
  END;

  FOR v_policy IN
    SELECT id, lease_id, cadence, fire_day_of_period, auto_issue,
           next_run_at, last_generated_period_start
    FROM public.tenant_statement_policies
    WHERE status = 'active'
      AND (ended_at IS NULL OR ended_at > now())
      AND next_run_at <= p_today
  LOOP
    v_processed := v_processed + 1;

    -- Resolve the lease to confirm it's still active. We don't refuse
    -- expired leases — operators may still want a final statement —
    -- but cancelled / void leases are skipped.
    SELECT id, status, currency, unit_id INTO v_lease
      FROM public.leases WHERE id = v_policy.lease_id;
    IF NOT FOUND OR v_lease.status IN ('cancelled', 'void') THEN
      v_skipped := v_skipped + 1;
      v_errors := v_errors || jsonb_build_object(
        'policy_id', v_policy.id,
        'error_code', 'lease_unavailable',
        'message', format('lease %s', coalesce(v_lease.status, 'missing')));
      -- Advance anyway so we don't hot-loop on this policy.
      UPDATE public.tenant_statement_policies
         SET next_run_at = CASE v_policy.cadence
           WHEN 'monthly'   THEN (v_policy.next_run_at + interval '1 month')::date
           WHEN 'quarterly' THEN (v_policy.next_run_at + interval '3 months')::date
         END
       WHERE id = v_policy.id;
      CONTINUE;
    END IF;

    -- Compute the period this statement covers — the *prior* calendar
    -- period anchored on next_run_at. For a policy that fires on the
    -- 1st of the month, monthly cadence: period = month preceding
    -- next_run_at; e.g., next_run_at=2026-06-01 → period=May 2026.
    IF v_policy.cadence = 'monthly' THEN
      v_period_start := (date_trunc('month', v_policy.next_run_at::timestamp) - interval '1 month')::date;
      v_period_end   := (date_trunc('month', v_policy.next_run_at::timestamp) - interval '1 day')::date;
      v_next_run_at  := (v_policy.next_run_at + interval '1 month')::date;
    ELSE -- quarterly
      v_period_start := (date_trunc('quarter', v_policy.next_run_at::timestamp) - interval '3 months')::date;
      v_period_end   := (date_trunc('quarter', v_policy.next_run_at::timestamp) - interval '1 day')::date;
      v_next_run_at  := (v_policy.next_run_at + interval '3 months')::date;
    END IF;

    -- Idempotency: skip if a non-void statement already covers this
    -- exact (lease, period). Operators can manually issue a one-off
    -- statement via the existing /api/leases/:id/statements path; we
    -- defer to whatever they've already created.
    SELECT id INTO v_existing_id
      FROM public.tenant_statements
     WHERE lease_id = v_policy.lease_id
       AND period_start = v_period_start
       AND period_end = v_period_end
       AND status <> 'void'
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      v_skipped := v_skipped + 1;
      -- Still advance the bookkeeping so we don't reprocess on tomorrow's run.
      UPDATE public.tenant_statement_policies
         SET next_run_at = v_next_run_at,
             last_generated_period_start = v_period_start
       WHERE id = v_policy.id;
      CONTINUE;
    END IF;

    BEGIN
      -- Aggregate the period's economics.
      --
      -- rent_billed_minor: total of 'rent' kind charges in the period.
      -- other_charges_minor: dues + maintenance_pass_through + late_fee
      --                      + damage + adjustment + security_deposit.
      -- payments_received_minor: sum of amount_paid_minor on charges
      --                           paid (paid_at) in the period — across
      --                           ALL kinds.
      -- balance_due_minor: total billed - total paid (clamped >= 0).
      --
      -- Period attribution rule: a charge belongs to the statement for
      -- its period_start. Adhoc charges (period_start IS NULL) attribute
      -- to the statement covering their created_at::date.
      SELECT
        coalesce(sum(total_minor) FILTER (WHERE kind = 'rent'), 0),
        coalesce(sum(total_minor) FILTER (WHERE kind <> 'rent'), 0),
        coalesce(sum(amount_paid_minor), 0)
      INTO v_rent_billed, v_other_charges, v_payments
      FROM public.property_charges
      WHERE lease_id = v_policy.lease_id
        AND status <> 'void'
        AND coalesce(period_start, created_at::date) >= v_period_start
        AND coalesce(period_start, created_at::date) <= v_period_end;

      v_balance_due := greatest(
        (v_rent_billed + v_other_charges) - v_payments,
        0
      );

      -- Build line items from the underlying charges. Each line carries
      -- the source charge_no for traceability back to the ledger.
      SELECT coalesce(jsonb_agg(jsonb_build_object(
          'kind',          pc.kind,
          'charge_no',     pc.charge_no,
          'description',   coalesce(pc.line_items->0->>'description', pc.kind),
          'amount_minor',  pc.total_minor,
          'paid_minor',    pc.amount_paid_minor,
          'period_start',  pc.period_start,
          'due_at',        pc.due_at
        ) ORDER BY pc.due_at NULLS LAST, pc.created_at), '[]'::jsonb)
      INTO v_line_items
      FROM public.property_charges pc
      WHERE pc.lease_id = v_policy.lease_id
        AND pc.status <> 'void'
        AND coalesce(pc.period_start, pc.created_at::date) >= v_period_start
        AND coalesce(pc.period_start, pc.created_at::date) <= v_period_end;

      -- INSERT. status='draft' so the post_guard treats this as
      -- pre-issuance free-edit. Auto-issue branch flips it below.
      INSERT INTO public.tenant_statements
        (lease_id, period_start, period_end, currency,
         rent_billed_minor, other_charges_minor,
         payments_received_minor, balance_due_minor,
         line_items, status,
         due_at, metadata, created_by)
      VALUES
        (v_policy.lease_id, v_period_start, v_period_end, v_lease.currency,
         v_rent_billed, v_other_charges,
         v_payments, v_balance_due,
         v_line_items, 'draft',
         (v_period_end::timestamptz + interval '7 days'),
         jsonb_build_object(
           'policy_id', v_policy.id,
           'payment_run_id', v_run_id,
           'cadence', v_policy.cadence,
           'auto_generated', true
         ),
         auth.uid())
      RETURNING id INTO v_statement_id;

      -- Auto-issue path: flip draft → issued via the existing helper.
      -- This stamps issued_at and triggers any downstream notifications
      -- via the application layer.
      IF v_policy.auto_issue THEN
        PERFORM public.statement_mark_issued(v_statement_id, 'tenant');
      END IF;

      v_created := v_created + 1;

      UPDATE public.tenant_statement_policies
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
        -- Don't advance next_run_at on failure — operator can fix and
        -- the next cron will retry.
    END;
  END LOOP;

  -- Same degrade pattern: if payment_runs is absent, v_run_id is NULL
  -- and we skip the audit update.
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
      NULL; -- table dropped between INSERT and UPDATE — extremely unlikely but harmless
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

GRANT EXECUTE ON FUNCTION public.generate_tenant_statements(date) TO authenticated;


-- =====================================================================
-- 4. Cron — daily 05:00 UTC, after late fees (04:00)
-- =====================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('tenant_statements_generate_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tenant_statements_generate_daily');
  PERFORM cron.schedule(
    'tenant_statements_generate_daily',
    '0 5 * * *',
    $cron$ SELECT public.generate_tenant_statements(current_date); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'tenant_statements_generate cron: pg_cron unavailable; skipping schedule';
END $$;


-- =====================================================================
-- 5. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('statements.manage', 'Manage statement aggregation policies and trigger generation', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'statements.manage'),
  ('manager', 'statements.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 6. RLS
-- =====================================================================

ALTER TABLE public.tenant_statement_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_statement_policies_select ON public.tenant_statement_policies;
CREATE POLICY tenant_statement_policies_select
  ON public.tenant_statement_policies FOR SELECT
  TO authenticated
  USING (
    public.has_permission('statements.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    -- Tenant on the lease can read (so future portal can show
    -- "next statement: April 1" expectation).
    OR EXISTS (
      SELECT 1 FROM public.lease_parties lp
       WHERE lp.lease_id = tenant_statement_policies.lease_id
         AND lp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS tenant_statement_policies_modify ON public.tenant_statement_policies;
CREATE POLICY tenant_statement_policies_modify
  ON public.tenant_statement_policies FOR ALL
  TO authenticated
  USING (
    public.has_permission('statements.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('statements.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 7. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.tenant_statement_policies', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Per-lease tenant-statement aggregation cadence (opt-in)', false),
  ('public.generate_tenant_statements', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Daily cron RPC: aggregates property_charges per period into tenant_statements', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
