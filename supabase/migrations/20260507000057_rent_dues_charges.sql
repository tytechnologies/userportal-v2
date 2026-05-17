-- Rent + Dues + Payment Runs.
--
-- C5 of the post-audit roadmap. Adds the recurring billing engine
-- that turns leases.rent_minor / dues_schedules into actual
-- property_charges rows month-after-month.
--
-- This is DISTINCT from B6 invoices (platform billing org). C5
-- charges are landlord-billing-tenant (rent) and org-billing-owner
-- (dues). Patterns rhyme, parties differ.
--
-- Existing surfaces preserved:
--   - leases, units, lease_parties      — unchanged.
--   - invoices (B6), payment_intents    — unchanged. Charges link to
--                                         payment_intents when settled
--                                         via the gateway.
--   - tenant_statements (C3)             — unchanged. Stays the
--                                         per-period summary that
--                                         aggregates charges + payments.
--
-- ROLLBACK:
--   SELECT cron.unschedule('property_charges_dues_daily');
--   SELECT cron.unschedule('property_charges_rent_daily');
--   DROP TRIGGER IF EXISTS property_charges_post_guard ON public.property_charges;
--   DROP FUNCTION IF EXISTS public.property_charges_post_guard_fn();
--   DROP FUNCTION IF EXISTS public.record_property_charge_failure(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.record_property_charge_payment(uuid, bigint, uuid);
--   DROP FUNCTION IF EXISTS public.generate_dues_charges(date);
--   DROP FUNCTION IF EXISTS public.generate_rent_charges(date);
--   DROP FUNCTION IF EXISTS public.next_property_charge_no();
--   DROP TABLE IF EXISTS public.property_charges;
--   DROP TABLE IF EXISTS public.payment_runs;
--   DROP TABLE IF EXISTS public.dues_schedules;
--   DROP TABLE IF EXISTS public.rent_schedules;
--   DROP SEQUENCE IF EXISTS public.property_charge_seq;
--   DELETE FROM public.role_permissions WHERE permission IN
--     ('rent.manage', 'dues.manage');
--   DELETE FROM public.permissions WHERE name IN
--     ('rent.manage', 'dues.manage');
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.rent_schedules', 'public.dues_schedules',
--      'public.property_charges', 'public.payment_runs');


-- =====================================================================
-- 1. rent_schedules — recurring rent obligation per lease
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.rent_schedules (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  lease_id                    uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  tenant_party_id             uuid REFERENCES public.lease_parties(id) ON DELETE SET NULL,

  currency                    text NOT NULL DEFAULT 'PHP',
  amount_minor                bigint NOT NULL CHECK (amount_minor >= 0),

  -- Documented values: 'monthly' | 'quarterly' | 'annual'.
  period                      text NOT NULL DEFAULT 'monthly'
                                   CHECK (period IN ('monthly', 'quarterly', 'annual')),

  -- 1..28; capped to avoid month-length edge cases.
  billing_day                 int NOT NULL CHECK (billing_day BETWEEN 1 AND 28),

  next_due_at                 date NOT NULL,
  last_charged_at             date,

  -- Snapshot from lease — operator can override per schedule.
  escalation_kind             text NOT NULL DEFAULT 'none'
                                   CHECK (escalation_kind IN
                                     ('none', 'fixed_amount', 'percent', 'cpi_index')),
  escalation_value            numeric(12,4) DEFAULT 0,
  escalation_period_months    int CHECK (escalation_period_months IS NULL
                                          OR escalation_period_months > 0),

  status                      text NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active', 'paused', 'ended')),

  -- Operator opts in to cron generation. Default false to avoid
  -- accidental charges on freshly-created schedules.
  auto_generate               boolean NOT NULL DEFAULT false,

  effective_at                timestamptz NOT NULL DEFAULT now(),
  ended_at                    timestamptz,

  notes                       text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CHECK (ended_at IS NULL OR ended_at > effective_at)
);

CREATE INDEX IF NOT EXISTS rent_schedules_lease_idx
  ON public.rent_schedules(lease_id, status);
CREATE INDEX IF NOT EXISTS rent_schedules_due_idx
  ON public.rent_schedules(next_due_at)
  WHERE status = 'active' AND auto_generate = true;

DROP TRIGGER IF EXISTS set_rent_schedules_updated_at ON public.rent_schedules;
CREATE TRIGGER set_rent_schedules_updated_at
  BEFORE UPDATE ON public.rent_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 2. dues_schedules — HOA / condo / parking dues per unit
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.dues_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id             uuid NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,

  -- Documented values: 'condo_dues', 'hoa_dues', 'parking',
  -- 'utilities', 'special_assessment', 'other'.
  dues_type           text NOT NULL,

  -- 'owner' | 'tenant'. Application chooses which active lease /
  -- unit owner gets billed at charge-creation time.
  billing_target      text NOT NULL DEFAULT 'owner'
                           CHECK (billing_target IN ('owner', 'tenant')),

  currency            text NOT NULL DEFAULT 'PHP',
  amount_minor        bigint NOT NULL CHECK (amount_minor >= 0),

  period              text NOT NULL DEFAULT 'monthly'
                           CHECK (period IN ('monthly', 'quarterly', 'annual')),
  billing_day         int NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
  next_due_at         date NOT NULL,
  last_charged_at     date,

  status              text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'paused', 'ended')),
  auto_generate       boolean NOT NULL DEFAULT false,

  effective_at        timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,

  notes               text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (ended_at IS NULL OR ended_at > effective_at)
);

CREATE INDEX IF NOT EXISTS dues_schedules_unit_idx
  ON public.dues_schedules(unit_id, status);
CREATE INDEX IF NOT EXISTS dues_schedules_due_idx
  ON public.dues_schedules(next_due_at)
  WHERE status = 'active' AND auto_generate = true;

DROP TRIGGER IF EXISTS set_dues_schedules_updated_at ON public.dues_schedules;
CREATE TRIGGER set_dues_schedules_updated_at
  BEFORE UPDATE ON public.dues_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 3. property_charge sequence + helper
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS public.property_charge_seq START 1000;

CREATE OR REPLACE FUNCTION public.next_property_charge_no()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN format(
    'PC-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.property_charge_seq')::text, 6, '0')
  );
END;
$$;


-- =====================================================================
-- 4. property_charges — charge ledger
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.property_charges (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  charge_no                   text NOT NULL UNIQUE
                                   DEFAULT public.next_property_charge_no(),

  -- Documented kinds.
  kind                        text NOT NULL CHECK (kind IN
                                   ('rent', 'dues', 'maintenance_pass_through',
                                    'damage', 'late_fee', 'security_deposit',
                                    'adjustment')),

  unit_id                     uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  lease_id                    uuid REFERENCES public.leases(id) ON DELETE SET NULL,

  rent_schedule_id            uuid REFERENCES public.rent_schedules(id) ON DELETE SET NULL,
  dues_schedule_id            uuid REFERENCES public.dues_schedules(id) ON DELETE SET NULL,
  work_order_id               uuid REFERENCES public.work_orders(id) ON DELETE SET NULL,

  -- Charged-to identity.
  charged_to_user_id          uuid   REFERENCES public.profiles(id) ON DELETE SET NULL,
  charged_to_contact_id       bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  charged_to_external_name    text,
  charged_to_external_email   text,

  billing_target              text NOT NULL CHECK (billing_target IN ('owner', 'tenant')),

  period_start                date,
  period_end                  date,

  currency                    text NOT NULL DEFAULT 'PHP',
  subtotal_minor              bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor                   bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor                 bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  amount_paid_minor           bigint NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),

  status                      text NOT NULL DEFAULT 'draft'
                                   CHECK (status IN
                                     ('draft', 'open', 'paid',
                                      'past_due', 'void', 'forgiven')),

  issued_at                   timestamptz,
  due_at                      timestamptz,
  paid_at                     timestamptz,
  voided_at                   timestamptz,
  void_reason                 text,

  payment_intent_id           uuid REFERENCES public.payment_intents(id) ON DELETE SET NULL,
  external_reference          text,

  -- Each: { description, quantity, unit_amount_minor, total_minor }
  line_items                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes                       text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CHECK (period_end IS NULL OR period_end >= period_start),
  -- Charged-to identity: at least one column when not draft.
  CHECK (
    status = 'draft'
    OR charged_to_user_id IS NOT NULL
    OR charged_to_contact_id IS NOT NULL
    OR charged_to_external_email IS NOT NULL
    OR charged_to_external_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS property_charges_unit_idx
  ON public.property_charges(unit_id, period_start DESC);
CREATE INDEX IF NOT EXISTS property_charges_lease_idx
  ON public.property_charges(lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS property_charges_status_idx
  ON public.property_charges(status, due_at)
  WHERE status IN ('open', 'past_due');
CREATE INDEX IF NOT EXISTS property_charges_charged_user_idx
  ON public.property_charges(charged_to_user_id) WHERE charged_to_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS property_charges_kind_idx
  ON public.property_charges(kind, period_start DESC);

-- Prevent duplicate rent charge per (schedule, period).
CREATE UNIQUE INDEX IF NOT EXISTS property_charges_one_per_rent_period
  ON public.property_charges(rent_schedule_id, period_start)
  WHERE rent_schedule_id IS NOT NULL AND status <> 'void';

CREATE UNIQUE INDEX IF NOT EXISTS property_charges_one_per_dues_period
  ON public.property_charges(dues_schedule_id, period_start)
  WHERE dues_schedule_id IS NOT NULL AND status <> 'void';

DROP TRIGGER IF EXISTS set_property_charges_updated_at ON public.property_charges;
CREATE TRIGGER set_property_charges_updated_at
  BEFORE UPDATE ON public.property_charges
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 5. payment_runs — cron audit
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.payment_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'rent' | 'dues' | 'manual'.
  run_kind            text NOT NULL CHECK (run_kind IN ('rent', 'dues', 'manual')),
  period_for          date NOT NULL,

  schedules_processed int NOT NULL DEFAULT 0,
  charges_created     int NOT NULL DEFAULT 0,
  charges_failed      int NOT NULL DEFAULT 0,
  -- Each entry: { schedule_id, error_code, message }
  errors              jsonb NOT NULL DEFAULT '[]'::jsonb,

  status              text NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running', 'completed', 'failed')),

  triggered_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS payment_runs_kind_idx
  ON public.payment_runs(run_kind, period_for DESC);
CREATE INDEX IF NOT EXISTS payment_runs_status_idx
  ON public.payment_runs(status, started_at DESC);


-- =====================================================================
-- 6. property_charges_post_guard — append-only on issued
-- =====================================================================

CREATE OR REPLACE FUNCTION public.property_charges_post_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Drafts: free-form. Auto-stamp issued_at on draft -> open.
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'open' AND NEW.issued_at IS NULL THEN
      NEW.issued_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- Void: terminal.
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'property_charges: void rows cannot be modified';
  END IF;

  -- Allow status -> void with reason.
  IF NEW.status = 'void' THEN
    IF NEW.voided_at IS NULL THEN NEW.voided_at := now(); END IF;
    IF coalesce(NEW.void_reason, '') = '' THEN
      RAISE EXCEPTION 'property_charges: void requires void_reason';
    END IF;
    -- Lock economic fields.
    NEW.subtotal_minor    := OLD.subtotal_minor;
    NEW.tax_minor         := OLD.tax_minor;
    NEW.total_minor       := OLD.total_minor;
    NEW.amount_paid_minor := OLD.amount_paid_minor;
    NEW.line_items        := OLD.line_items;
    NEW.kind              := OLD.kind;
    NEW.unit_id           := OLD.unit_id;
    NEW.period_start      := OLD.period_start;
    NEW.period_end        := OLD.period_end;
    RETURN NEW;
  END IF;

  -- Allow status -> forgiven (write-off).
  IF NEW.status = 'forgiven' AND OLD.status IN ('open', 'past_due') THEN
    -- Same field-lock as void.
    NEW.subtotal_minor    := OLD.subtotal_minor;
    NEW.tax_minor         := OLD.tax_minor;
    NEW.total_minor       := OLD.total_minor;
    NEW.line_items        := OLD.line_items;
    NEW.kind              := OLD.kind;
    NEW.unit_id           := OLD.unit_id;
    NEW.period_start      := OLD.period_start;
    NEW.period_end        := OLD.period_end;
    RETURN NEW;
  END IF;

  -- Allow status: open -> paid / past_due (and back to open via correction).
  -- amount_paid_minor and paid_at are mutable; other economic fields locked.
  IF OLD.status IN ('open', 'paid', 'past_due', 'forgiven') THEN
    IF NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
       OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
       OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
       OR NEW.line_items IS DISTINCT FROM OLD.line_items
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
    THEN
      RAISE EXCEPTION 'property_charges: economic fields locked once issued. Insert a void + new charge.';
    END IF;
  END IF;

  -- Auto-stamp paid_at on transition to paid.
  IF OLD.status IN ('open', 'past_due') AND NEW.status = 'paid' AND NEW.paid_at IS NULL THEN
    NEW.paid_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS property_charges_post_guard ON public.property_charges;
CREATE TRIGGER property_charges_post_guard
  BEFORE UPDATE ON public.property_charges
  FOR EACH ROW EXECUTE FUNCTION public.property_charges_post_guard_fn();


-- =====================================================================
-- 7. generate_rent_charges — cron RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.generate_rent_charges(p_period_for date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id     uuid;
  v_processed  int := 0;
  v_created    int := 0;
  v_failed     int := 0;
  v_errors     jsonb := '[]'::jsonb;
  v_schedule   record;
  v_charge_id  uuid;
  v_period_start date;
  v_period_end   date;
  v_next_due_at  date;
BEGIN
  IF NOT (
    public.has_permission('rent.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'generate_rent_charges: permission denied' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.payment_runs (run_kind, period_for, triggered_by)
  VALUES ('rent', p_period_for, auth.uid())
  RETURNING id INTO v_run_id;

  FOR v_schedule IN
    SELECT rs.id, rs.lease_id, rs.tenant_party_id, rs.amount_minor, rs.currency,
           rs.period, rs.billing_day, rs.next_due_at,
           l.unit_id, l.expires_at AS lease_expires_at, l.status AS lease_status
    FROM public.rent_schedules rs
    JOIN public.leases l ON l.id = rs.lease_id
    WHERE rs.status = 'active'
      AND rs.auto_generate = true
      AND rs.next_due_at <= p_period_for
      AND (rs.ended_at IS NULL OR rs.ended_at > now())
  LOOP
    v_processed := v_processed + 1;

    -- Skip if lease is no longer active.
    IF v_schedule.lease_status NOT IN ('active') THEN
      v_errors := v_errors || jsonb_build_object(
        'schedule_id', v_schedule.id,
        'error_code', 'lease_not_active',
        'message', format('lease status is %s', v_schedule.lease_status));
      v_failed := v_failed + 1;
      CONTINUE;
    END IF;

    v_period_start := v_schedule.next_due_at;
    v_period_end := CASE v_schedule.period
      WHEN 'monthly'   THEN (v_schedule.next_due_at + interval '1 month' - interval '1 day')::date
      WHEN 'quarterly' THEN (v_schedule.next_due_at + interval '3 months' - interval '1 day')::date
      WHEN 'annual'    THEN (v_schedule.next_due_at + interval '1 year' - interval '1 day')::date
    END;
    v_next_due_at := CASE v_schedule.period
      WHEN 'monthly'   THEN (v_schedule.next_due_at + interval '1 month')::date
      WHEN 'quarterly' THEN (v_schedule.next_due_at + interval '3 months')::date
      WHEN 'annual'    THEN (v_schedule.next_due_at + interval '1 year')::date
    END;

    BEGIN
      INSERT INTO public.property_charges
        (kind, unit_id, lease_id, rent_schedule_id,
         billing_target,
         period_start, period_end,
         currency, subtotal_minor, total_minor,
         status, due_at, line_items, metadata)
      SELECT
        'rent',
        v_schedule.unit_id,
        v_schedule.lease_id,
        v_schedule.id,
        'tenant',
        v_period_start,
        v_period_end,
        v_schedule.currency,
        v_schedule.amount_minor,
        v_schedule.amount_minor,
        'open',
        (v_period_start::timestamptz + interval '23 hours 59 minutes 59 seconds'),
        jsonb_build_array(
          jsonb_build_object(
            'description', format('Rent for %s to %s', v_period_start, v_period_end),
            'quantity', 1,
            'unit_amount_minor', v_schedule.amount_minor,
            'total_minor', v_schedule.amount_minor
          )
        ),
        jsonb_build_object('payment_run_id', v_run_id);

      v_created := v_created + 1;

      UPDATE public.rent_schedules
         SET next_due_at     = v_next_due_at,
             last_charged_at = v_period_start
       WHERE id = v_schedule.id;
    EXCEPTION
      -- Partial-unique violation (already charged for this period) is benign.
      WHEN unique_violation THEN
        v_errors := v_errors || jsonb_build_object(
          'schedule_id', v_schedule.id,
          'error_code', 'duplicate_period',
          'message', SQLERRM);
        -- Still advance the schedule to avoid re-trying the same period.
        UPDATE public.rent_schedules
           SET next_due_at = v_next_due_at,
               last_charged_at = v_period_start
         WHERE id = v_schedule.id;
      WHEN OTHERS THEN
        v_errors := v_errors || jsonb_build_object(
          'schedule_id', v_schedule.id,
          'error_code', SQLSTATE,
          'message', SQLERRM);
        v_failed := v_failed + 1;
    END;
  END LOOP;

  UPDATE public.payment_runs
     SET schedules_processed = v_processed,
         charges_created     = v_created,
         charges_failed      = v_failed,
         errors              = v_errors,
         status              = 'completed',
         completed_at        = now()
   WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'processed', v_processed,
    'created', v_created,
    'failed', v_failed
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_rent_charges(date) TO authenticated;


-- =====================================================================
-- 8. generate_dues_charges — cron RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.generate_dues_charges(p_period_for date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id     uuid;
  v_processed  int := 0;
  v_created    int := 0;
  v_failed     int := 0;
  v_errors     jsonb := '[]'::jsonb;
  v_schedule   record;
  v_period_start date;
  v_period_end   date;
  v_next_due_at  date;
  v_lease_id     uuid;
BEGIN
  IF NOT (
    public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'generate_dues_charges: permission denied' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.payment_runs (run_kind, period_for, triggered_by)
  VALUES ('dues', p_period_for, auth.uid())
  RETURNING id INTO v_run_id;

  FOR v_schedule IN
    SELECT id, unit_id, dues_type, billing_target,
           amount_minor, currency, period, billing_day, next_due_at
    FROM public.dues_schedules
    WHERE status = 'active'
      AND auto_generate = true
      AND next_due_at <= p_period_for
      AND (ended_at IS NULL OR ended_at > now())
  LOOP
    v_processed := v_processed + 1;

    -- For tenant-billed dues, find the active lease on the unit (if any).
    IF v_schedule.billing_target = 'tenant' THEN
      SELECT id INTO v_lease_id
      FROM public.leases
      WHERE unit_id = v_schedule.unit_id AND status = 'active'
      LIMIT 1;
    ELSE
      v_lease_id := NULL;
    END IF;

    v_period_start := v_schedule.next_due_at;
    v_period_end := CASE v_schedule.period
      WHEN 'monthly'   THEN (v_schedule.next_due_at + interval '1 month' - interval '1 day')::date
      WHEN 'quarterly' THEN (v_schedule.next_due_at + interval '3 months' - interval '1 day')::date
      WHEN 'annual'    THEN (v_schedule.next_due_at + interval '1 year' - interval '1 day')::date
    END;
    v_next_due_at := CASE v_schedule.period
      WHEN 'monthly'   THEN (v_schedule.next_due_at + interval '1 month')::date
      WHEN 'quarterly' THEN (v_schedule.next_due_at + interval '3 months')::date
      WHEN 'annual'    THEN (v_schedule.next_due_at + interval '1 year')::date
    END;

    BEGIN
      INSERT INTO public.property_charges
        (kind, unit_id, lease_id, dues_schedule_id,
         billing_target,
         period_start, period_end,
         currency, subtotal_minor, total_minor,
         status, due_at, line_items, metadata)
      SELECT
        'dues',
        v_schedule.unit_id,
        v_lease_id,
        v_schedule.id,
        v_schedule.billing_target,
        v_period_start,
        v_period_end,
        v_schedule.currency,
        v_schedule.amount_minor,
        v_schedule.amount_minor,
        'open',
        (v_period_start::timestamptz + interval '23 hours 59 minutes 59 seconds'),
        jsonb_build_array(
          jsonb_build_object(
            'description', format('%s for %s to %s', v_schedule.dues_type, v_period_start, v_period_end),
            'quantity', 1,
            'unit_amount_minor', v_schedule.amount_minor,
            'total_minor', v_schedule.amount_minor
          )
        ),
        jsonb_build_object('payment_run_id', v_run_id, 'dues_type', v_schedule.dues_type);

      v_created := v_created + 1;

      UPDATE public.dues_schedules
         SET next_due_at     = v_next_due_at,
             last_charged_at = v_period_start
       WHERE id = v_schedule.id;
    EXCEPTION
      WHEN unique_violation THEN
        v_errors := v_errors || jsonb_build_object(
          'schedule_id', v_schedule.id,
          'error_code', 'duplicate_period',
          'message', SQLERRM);
        UPDATE public.dues_schedules
           SET next_due_at = v_next_due_at,
               last_charged_at = v_period_start
         WHERE id = v_schedule.id;
      WHEN OTHERS THEN
        v_errors := v_errors || jsonb_build_object(
          'schedule_id', v_schedule.id,
          'error_code', SQLSTATE,
          'message', SQLERRM);
        v_failed := v_failed + 1;
    END;
  END LOOP;

  UPDATE public.payment_runs
     SET schedules_processed = v_processed,
         charges_created     = v_created,
         charges_failed      = v_failed,
         errors              = v_errors,
         status              = 'completed',
         completed_at        = now()
   WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'processed', v_processed,
    'created', v_created,
    'failed', v_failed
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_dues_charges(date) TO authenticated;


-- =====================================================================
-- 9. record_property_charge_payment + failure
-- =====================================================================

CREATE OR REPLACE FUNCTION public.record_property_charge_payment(
  p_charge_id     uuid,
  p_amount_minor  bigint,
  p_intent_id     uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT (
    public.has_permission('rent.manage')
    OR public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'record_property_charge_payment: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_status FROM public.property_charges WHERE id = p_charge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_property_charge_payment: charge not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'paid' THEN
    -- Idempotent.
    RETURN p_charge_id;
  END IF;
  IF v_status IN ('void', 'forgiven') THEN
    RAISE EXCEPTION 'record_property_charge_payment: charge in terminal status %', v_status;
  END IF;

  UPDATE public.property_charges
     SET status            = 'paid',
         paid_at           = now(),
         amount_paid_minor = greatest(amount_paid_minor, p_amount_minor),
         payment_intent_id = coalesce(p_intent_id, payment_intent_id)
   WHERE id = p_charge_id;

  RETURN p_charge_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_property_charge_payment(uuid, bigint, uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.record_property_charge_failure(
  p_charge_id     uuid,
  p_failure_code  text,
  p_message       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT (
    public.has_permission('rent.manage')
    OR public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'record_property_charge_failure: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_status FROM public.property_charges WHERE id = p_charge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_property_charge_failure: charge not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status IN ('paid', 'void', 'forgiven') THEN
    -- No-op on terminal/paid.
    RETURN p_charge_id;
  END IF;

  UPDATE public.property_charges
     SET status   = 'past_due',
         metadata = metadata || jsonb_build_object(
           'last_failure_code',    p_failure_code,
           'last_failure_message', p_message,
           'last_failure_at',      now()::text
         )
   WHERE id = p_charge_id;

  RETURN p_charge_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_property_charge_failure(uuid, text, text) TO authenticated;


-- =====================================================================
-- 10. Crons
-- =====================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('property_charges_rent_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'property_charges_rent_daily');
  PERFORM cron.schedule(
    'property_charges_rent_daily',
    '30 3 * * *',
    $cron$ SELECT public.generate_rent_charges(current_date); $cron$
  );

  PERFORM cron.unschedule('property_charges_dues_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'property_charges_dues_daily');
  PERFORM cron.schedule(
    'property_charges_dues_daily',
    '35 3 * * *',
    $cron$ SELECT public.generate_dues_charges(current_date); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'property_charges crons: pg_cron unavailable; skipping schedule';
END $$;


-- =====================================================================
-- 11. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('rent.manage', 'Manage rent schedules and rent charges', 'property'),
  ('dues.manage', 'Manage dues schedules and dues charges', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'rent.manage'),
  ('admin',   'dues.manage'),
  ('manager', 'rent.manage'),
  ('manager', 'dues.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 12. RLS
-- =====================================================================

ALTER TABLE public.rent_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rent_schedules_select ON public.rent_schedules;
CREATE POLICY rent_schedules_select ON public.rent_schedules FOR SELECT
  TO authenticated
  USING (
    public.has_permission('rent.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.lease_parties lp
       WHERE lp.lease_id = rent_schedules.lease_id AND lp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS rent_schedules_modify ON public.rent_schedules;
CREATE POLICY rent_schedules_modify ON public.rent_schedules FOR ALL
  TO authenticated
  USING (
    public.has_permission('rent.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('rent.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.dues_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dues_schedules_select ON public.dues_schedules;
CREATE POLICY dues_schedules_select ON public.dues_schedules FOR SELECT
  TO authenticated
  USING (
    public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.unit_owners uo
      JOIN public.property_owners po ON po.id = uo.owner_id
       WHERE uo.unit_id = dues_schedules.unit_id
         AND uo.ended_at IS NULL
         AND po.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS dues_schedules_modify ON public.dues_schedules;
CREATE POLICY dues_schedules_modify ON public.dues_schedules FOR ALL
  TO authenticated
  USING (
    public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.property_charges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_charges_select ON public.property_charges;
CREATE POLICY property_charges_select ON public.property_charges FOR SELECT
  TO authenticated
  USING (
    public.has_permission('rent.manage')
    OR public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
    OR charged_to_user_id = auth.uid()
    OR (
      -- Tenant on the lease sees rent charges
      lease_id IS NOT NULL
      AND billing_target = 'tenant'
      AND EXISTS (
        SELECT 1 FROM public.lease_parties lp
         WHERE lp.lease_id = property_charges.lease_id AND lp.user_id = auth.uid()
      )
    )
    OR (
      -- Owner of the unit sees owner-billed charges
      billing_target = 'owner'
      AND EXISTS (
        SELECT 1 FROM public.unit_owners uo
        JOIN public.property_owners po ON po.id = uo.owner_id
         WHERE uo.unit_id = property_charges.unit_id
           AND uo.ended_at IS NULL
           AND po.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS property_charges_modify ON public.property_charges;
CREATE POLICY property_charges_modify ON public.property_charges FOR ALL
  TO authenticated
  USING (
    public.has_permission('rent.manage')
    OR public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('rent.manage')
    OR public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.payment_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_runs_select ON public.payment_runs;
CREATE POLICY payment_runs_select ON public.payment_runs FOR SELECT
  TO authenticated
  USING (
    public.has_permission('rent.manage')
    OR public.has_permission('dues.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 13. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.rent_schedules',     'table', 'userportal',
   ARRAY['userportal']::text[], 'Recurring rent obligations per lease',  false),
  ('public.dues_schedules',     'table', 'userportal',
   ARRAY['userportal']::text[], 'Recurring HOA / condo dues per unit',   false),
  ('public.property_charges',   'table', 'userportal',
   ARRAY['userportal']::text[], 'Charge ledger (rent / dues / ad-hoc)',  false),
  ('public.payment_runs',       'table', 'userportal',
   ARRAY['userportal']::text[], 'Cron-run audit',                        false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
