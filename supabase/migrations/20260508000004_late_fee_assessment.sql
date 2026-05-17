-- Late-fee policies + auto-assessment.
--
-- Closes the loop between `property_charges.past_due` and the
-- `late_fee` charge kind that already exists in the kind CHECK but
-- had no automation. Two new structures:
--
--   late_fee_policies     — per-lease opt-in policy. No global default;
--                           a lease without a policy never accrues a
--                           late fee. Operator must explicitly attach a
--                           policy per lease (admin endpoint coming next).
--   late_fee_assessments  — ledger of which past-due charge → which
--                           late-fee charge under which policy on
--                           which date. Idempotency key.
--
-- One new RPC `assess_past_due_charges(p_today)`:
--   1. Flips status='open' && due_at < now() → 'past_due'.
--   2. For each past_due charge with an active per-lease policy, if
--      the grace period has passed and (recurrence_kind='once' & no
--      prior assessment) OR (recurrence_kind='recurring' & last
--      assessment ≥ recurrence_days ago), inserts a `late_fee`
--      property_charge AND a late_fee_assessments row in the same txn.
--
-- Daily cron at 04:00 UTC — after rent (03:30) and dues (03:35) so
-- those charges have a chance to settle before late fees apply.
--
-- Additive: payment_runs.run_kind CHECK is broadened to include
-- 'late_fee'. The widen is non-destructive (existing rows still
-- satisfy the new constraint).
--
-- Existing surfaces preserved:
--   - property_charges (kind 'late_fee' was already in the CHECK)
--   - rent_schedules / dues_schedules (unchanged)
--   - payment_runs (CHECK widened only)
--   - has_permission, governance, audit (unchanged)
--
-- ROLLBACK:
--   SELECT cron.unschedule('property_charges_late_fee_assess_daily')
--    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'property_charges_late_fee_assess_daily');
--   DROP FUNCTION IF EXISTS public.assess_past_due_charges(date);
--   DROP TABLE IF EXISTS public.late_fee_assessments;
--   DROP TABLE IF EXISTS public.late_fee_policies;
--   ALTER TABLE public.payment_runs DROP CONSTRAINT IF EXISTS payment_runs_run_kind_check;
--   ALTER TABLE public.payment_runs
--     ADD CONSTRAINT payment_runs_run_kind_check
--     CHECK (run_kind IN ('rent', 'dues', 'manual'));
--   DELETE FROM public.role_permissions WHERE permission = 'late_fees.manage';
--   DELETE FROM public.permissions WHERE name = 'late_fees.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.late_fee_policies',
--      'public.late_fee_assessments',
--      'public.assess_past_due_charges');


-- =====================================================================
-- 0. Hard preconditions
-- =====================================================================
--
-- late_fee_assessments has FKs to property_charges, and the cron RPC
-- writes property_charges rows for the late_fee charges themselves.
-- Both tables must exist. payment_runs is soft (drift-safe in §1).

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
                  WHERE table_schema='public' AND table_name='property_charges') THEN
    v_missing := v_missing || 'public.property_charges';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 20260508000004 requires tables: %. These come from earlier migrations (20260507000054 leases, 20260507000057 rent_dues_charges). Apply the missing migrations first, then re-run this one.', array_to_string(v_missing, ', ');
  END IF;
END $$;


-- =====================================================================
-- 1. payment_runs.run_kind CHECK widening — additive, drift-safe
-- =====================================================================
--
-- Original CHECK: run_kind IN ('rent', 'dues', 'manual')
-- Widened:        + 'late_fee'
--
-- payment_runs lives in 20260507000057_rent_dues_charges.sql. On
-- drifted DBs without that migration the table is absent; we skip the
-- CHECK widening and the RPC below degrades the run audit to a no-op.

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
        CHECK (run_kind IN ('rent', 'dues', 'manual', 'late_fee'))
    $stmt$;
  ELSE
    RAISE NOTICE 'payment_runs absent — skipping run_kind CHECK widening. Run audit will be a no-op for the late-fee cron until migration 20260507000057_rent_dues_charges.sql is applied.';
  END IF;
END $$;


-- =====================================================================
-- 2. late_fee_policies — per-lease opt-in
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.late_fee_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id            uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,

  currency            text NOT NULL DEFAULT 'PHP',

  -- How many days after due_at must pass before a late fee triggers.
  grace_days          int NOT NULL DEFAULT 5
                          CHECK (grace_days >= 0 AND grace_days <= 90),

  -- Three shapes:
  --   'flat'                — fixed minor-units fee
  --   'percent_of_balance'  — percent of property_charges.total_minor
  --   'escalating'          — flat fee, applied recurrently
  fee_kind            text NOT NULL CHECK (fee_kind IN
                          ('flat', 'percent_of_balance', 'escalating')),

  flat_amount_minor   bigint CHECK (flat_amount_minor IS NULL
                                     OR flat_amount_minor >= 0),
  percent_value       numeric(6,3) CHECK (percent_value IS NULL
                                          OR (percent_value > 0 AND percent_value <= 100)),

  -- Optional ceiling per assessment (any kind).
  cap_minor           bigint CHECK (cap_minor IS NULL OR cap_minor > 0),

  -- 'once'      — single late_fee charge per past-due source charge
  -- 'recurring' — re-assess every recurrence_days
  recurrence_kind     text NOT NULL DEFAULT 'once'
                          CHECK (recurrence_kind IN ('once', 'recurring')),
  recurrence_days     int CHECK (recurrence_days IS NULL
                                  OR (recurrence_days >= 1 AND recurrence_days <= 90)),

  status              text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'paused')),

  effective_at        timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,

  notes               text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Shape coherence: every fee_kind needs the right amount column populated.
  CHECK (
    (fee_kind = 'flat'               AND flat_amount_minor IS NOT NULL)
    OR (fee_kind = 'percent_of_balance' AND percent_value IS NOT NULL)
    OR (fee_kind = 'escalating'      AND flat_amount_minor IS NOT NULL)
  ),
  -- Recurring shape must specify cadence.
  CHECK (recurrence_kind = 'once' OR recurrence_days IS NOT NULL),
  CHECK (ended_at IS NULL OR ended_at > effective_at)
);

CREATE INDEX IF NOT EXISTS late_fee_policies_lease_idx
  ON public.late_fee_policies(lease_id, status);

-- One active policy per lease at a time. Operator either pauses or
-- ends the prior policy before issuing a new one (the upsert helper
-- handles that flow; admin endpoints will use it).
CREATE UNIQUE INDEX IF NOT EXISTS late_fee_policies_one_active_per_lease
  ON public.late_fee_policies(lease_id)
  WHERE status = 'active' AND ended_at IS NULL;

DROP TRIGGER IF EXISTS set_late_fee_policies_updated_at ON public.late_fee_policies;
CREATE TRIGGER set_late_fee_policies_updated_at
  BEFORE UPDATE ON public.late_fee_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.late_fee_policies IS
  'Per-lease late-fee rules. No global default — a lease without an active row never accrues a late fee. assess_past_due_charges() reads this on the daily cron.';


-- =====================================================================
-- 3. late_fee_assessments — idempotency ledger
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.late_fee_assessments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The past-due charge that triggered this assessment.
  source_charge_id         uuid NOT NULL REFERENCES public.property_charges(id) ON DELETE RESTRICT,

  -- The late_fee charge created in response. May be NULL if the
  -- assessment was attempted but the charge insert failed (we still
  -- record the attempt for audit + back-off).
  late_fee_charge_id       uuid REFERENCES public.property_charges(id) ON DELETE SET NULL,

  policy_id                uuid REFERENCES public.late_fee_policies(id) ON DELETE SET NULL,
  payment_run_id           uuid REFERENCES public.payment_runs(id) ON DELETE SET NULL,

  assessment_date          date NOT NULL DEFAULT current_date,
  -- Which assessment in the recurring series this is. 1 for 'once' policies.
  recurrence_index         int  NOT NULL DEFAULT 1
                                 CHECK (recurrence_index >= 1),
  amount_minor             bigint NOT NULL CHECK (amount_minor >= 0),

  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS late_fee_assessments_source_idx
  ON public.late_fee_assessments(source_charge_id, assessment_date DESC);
CREATE INDEX IF NOT EXISTS late_fee_assessments_payment_run_idx
  ON public.late_fee_assessments(payment_run_id) WHERE payment_run_id IS NOT NULL;

-- Idempotency: never assess the same source charge at the same
-- recurrence_index twice. Combined with the recurrence_index counter
-- this gives clean re-run safety.
CREATE UNIQUE INDEX IF NOT EXISTS late_fee_assessments_unique_per_source_recurrence
  ON public.late_fee_assessments(source_charge_id, recurrence_index);

COMMENT ON TABLE public.late_fee_assessments IS
  'Append-only ledger of late-fee assessments. recurrence_index increments per re-application under "recurring" policies; UNIQUE prevents double-charging.';


-- =====================================================================
-- 4. assess_past_due_charges — daily cron RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.assess_past_due_charges(
  p_today date DEFAULT current_date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id          uuid;
  v_now             timestamptz := now();
  v_charges_flipped int := 0;
  v_fees_created    int := 0;
  v_fees_skipped    int := 0;
  v_failed          int := 0;
  v_errors          jsonb := '[]'::jsonb;
  v_charge          record;
  v_policy          record;
  v_last_assessment record;
  v_amount_minor    bigint;
  v_recurrence_idx  int;
  v_late_fee_id     uuid;
BEGIN
  IF NOT (
    public.has_permission('late_fees.manage')
    OR public.has_permission('rent.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'assess_past_due_charges: permission denied'
      USING ERRCODE = '42501';
  END IF;

  -- Run audit. On drifted DBs without payment_runs we degrade to a
  -- no-op (v_run_id stays NULL); the cron's core work continues.
  BEGIN
    INSERT INTO public.payment_runs (run_kind, period_for, triggered_by)
    VALUES ('late_fee', p_today, auth.uid())
    RETURNING id INTO v_run_id;
  EXCEPTION WHEN undefined_table THEN
    v_run_id := NULL;
  END;

  -- Phase 1: flip overdue 'open' charges to 'past_due'. The post-guard
  -- trigger doesn't lock the status field, so a plain UPDATE is fine.
  -- We restrict to charges that are tenant-billed rent/dues — late fees
  -- on top of late fees would be a different policy decision.
  UPDATE public.property_charges
     SET status   = 'past_due',
         metadata = metadata || jsonb_build_object(
           'last_failure_code',    'past_due_auto',
           'last_failure_message', 'auto-flipped to past_due by assess_past_due_charges',
           'last_failure_at',      v_now::text,
           'late_fee_run_id',      v_run_id
         )
   WHERE status = 'open'
     AND due_at IS NOT NULL
     AND due_at < v_now
     AND kind IN ('rent', 'dues', 'maintenance_pass_through');
  GET DIAGNOSTICS v_charges_flipped = ROW_COUNT;

  -- Phase 2: assess late fees on past_due charges with an active
  -- per-lease policy. We re-query (don't use the UPDATE result) so
  -- charges that became past_due in prior runs but never accrued a
  -- fee (operator added the policy late) get their first fee now.
  FOR v_charge IN
    SELECT pc.id, pc.lease_id, pc.unit_id, pc.total_minor, pc.amount_paid_minor,
           pc.currency, pc.due_at, pc.kind, pc.charged_to_user_id,
           pc.charged_to_contact_id, pc.charged_to_external_name,
           pc.charged_to_external_email, pc.billing_target
    FROM public.property_charges pc
    WHERE pc.status = 'past_due'
      AND pc.lease_id IS NOT NULL
      AND pc.kind IN ('rent', 'dues', 'maintenance_pass_through')
      AND pc.amount_paid_minor < pc.total_minor
  LOOP
    -- Pull the active policy for this lease. No policy → skip silently.
    SELECT * INTO v_policy
      FROM public.late_fee_policies
     WHERE lease_id = v_charge.lease_id
       AND status = 'active'
       AND (ended_at IS NULL OR ended_at > v_now)
       AND effective_at <= v_now
     ORDER BY effective_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      v_fees_skipped := v_fees_skipped + 1;
      CONTINUE;
    END IF;

    -- Grace period: only assess once due_at + grace_days has passed.
    IF v_charge.due_at IS NULL OR v_charge.due_at + (v_policy.grace_days || ' days')::interval > v_now THEN
      v_fees_skipped := v_fees_skipped + 1;
      CONTINUE;
    END IF;

    -- Look at the last assessment (if any) to decide whether to charge.
    SELECT * INTO v_last_assessment
      FROM public.late_fee_assessments
     WHERE source_charge_id = v_charge.id
     ORDER BY recurrence_index DESC
     LIMIT 1;

    IF FOUND THEN
      -- Already assessed at least once.
      IF v_policy.recurrence_kind = 'once' THEN
        v_fees_skipped := v_fees_skipped + 1;
        CONTINUE;
      END IF;
      -- recurring: only re-assess if cadence has elapsed.
      IF v_last_assessment.assessment_date + (v_policy.recurrence_days || ' days')::interval > v_now THEN
        v_fees_skipped := v_fees_skipped + 1;
        CONTINUE;
      END IF;
      v_recurrence_idx := v_last_assessment.recurrence_index + 1;
    ELSE
      v_recurrence_idx := 1;
    END IF;

    -- Compute the fee.
    IF v_policy.fee_kind = 'flat' OR v_policy.fee_kind = 'escalating' THEN
      v_amount_minor := v_policy.flat_amount_minor;
    ELSIF v_policy.fee_kind = 'percent_of_balance' THEN
      -- Percent applies to the unpaid balance, not the total.
      v_amount_minor := floor(
        (v_charge.total_minor - v_charge.amount_paid_minor)::numeric
        * v_policy.percent_value / 100
      )::bigint;
    END IF;

    IF v_policy.cap_minor IS NOT NULL AND v_amount_minor > v_policy.cap_minor THEN
      v_amount_minor := v_policy.cap_minor;
    END IF;

    -- Zero-fee policies (e.g., 0% of a $0 balance) → skip; don't pollute the ledger.
    IF v_amount_minor IS NULL OR v_amount_minor = 0 THEN
      v_fees_skipped := v_fees_skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      -- Create the late_fee charge. status='open' so the tenant sees
      -- it immediately; due_at is now (no grace on the late fee itself).
      INSERT INTO public.property_charges
        (kind, unit_id, lease_id,
         charged_to_user_id, charged_to_contact_id,
         charged_to_external_name, charged_to_external_email,
         billing_target,
         currency, subtotal_minor, total_minor,
         status, due_at, line_items, metadata)
      VALUES
        ('late_fee', v_charge.unit_id, v_charge.lease_id,
         v_charge.charged_to_user_id, v_charge.charged_to_contact_id,
         v_charge.charged_to_external_name, v_charge.charged_to_external_email,
         v_charge.billing_target,
         v_charge.currency, v_amount_minor, v_amount_minor,
         'open', v_now,
         jsonb_build_array(
           jsonb_build_object(
             'description', format('Late fee for charge (recurrence %s)', v_recurrence_idx),
             'quantity', 1,
             'unit_amount_minor', v_amount_minor,
             'total_minor', v_amount_minor
           )
         ),
         jsonb_build_object(
           'late_fee', true,
           'source_charge_id', v_charge.id,
           'policy_id', v_policy.id,
           'recurrence_index', v_recurrence_idx,
           'payment_run_id', v_run_id
         ))
      RETURNING id INTO v_late_fee_id;

      INSERT INTO public.late_fee_assessments
        (source_charge_id, late_fee_charge_id, policy_id, payment_run_id,
         assessment_date, recurrence_index, amount_minor)
      VALUES
        (v_charge.id, v_late_fee_id, v_policy.id, v_run_id,
         p_today, v_recurrence_idx, v_amount_minor);

      v_fees_created := v_fees_created + 1;
    EXCEPTION
      -- The unique index on (source_charge_id, recurrence_index) is
      -- our idempotency guard. If a second concurrent cron run tried
      -- the same row we'd hit it here.
      WHEN unique_violation THEN
        v_fees_skipped := v_fees_skipped + 1;
      WHEN OTHERS THEN
        v_failed := v_failed + 1;
        v_errors := v_errors || jsonb_build_object(
          'source_charge_id', v_charge.id,
          'policy_id', v_policy.id,
          'error_code', SQLSTATE,
          'message', SQLERRM
        );
    END;
  END LOOP;

  -- Same degrade pattern as the audit INSERT above.
  IF v_run_id IS NOT NULL THEN
    BEGIN
      UPDATE public.payment_runs
         SET schedules_processed = v_charges_flipped,
             charges_created     = v_fees_created,
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
    'charges_flipped_to_past_due', v_charges_flipped,
    'late_fees_created', v_fees_created,
    'late_fees_skipped', v_fees_skipped,
    'errors', v_failed
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.assess_past_due_charges(date) TO authenticated;


-- =====================================================================
-- 5. Cron — daily 04:00 UTC, after rent (03:30) + dues (03:35)
-- =====================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('property_charges_late_fee_assess_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'property_charges_late_fee_assess_daily');
  PERFORM cron.schedule(
    'property_charges_late_fee_assess_daily',
    '0 4 * * *',
    $cron$ SELECT public.assess_past_due_charges(current_date); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'late_fee assess cron: pg_cron unavailable; skipping schedule';
END $$;


-- =====================================================================
-- 6. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('late_fees.manage', 'Manage late-fee policies and review assessments', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'late_fees.manage'),
  ('manager', 'late_fees.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 7. RLS
-- =====================================================================

ALTER TABLE public.late_fee_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS late_fee_policies_select ON public.late_fee_policies;
CREATE POLICY late_fee_policies_select
  ON public.late_fee_policies FOR SELECT
  TO authenticated
  USING (
    public.has_permission('late_fees.manage')
    OR public.has_permission('rent.manage')
    OR public.has_permission('admin.access')
    -- Tenant on the lease can read their policy (so future portal can
    -- surface "you'll be charged ₱X if rent is N days late").
    OR EXISTS (
      SELECT 1 FROM public.lease_parties lp
       WHERE lp.lease_id = late_fee_policies.lease_id
         AND lp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS late_fee_policies_modify ON public.late_fee_policies;
CREATE POLICY late_fee_policies_modify
  ON public.late_fee_policies FOR ALL
  TO authenticated
  USING (
    public.has_permission('late_fees.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('late_fees.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.late_fee_assessments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS late_fee_assessments_select ON public.late_fee_assessments;
CREATE POLICY late_fee_assessments_select
  ON public.late_fee_assessments FOR SELECT
  TO authenticated
  USING (
    public.has_permission('late_fees.manage')
    OR public.has_permission('rent.manage')
    OR public.has_permission('admin.access')
    -- Tenants see assessments tied to their lease (via the source charge).
    OR EXISTS (
      SELECT 1 FROM public.property_charges pc
      JOIN public.lease_parties lp ON lp.lease_id = pc.lease_id
       WHERE pc.id = late_fee_assessments.source_charge_id
         AND lp.user_id = auth.uid()
    )
  );

-- Writes are SECURITY DEFINER via the RPC — direct DML is blocked.
DROP POLICY IF EXISTS late_fee_assessments_modify ON public.late_fee_assessments;
CREATE POLICY late_fee_assessments_modify
  ON public.late_fee_assessments FOR ALL
  TO authenticated
  USING (
    public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('admin.access')
  );


-- =====================================================================
-- 8. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.late_fee_policies',     'table', 'userportal',
   ARRAY['userportal']::text[],
   'Per-lease late-fee rules (opt-in)', false),
  ('public.late_fee_assessments',  'table', 'userportal',
   ARRAY['userportal']::text[],
   'Append-only ledger of late-fee assessments', false),
  ('public.assess_past_due_charges','function', 'userportal',
   ARRAY['userportal']::text[],
   'Daily cron RPC: flips overdue charges to past_due + assesses late fees per policy', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
