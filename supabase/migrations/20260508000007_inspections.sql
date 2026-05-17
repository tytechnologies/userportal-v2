-- Inspection workflows.
--
-- Net-new PM domain — until today move-in / move-out condition
-- reports were "ad-hoc milestones in deal_milestones". This migration
-- adds first-class structured inspections with per-finding evidence
-- and a path from damaged findings → property_charges (kind='damage'
-- already exists in the kind CHECK on rent_dues_charges).
--
-- Two tables:
--   inspections           — the inspection event (move_in / move_out /
--                           mid_tenancy / maintenance / annual)
--   inspection_findings   — per-area / per-item observations with
--                           condition rating, photos, optional damage
--                           cost estimate, and FK to the damage charge
--                           if one was raised
--
-- Three RPCs:
--   inspection_complete()         — locks findings, transitions to
--                                   'completed'; requires ≥1 finding
--   inspection_tenant_sign()      — tenant attestation. Stamps
--                                   tenant_signed_at + signature blob;
--                                   transitions to 'tenant_signed'
--   inspection_charge_damages()   — for completed move-out inspections,
--                                   creates property_charges (kind=
--                                   'damage', billing_target='tenant')
--                                   for findings flagged is_damage with
--                                   estimated_cost_minor > 0. Idempotent
--                                   via inspection_findings.damage_charge_id.
--
-- Existing surfaces preserved:
--   - leases, lease_parties, units, unit_occupancy (read-only)
--   - property_charges (we INSERT 'damage' rows; kind already in CHECK)
--   - profiles, has_permission, audit, governance (unchanged)
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.inspection_charge_damages(uuid);
--   DROP FUNCTION IF EXISTS public.inspection_tenant_sign(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.inspection_complete(uuid);
--   DROP FUNCTION IF EXISTS public.next_inspection_no();
--   DROP TABLE IF EXISTS public.inspection_findings;
--   DROP TABLE IF EXISTS public.inspections;
--   DROP SEQUENCE IF EXISTS public.inspection_seq;
--   DELETE FROM public.role_permissions WHERE permission = 'inspections.manage';
--   DELETE FROM public.permissions WHERE name = 'inspections.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.inspections',
--      'public.inspection_findings',
--      'public.inspection_complete',
--      'public.inspection_tenant_sign',
--      'public.inspection_charge_damages');


-- =====================================================================
-- 0. Hard preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='units') THEN
    v_missing := v_missing || 'public.units';
  END IF;
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
    RAISE EXCEPTION 'Migration 20260508000007 requires tables: %. These come from earlier migrations (20260507000054 leases, 20260507000057 rent_dues_charges, plus the units table). Apply the missing migrations first, then re-run this one.', array_to_string(v_missing, ', ');
  END IF;
END $$;


-- =====================================================================
-- 1. inspection_no sequence + helper
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS public.inspection_seq START 1000;

CREATE OR REPLACE FUNCTION public.next_inspection_no()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN format(
    'INS-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.inspection_seq')::text, 6, '0')
  );
END;
$$;


-- =====================================================================
-- 2. inspections — the inspection event
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.inspections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  inspection_no            text NOT NULL UNIQUE
                                DEFAULT public.next_inspection_no(),

  unit_id                  uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  -- Optional FK to the lease this inspection is associated with.
  -- A move-in inspection stamps the lease activation; a move-out
  -- stamps termination; mid-tenancy inspections stay attached.
  lease_id                 uuid REFERENCES public.leases(id) ON DELETE SET NULL,
  -- Optional FK to the unit_occupancy row this records.
  unit_occupancy_id        uuid,

  -- Documented values:
  --   move_in        — baseline before tenant takes possession
  --   move_out       — exit; compared against move-in baseline
  --   mid_tenancy    — periodic during a lease (compliance, smoke alarm)
  --   maintenance    — pre/post a vendor work order
  --   annual         — landlord annual walk-through
  inspection_kind          text NOT NULL CHECK (inspection_kind IN
                              ('move_in', 'move_out', 'mid_tenancy',
                               'maintenance', 'annual')),

  -- Inspector identity (≥1 of user_id / external_name required).
  inspector_user_id        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  inspector_external_name  text,

  -- Optional tenant attestation. Signature is jsonb so we can support
  -- typed name, click-to-attest, and PNG signature blob without a
  -- schema migration:
  --   { kind: 'typed' | 'click' | 'png_data',
  --     value: string,
  --     ip: string?,
  --     user_agent: string? }
  tenant_party_id          uuid REFERENCES public.lease_parties(id) ON DELETE SET NULL,
  tenant_signed_at         timestamptz,
  tenant_signature         jsonb,

  scheduled_at             timestamptz,
  conducted_at             timestamptz,

  -- State machine.
  --   scheduled    — created; no findings yet; editable
  --   in_progress  — findings being captured; editable
  --   completed    — findings locked; awaiting tenant signature
  --   tenant_signed — tenant attested; fully immutable except status flips
  --   cancelled    — terminal
  status                   text NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN
                                ('scheduled', 'in_progress',
                                 'completed', 'tenant_signed', 'cancelled')),

  -- Aggregate condition rollup (NULL until status>=completed).
  overall_condition        text CHECK (overall_condition IS NULL
                                       OR overall_condition IN
                                         ('excellent', 'good', 'fair',
                                          'poor', 'unhabitable')),
  summary_notes            text,

  -- Damage roll-up: total estimated_cost_minor across all is_damage findings.
  -- Computed on inspection_complete and stored for fast read.
  total_damage_estimate_minor bigint NOT NULL DEFAULT 0
                              CHECK (total_damage_estimate_minor >= 0),

  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CHECK (
    inspector_user_id IS NOT NULL
    OR inspector_external_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS inspections_unit_idx
  ON public.inspections(unit_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS inspections_lease_idx
  ON public.inspections(lease_id, scheduled_at DESC)
  WHERE lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inspections_status_idx
  ON public.inspections(status, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS inspections_inspector_idx
  ON public.inspections(inspector_user_id) WHERE inspector_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_inspections_updated_at ON public.inspections;
CREATE TRIGGER set_inspections_updated_at
  BEFORE UPDATE ON public.inspections
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.inspections IS
  'PM inspection event (move_in/move_out/mid_tenancy/maintenance/annual). State machine: scheduled → in_progress → completed → tenant_signed; cancelled is terminal. Findings live in inspection_findings.';


-- =====================================================================
-- 3. inspection_findings — per-area, per-item observations
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.inspection_findings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  inspection_id            uuid NOT NULL REFERENCES public.inspections(id) ON DELETE CASCADE,

  -- Free-form area + item to keep the schema flexible. Documented
  -- area values: 'kitchen', 'living_room', 'bedroom_1' (..N),
  --              'bathroom_master' (etc), 'utility', 'parking',
  --              'balcony', 'common_area', 'exterior'
  -- Documented item values: 'walls', 'floor', 'ceiling', 'doors',
  --              'windows', 'plumbing', 'electrical', 'appliances',
  --              'fixtures', 'cabinetry', 'security', 'overall'
  area                     text NOT NULL,
  item                     text NOT NULL,

  -- Documented values. The two highest grades indicate no action.
  condition                text NOT NULL CHECK (condition IN
                              ('excellent', 'good', 'fair',
                               'damaged', 'requires_repair',
                               'requires_replacement', 'missing')),
  description              text,

  -- For move-out inspections: optional FK back to the corresponding
  -- move-in finding so the comparison is preserved in the record.
  baseline_finding_id      uuid REFERENCES public.inspection_findings(id) ON DELETE SET NULL,

  -- Operator-flagged: this finding is a tenant-chargeable damage
  -- (vs normal wear & tear). Set during inspection editing; consumed
  -- by inspection_charge_damages().
  is_damage                boolean NOT NULL DEFAULT false,

  -- Operator-estimated cost in minor units. Required when is_damage.
  estimated_cost_minor     bigint CHECK (estimated_cost_minor IS NULL
                                          OR estimated_cost_minor >= 0),

  -- S3 keys / urls. Cap enforced in the application (~6 photos).
  photos                   jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Set by inspection_charge_damages(). Tracks which property_charges
  -- row was raised for this finding so re-runs are idempotent.
  damage_charge_id         uuid REFERENCES public.property_charges(id) ON DELETE SET NULL,

  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- A is_damage finding must carry an estimated cost or it's noise.
  CHECK (NOT is_damage OR (estimated_cost_minor IS NOT NULL AND estimated_cost_minor >= 0))
);

CREATE INDEX IF NOT EXISTS inspection_findings_inspection_idx
  ON public.inspection_findings(inspection_id, area, item);
CREATE INDEX IF NOT EXISTS inspection_findings_damage_idx
  ON public.inspection_findings(inspection_id)
  WHERE is_damage = true;
CREATE INDEX IF NOT EXISTS inspection_findings_baseline_idx
  ON public.inspection_findings(baseline_finding_id)
  WHERE baseline_finding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inspection_findings_charge_idx
  ON public.inspection_findings(damage_charge_id)
  WHERE damage_charge_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_inspection_findings_updated_at ON public.inspection_findings;
CREATE TRIGGER set_inspection_findings_updated_at
  BEFORE UPDATE ON public.inspection_findings
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 4. inspection_complete RPC
-- =====================================================================
--
-- Locks findings and transitions to 'completed'. Requires ≥1 finding.
-- Computes total_damage_estimate_minor + overall_condition (worst
-- finding rating) and stamps both on the inspection row.

CREATE OR REPLACE FUNCTION public.inspection_complete(p_inspection_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inspection         record;
  v_findings_count     int;
  v_damage_total       bigint;
  v_overall_condition  text;
  v_worst_rank         int;
  v_finding            record;
BEGIN
  IF NOT (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'inspection_complete: permission denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inspection
    FROM public.inspections WHERE id = p_inspection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inspection_complete: inspection not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_inspection.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'inspection_complete: cannot complete from status %',
      v_inspection.status;
  END IF;

  SELECT count(*) INTO v_findings_count
    FROM public.inspection_findings WHERE inspection_id = p_inspection_id;
  IF v_findings_count = 0 THEN
    RAISE EXCEPTION 'inspection_complete: inspection requires at least one finding';
  END IF;

  -- Sum damage estimates.
  SELECT coalesce(sum(estimated_cost_minor), 0) INTO v_damage_total
    FROM public.inspection_findings
   WHERE inspection_id = p_inspection_id
     AND is_damage = true;

  -- Compute overall condition = worst rating across findings.
  -- Rank ascending (excellent=1, missing=7); we keep the worst.
  v_worst_rank := 0;
  v_overall_condition := NULL;
  FOR v_finding IN
    SELECT condition FROM public.inspection_findings
     WHERE inspection_id = p_inspection_id
  LOOP
    IF (CASE v_finding.condition
          WHEN 'excellent' THEN 1
          WHEN 'good' THEN 2
          WHEN 'fair' THEN 3
          WHEN 'damaged' THEN 4
          WHEN 'requires_repair' THEN 5
          WHEN 'requires_replacement' THEN 6
          WHEN 'missing' THEN 7
        END) > v_worst_rank
    THEN
      v_worst_rank := CASE v_finding.condition
        WHEN 'excellent' THEN 1
        WHEN 'good' THEN 2
        WHEN 'fair' THEN 3
        WHEN 'damaged' THEN 4
        WHEN 'requires_repair' THEN 5
        WHEN 'requires_replacement' THEN 6
        WHEN 'missing' THEN 7
      END;
    END IF;
  END LOOP;
  -- Map worst rank back. Conditions 4-7 map to 'fair' (4) → 'unhabitable' (7).
  v_overall_condition := CASE v_worst_rank
    WHEN 1 THEN 'excellent'
    WHEN 2 THEN 'good'
    WHEN 3 THEN 'fair'
    WHEN 4 THEN 'fair'
    WHEN 5 THEN 'poor'
    WHEN 6 THEN 'poor'
    WHEN 7 THEN 'unhabitable'
  END;

  UPDATE public.inspections
     SET status                       = 'completed',
         conducted_at                 = coalesce(conducted_at, now()),
         total_damage_estimate_minor  = v_damage_total,
         overall_condition            = v_overall_condition
   WHERE id = p_inspection_id;

  RETURN p_inspection_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.inspection_complete(uuid) TO authenticated;


-- =====================================================================
-- 5. inspection_tenant_sign RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.inspection_tenant_sign(
  p_inspection_id uuid,
  p_signature     jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inspection         record;
  v_party_id           uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'inspection_tenant_sign: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, lease_id, status INTO v_inspection
    FROM public.inspections WHERE id = p_inspection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inspection_tenant_sign: inspection not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_inspection.status <> 'completed' THEN
    RAISE EXCEPTION 'inspection_tenant_sign: inspection must be in status=completed (got %)',
      v_inspection.status;
  END IF;
  IF v_inspection.lease_id IS NULL THEN
    RAISE EXCEPTION 'inspection_tenant_sign: inspection has no lease_id; nothing to sign against';
  END IF;

  -- Find the lease_party row for the calling user. The caller must
  -- be a tenant on the lease (RLS would otherwise reject reads, but
  -- we explicitly enforce here so the error is loud and clear).
  SELECT id INTO v_party_id
    FROM public.lease_parties
   WHERE lease_id = v_inspection.lease_id
     AND user_id = auth.uid()
     AND role = 'tenant'
   LIMIT 1;
  IF v_party_id IS NULL THEN
    RAISE EXCEPTION 'inspection_tenant_sign: caller is not a tenant on the inspection''s lease'
      USING ERRCODE = '42501';
  END IF;

  IF p_signature IS NULL OR p_signature->>'kind' IS NULL OR p_signature->>'value' IS NULL THEN
    RAISE EXCEPTION 'inspection_tenant_sign: signature jsonb must include kind + value';
  END IF;
  IF p_signature->>'kind' NOT IN ('typed', 'click', 'png_data') THEN
    RAISE EXCEPTION 'inspection_tenant_sign: signature.kind must be typed|click|png_data';
  END IF;

  UPDATE public.inspections
     SET status            = 'tenant_signed',
         tenant_party_id   = v_party_id,
         tenant_signed_at  = now(),
         tenant_signature  = p_signature
   WHERE id = p_inspection_id;

  RETURN p_inspection_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.inspection_tenant_sign(uuid, jsonb) TO authenticated;


-- =====================================================================
-- 6. inspection_charge_damages RPC
-- =====================================================================
--
-- For completed (or tenant_signed) move-out inspections, walks
-- findings WHERE is_damage AND damage_charge_id IS NULL AND
-- estimated_cost_minor > 0, creates one property_charges row per
-- finding (kind='damage', billing_target='tenant', status='open',
-- due_at = now + 7d), and stamps damage_charge_id on the finding
-- so re-runs are no-ops (idempotent).
--
-- Returns: { charges_created, total_amount_minor, run_id }

CREATE OR REPLACE FUNCTION public.inspection_charge_damages(
  p_inspection_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inspection         record;
  v_finding            record;
  v_charge_id          uuid;
  v_charges_created    int := 0;
  v_total              bigint := 0;
  v_tenant_party       record;
BEGIN
  IF NOT (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'inspection_charge_damages: permission denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inspection
    FROM public.inspections WHERE id = p_inspection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inspection_charge_damages: inspection not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_inspection.status NOT IN ('completed', 'tenant_signed') THEN
    RAISE EXCEPTION 'inspection_charge_damages: inspection must be completed or tenant_signed (got %)',
      v_inspection.status;
  END IF;
  IF v_inspection.lease_id IS NULL THEN
    RAISE EXCEPTION 'inspection_charge_damages: inspection has no lease_id; cannot charge a tenant';
  END IF;

  -- Pull the primary tenant for charged_to_* identity. Falls back to
  -- the first tenant party if none is marked primary.
  SELECT user_id, contact_id, external_name, external_email
    INTO v_tenant_party
    FROM public.lease_parties
   WHERE lease_id = v_inspection.lease_id AND role = 'tenant'
   ORDER BY is_primary DESC, created_at ASC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inspection_charge_damages: lease has no tenant party';
  END IF;

  FOR v_finding IN
    SELECT id, area, item, description, estimated_cost_minor
    FROM public.inspection_findings
    WHERE inspection_id = p_inspection_id
      AND is_damage = true
      AND damage_charge_id IS NULL
      AND estimated_cost_minor IS NOT NULL
      AND estimated_cost_minor > 0
  LOOP
    INSERT INTO public.property_charges
      (kind, unit_id, lease_id,
       charged_to_user_id, charged_to_contact_id,
       charged_to_external_name, charged_to_external_email,
       billing_target,
       currency, subtotal_minor, total_minor,
       status, due_at, line_items, metadata)
    VALUES
      ('damage', v_inspection.unit_id, v_inspection.lease_id,
       v_tenant_party.user_id, v_tenant_party.contact_id,
       v_tenant_party.external_name, v_tenant_party.external_email,
       'tenant',
       'PHP',
       v_finding.estimated_cost_minor, v_finding.estimated_cost_minor,
       'open', now() + interval '7 days',
       jsonb_build_array(jsonb_build_object(
         'description', format('Damage: %s/%s — %s',
                               v_finding.area, v_finding.item,
                               coalesce(v_finding.description, 'no description')),
         'quantity', 1,
         'unit_amount_minor', v_finding.estimated_cost_minor,
         'total_minor', v_finding.estimated_cost_minor
       )),
       jsonb_build_object(
         'inspection_id', p_inspection_id,
         'inspection_no', v_inspection.inspection_no,
         'finding_id', v_finding.id,
         'damage_origin', 'inspection'
       ))
    RETURNING id INTO v_charge_id;

    UPDATE public.inspection_findings
       SET damage_charge_id = v_charge_id
     WHERE id = v_finding.id;

    v_charges_created := v_charges_created + 1;
    v_total := v_total + v_finding.estimated_cost_minor;
  END LOOP;

  RETURN jsonb_build_object(
    'inspection_id', p_inspection_id,
    'charges_created', v_charges_created,
    'total_amount_minor', v_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.inspection_charge_damages(uuid) TO authenticated;


-- =====================================================================
-- 7. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('inspections.manage', 'Schedule, conduct, and lock unit inspections', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'inspections.manage'),
  ('manager', 'inspections.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 8. RLS
-- =====================================================================

ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inspections_select ON public.inspections;
CREATE POLICY inspections_select
  ON public.inspections FOR SELECT
  TO authenticated
  USING (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    -- Inspector themselves
    OR inspector_user_id = auth.uid()
    -- Tenant on the lease (so the future portal can show "you have a
    -- move-out inspection scheduled" + the signed report)
    OR (
      lease_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.lease_parties lp
         WHERE lp.lease_id = inspections.lease_id
           AND lp.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS inspections_insert ON public.inspections;
CREATE POLICY inspections_insert
  ON public.inspections FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS inspections_update ON public.inspections;
CREATE POLICY inspections_update
  ON public.inspections FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    -- The inspector themselves can update during scheduled/in_progress;
    -- once completed, only managers can edit (which is realistically
    -- a void + new inspection, not a field-by-field amend).
    OR (inspector_user_id = auth.uid() AND status IN ('scheduled', 'in_progress'))
  )
  WITH CHECK (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR (inspector_user_id = auth.uid() AND status IN ('scheduled', 'in_progress'))
  );

-- DELETE blocked. Cancel via status='cancelled' instead.


ALTER TABLE public.inspection_findings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inspection_findings_select ON public.inspection_findings;
CREATE POLICY inspection_findings_select
  ON public.inspection_findings FOR SELECT
  TO authenticated
  USING (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.inspections i
       WHERE i.id = inspection_findings.inspection_id
         AND (
           i.inspector_user_id = auth.uid()
           OR (
             i.lease_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM public.lease_parties lp
                WHERE lp.lease_id = i.lease_id
                  AND lp.user_id = auth.uid()
             )
           )
         )
    )
  );

DROP POLICY IF EXISTS inspection_findings_modify ON public.inspection_findings;
CREATE POLICY inspection_findings_modify
  ON public.inspection_findings FOR ALL
  TO authenticated
  USING (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.inspections i
       WHERE i.id = inspection_findings.inspection_id
         AND i.inspector_user_id = auth.uid()
         AND i.status IN ('scheduled', 'in_progress')
    )
  )
  WITH CHECK (
    public.has_permission('inspections.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.inspections i
       WHERE i.id = inspection_findings.inspection_id
         AND i.inspector_user_id = auth.uid()
         AND i.status IN ('scheduled', 'in_progress')
    )
  );


-- =====================================================================
-- 9. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.inspections', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'PM inspection event with state machine and tenant attestation', false),
  ('public.inspection_findings', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Per-area / per-item observations on an inspection', false),
  ('public.inspection_complete', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'RPC: lock findings and stamp overall_condition + total_damage_estimate', false),
  ('public.inspection_tenant_sign', 'function', 'userportal',
   ARRAY['userportal', 'website']::text[],
   'RPC: tenant attestation; stamps signature blob and flips status', false),
  ('public.inspection_charge_damages', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'RPC: turn is_damage findings into property_charges (kind=damage); idempotent', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
