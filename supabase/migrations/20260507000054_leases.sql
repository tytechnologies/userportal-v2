-- Leases — the lease contract record + parties + lifecycle.
--
-- C2 of the post-audit roadmap. Adds the structured business record
-- for a lease (rent, term, escalation, renewal, termination state
-- machine) on top of B3's envelope and C1's units. The contract
-- document itself stays in document_drafts; this layer adds the
-- structured numbers + lifecycle.
--
-- C1 left unit_occupancy.lease_id as a forward-FK placeholder; this
-- migration adds the constraint.
--
-- Existing surfaces preserved:
--   - units, unit_occupancy           — kept; FK hardened.
--   - listings, deals                 — kept; lease references them.
--   - document_drafts, document_envelopes — kept; lease references them.
--
-- ROLLBACK:
--   ALTER TABLE public.unit_occupancy DROP CONSTRAINT IF EXISTS unit_occupancy_lease_id_fkey;
--   DROP VIEW IF EXISTS public.lease_active_summary;
--   DROP FUNCTION IF EXISTS public.lease_renew(uuid, timestamptz, timestamptz, bigint, bigint);
--   DROP FUNCTION IF EXISTS public.lease_terminate(uuid, text, timestamptz, bigint);
--   DROP FUNCTION IF EXISTS public.lease_activate(uuid);
--   DROP FUNCTION IF EXISTS public.lease_can_manage(uuid);
--   DROP FUNCTION IF EXISTS public.lease_can_read(uuid);
--   DROP TABLE IF EXISTS public.lease_parties;
--   DROP TABLE IF EXISTS public.leases;
--   DELETE FROM public.role_permissions WHERE permission = 'leases.manage';
--   DELETE FROM public.permissions WHERE name = 'leases.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.leases', 'public.lease_parties',
--      'public.lease_active_summary');


-- =====================================================================
-- 1. leases — the contract record
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.leases (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  unit_id                         uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  -- Optional links back to origin artifacts.
  listing_id                      bigint REFERENCES public.listings(id) ON DELETE SET NULL,
  deal_id                         uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  source_document_draft_id        uuid REFERENCES public.document_drafts(id) ON DELETE SET NULL,
  signed_envelope_id              uuid REFERENCES public.document_envelopes(id) ON DELETE SET NULL,

  -- Renewal lineage. NULL = original lease; non-NULL = child.
  parent_lease_id                 uuid REFERENCES public.leases(id) ON DELETE SET NULL,

  lease_type                      text NOT NULL DEFAULT 'residential'
                                       CHECK (lease_type IN
                                         ('residential', 'commercial',
                                          'short_term', 'long_term')),

  -- Money (minor units; PHP centavos). currency aligns with B6.
  currency                        text NOT NULL DEFAULT 'PHP',
  rent_minor                      bigint NOT NULL CHECK (rent_minor >= 0),
  rent_period                     text NOT NULL DEFAULT 'monthly'
                                       CHECK (rent_period IN
                                         ('monthly', 'quarterly', 'annual')),
  security_deposit_minor          bigint NOT NULL DEFAULT 0 CHECK (security_deposit_minor >= 0),
  advance_rent_minor              bigint NOT NULL DEFAULT 0 CHECK (advance_rent_minor >= 0),

  -- Term.
  effective_at                    timestamptz NOT NULL,
  expires_at                      timestamptz NOT NULL,
  move_in_date                    date,
  move_out_date                   date,

  -- Day of month rent is due. Capped at 28 to avoid month-length
  -- edge cases (29-31 days). 0 = invalid.
  billing_day                     int CHECK (billing_day IS NULL OR (billing_day BETWEEN 1 AND 28)),

  -- Escalation.
  escalation_kind                 text NOT NULL DEFAULT 'none'
                                       CHECK (escalation_kind IN
                                         ('none', 'fixed_amount', 'percent', 'cpi_index')),
  escalation_value                numeric(12,4) DEFAULT 0,
  escalation_period_months        int CHECK (escalation_period_months IS NULL
                                              OR escalation_period_months > 0),

  -- Utilities included in rent. Documented values: 'water',
  -- 'electricity', 'wifi', 'cable', 'gas', 'condo_dues', 'parking'.
  utilities_included              text[] NOT NULL DEFAULT '{}',
  house_rules                     text,

  -- Lifecycle.
  status                          text NOT NULL DEFAULT 'draft'
                                       CHECK (status IN
                                         ('draft', 'pending_signature',
                                          'active', 'expired',
                                          'terminated', 'cancelled')),

  activated_at                    timestamptz,
  terminated_at                   timestamptz,
  terminated_by                   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  termination_reason              text,
  early_termination_fee_minor     bigint CHECK (early_termination_fee_minor IS NULL
                                                 OR early_termination_fee_minor >= 0),

  metadata                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes                           text,

  created_by                      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),

  CHECK (expires_at > effective_at),
  CHECK (move_out_date IS NULL OR move_in_date IS NULL OR move_out_date >= move_in_date)
);

CREATE INDEX IF NOT EXISTS leases_unit_idx
  ON public.leases(unit_id, status);
CREATE INDEX IF NOT EXISTS leases_listing_idx
  ON public.leases(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leases_deal_idx
  ON public.leases(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leases_parent_idx
  ON public.leases(parent_lease_id) WHERE parent_lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leases_status_active_idx
  ON public.leases(unit_id, expires_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS leases_billing_day_idx
  ON public.leases(billing_day)
  WHERE status = 'active' AND billing_day IS NOT NULL;

-- One active lease per unit.
CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_unit
  ON public.leases(unit_id) WHERE status = 'active';

DROP TRIGGER IF EXISTS set_leases_updated_at ON public.leases;
CREATE TRIGGER set_leases_updated_at
  BEFORE UPDATE ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.leases IS
  'Lease contract record. status state machine: draft -> pending_signature -> active -> expired/terminated/cancelled. Money in minor units (centavos). Partial UNIQUE enforces one active lease per unit.';


-- =====================================================================
-- 2. lease_parties — multi-party roster
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.lease_parties (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id            uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,

  role                text NOT NULL CHECK (role IN
                           ('landlord', 'tenant', 'guarantor',
                            'co_signer', 'agent')),

  -- Identity (≥1 of user_id / contact_id / external_email).
  user_id             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  contact_id          bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  external_name       text,
  external_email      text,

  -- For split-rent cases — sums of share_pct per role should = 100.
  -- Application enforces; not a DB constraint.
  share_pct           numeric(5,2) CHECK (share_pct IS NULL
                                          OR (share_pct > 0 AND share_pct <= 100)),

  -- One primary per role per lease (e.g., the named tenant on the
  -- contract; co-tenants are non-primary). Partial UNIQUE below.
  is_primary          boolean NOT NULL DEFAULT false,

  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (
    user_id IS NOT NULL
    OR contact_id IS NOT NULL
    OR external_email IS NOT NULL
    OR external_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS lease_parties_lease_idx
  ON public.lease_parties(lease_id, role);
CREATE INDEX IF NOT EXISTS lease_parties_user_idx
  ON public.lease_parties(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lease_parties_one_primary_per_role
  ON public.lease_parties(lease_id, role)
  WHERE is_primary = true;


-- =====================================================================
-- 3. unit_occupancy.lease_id — harden the FK
-- =====================================================================
--
-- C1 left lease_id as a loose uuid. Now that leases exists, add the
-- referential constraint. ON DELETE SET NULL so a lease deletion
-- (which shouldn't happen in practice — only termination) doesn't
-- cascade-clear occupancy history.

DO $$
BEGIN
  -- First, null out any rows pointing at non-existent leases (defensive
  -- — the column has been writable as a free uuid since C1).
  UPDATE public.unit_occupancy uo
     SET lease_id = NULL
   WHERE lease_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.leases l WHERE l.id = uo.lease_id);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'unit_occupancy_lease_id_fkey'
       AND conrelid = 'public.unit_occupancy'::regclass
  ) THEN
    ALTER TABLE public.unit_occupancy
      ADD CONSTRAINT unit_occupancy_lease_id_fkey
      FOREIGN KEY (lease_id) REFERENCES public.leases(id) ON DELETE SET NULL;
  END IF;
END $$;


-- =====================================================================
-- 4. lease_can_read / lease_can_manage — RLS helpers
-- =====================================================================

CREATE OR REPLACE FUNCTION public.lease_can_read(p_lease_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('leases.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.lease_parties lp
       WHERE lp.lease_id = p_lease_id
         AND lp.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.leases l
       WHERE l.id = p_lease_id
         AND l.created_by = auth.uid()
    );
$$;
GRANT EXECUTE ON FUNCTION public.lease_can_read(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.lease_can_manage(p_lease_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('leases.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.leases l
       WHERE l.id = p_lease_id
         AND l.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.lease_parties lp
       WHERE lp.lease_id = p_lease_id
         AND lp.user_id = auth.uid()
         AND lp.role IN ('landlord', 'agent')
    );
$$;
GRANT EXECUTE ON FUNCTION public.lease_can_manage(uuid) TO authenticated;


-- =====================================================================
-- 5. lease_activate — flip draft|pending_signature -> active
-- =====================================================================
--
-- Validates: ≥1 landlord + ≥1 tenant party. Closes any prior open
-- occupancy on the unit (best-effort, then inserts the new
-- 'tenant_lease' row tied to this lease.

CREATE OR REPLACE FUNCTION public.lease_activate(p_lease_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lease         record;
  v_landlord_ct   int;
  v_tenant_ct     int;
  v_primary_tenant record;
BEGIN
  IF NOT (
    public.lease_can_manage(p_lease_id)
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'lease_activate: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = p_lease_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lease_activate: lease not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_lease.status NOT IN ('draft', 'pending_signature') THEN
    RAISE EXCEPTION 'lease_activate: cannot activate from status %', v_lease.status;
  END IF;

  SELECT count(*) INTO v_landlord_ct
  FROM public.lease_parties WHERE lease_id = p_lease_id AND role = 'landlord';
  SELECT count(*) INTO v_tenant_ct
  FROM public.lease_parties WHERE lease_id = p_lease_id AND role = 'tenant';
  IF v_landlord_ct = 0 THEN
    RAISE EXCEPTION 'lease_activate: at least one landlord party required';
  END IF;
  IF v_tenant_ct = 0 THEN
    RAISE EXCEPTION 'lease_activate: at least one tenant party required';
  END IF;

  -- Pull a tenant for the occupancy row (primary first, then any).
  SELECT user_id, contact_id, external_name, external_email INTO v_primary_tenant
  FROM public.lease_parties
  WHERE lease_id = p_lease_id AND role = 'tenant'
  ORDER BY is_primary DESC, created_at ASC
  LIMIT 1;

  -- Activate.
  UPDATE public.leases
     SET status       = 'active',
         activated_at = now()
   WHERE id = p_lease_id;

  -- Close any prior open occupancy on the unit.
  UPDATE public.unit_occupancy
     SET move_out_at = coalesce(v_lease.effective_at, now())
   WHERE unit_id = v_lease.unit_id
     AND move_out_at IS NULL;

  -- Insert the lease-bound occupancy row.
  INSERT INTO public.unit_occupancy
    (unit_id, occupancy_kind, occupant_user_id, occupant_contact_id,
     occupant_external_name, occupant_external_email,
     lease_id, move_in_at, source, reported_by)
  VALUES
    (v_lease.unit_id, 'tenant_lease',
     v_primary_tenant.user_id,
     v_primary_tenant.contact_id,
     v_primary_tenant.external_name,
     v_primary_tenant.external_email,
     p_lease_id,
     coalesce(v_lease.effective_at, now()),
     'lease_signed',
     auth.uid());

  RETURN p_lease_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lease_activate(uuid) TO authenticated;


-- =====================================================================
-- 6. lease_terminate
-- =====================================================================

CREATE OR REPLACE FUNCTION public.lease_terminate(
  p_lease_id          uuid,
  p_reason            text,
  p_terminated_at     timestamptz DEFAULT now(),
  p_early_fee_minor   bigint DEFAULT NULL
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
    public.lease_can_manage(p_lease_id)
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'lease_terminate: permission denied' USING ERRCODE = '42501';
  END IF;

  IF coalesce(p_reason, '') = '' THEN
    RAISE EXCEPTION 'lease_terminate: reason is required';
  END IF;

  SELECT status INTO v_status FROM public.leases WHERE id = p_lease_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lease_terminate: lease not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status IN ('terminated', 'expired', 'cancelled') THEN
    -- Idempotent on terminal states.
    RETURN p_lease_id;
  END IF;

  UPDATE public.leases
     SET status                       = 'terminated',
         terminated_at                = p_terminated_at,
         terminated_by                = auth.uid(),
         termination_reason           = p_reason,
         early_termination_fee_minor  = p_early_fee_minor,
         move_out_date                = p_terminated_at::date
   WHERE id = p_lease_id;

  -- Stamp move_out_at on the lease-bound occupancy row.
  UPDATE public.unit_occupancy
     SET move_out_at = p_terminated_at
   WHERE lease_id = p_lease_id
     AND move_out_at IS NULL;

  RETURN p_lease_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lease_terminate(uuid, text, timestamptz, bigint) TO authenticated;


-- =====================================================================
-- 7. lease_renew
-- =====================================================================
--
-- Creates a child lease with parent_lease_id set, copies parties.
-- Marks the parent expired at parent.expires_at (or now() if past).

CREATE OR REPLACE FUNCTION public.lease_renew(
  p_parent_lease_id           uuid,
  p_new_effective_at          timestamptz,
  p_new_expires_at            timestamptz,
  p_new_rent_minor            bigint,
  p_new_security_deposit_minor bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent  record;
  v_new_id  uuid;
BEGIN
  IF NOT (
    public.lease_can_manage(p_parent_lease_id)
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'lease_renew: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_parent FROM public.leases WHERE id = p_parent_lease_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lease_renew: parent not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_parent.status <> 'active' THEN
    RAISE EXCEPTION 'lease_renew: parent must be active (got %)', v_parent.status;
  END IF;
  IF p_new_expires_at <= p_new_effective_at THEN
    RAISE EXCEPTION 'lease_renew: new expires_at must be after effective_at';
  END IF;

  -- Mark parent expired first so the partial UNIQUE on (unit_id)
  -- WHERE status='active' frees up for the child.
  UPDATE public.leases
     SET status     = 'expired',
         expires_at = LEAST(coalesce(v_parent.expires_at, now()), now())
   WHERE id = p_parent_lease_id;

  -- Insert the child.
  INSERT INTO public.leases (
    unit_id, listing_id, deal_id, parent_lease_id,
    lease_type, currency,
    rent_minor, rent_period,
    security_deposit_minor,
    advance_rent_minor,
    effective_at, expires_at, billing_day,
    escalation_kind, escalation_value, escalation_period_months,
    utilities_included, house_rules,
    status, created_by
  )
  VALUES (
    v_parent.unit_id, v_parent.listing_id, v_parent.deal_id, p_parent_lease_id,
    v_parent.lease_type, v_parent.currency,
    p_new_rent_minor, v_parent.rent_period,
    coalesce(p_new_security_deposit_minor, v_parent.security_deposit_minor),
    v_parent.advance_rent_minor,
    p_new_effective_at, p_new_expires_at, v_parent.billing_day,
    v_parent.escalation_kind, v_parent.escalation_value, v_parent.escalation_period_months,
    v_parent.utilities_included, v_parent.house_rules,
    'draft', auth.uid()
  )
  RETURNING id INTO v_new_id;

  -- Copy parties from parent.
  INSERT INTO public.lease_parties
    (lease_id, role, user_id, contact_id, external_name, external_email,
     share_pct, is_primary, notes)
  SELECT v_new_id, role, user_id, contact_id, external_name, external_email,
         share_pct, is_primary, notes
  FROM public.lease_parties WHERE lease_id = p_parent_lease_id;

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lease_renew(uuid, timestamptz, timestamptz, bigint, bigint)
  TO authenticated;


-- =====================================================================
-- 8. lease_active_summary view
-- =====================================================================

CREATE OR REPLACE VIEW public.lease_active_summary AS
SELECT
  l.id                AS lease_id,
  l.unit_id,
  u.unit_number,
  u.building_id,
  l.lease_type,
  l.currency,
  l.rent_minor,
  l.rent_period,
  l.security_deposit_minor,
  l.advance_rent_minor,
  l.effective_at,
  l.expires_at,
  l.billing_day,
  l.escalation_kind,
  l.escalation_value,
  l.escalation_period_months,
  l.activated_at,
  -- Primary landlord (one row).
  (SELECT jsonb_build_object(
     'user_id', lp.user_id,
     'contact_id', lp.contact_id,
     'external_name', lp.external_name,
     'external_email', lp.external_email
   )
     FROM public.lease_parties lp
    WHERE lp.lease_id = l.id AND lp.role = 'landlord'
    ORDER BY lp.is_primary DESC, lp.created_at ASC
    LIMIT 1
  ) AS primary_landlord,
  -- Primary tenant (one row).
  (SELECT jsonb_build_object(
     'user_id', lp.user_id,
     'contact_id', lp.contact_id,
     'external_name', lp.external_name,
     'external_email', lp.external_email
   )
     FROM public.lease_parties lp
    WHERE lp.lease_id = l.id AND lp.role = 'tenant'
    ORDER BY lp.is_primary DESC, lp.created_at ASC
    LIMIT 1
  ) AS primary_tenant,
  -- All party identities for fan-out.
  (SELECT count(*) FROM public.lease_parties lp WHERE lp.lease_id = l.id AND lp.role = 'tenant') AS tenant_count,
  (SELECT count(*) FROM public.lease_parties lp WHERE lp.lease_id = l.id AND lp.role = 'landlord') AS landlord_count
FROM public.leases l
JOIN public.units u ON u.id = l.unit_id
WHERE l.status = 'active';

GRANT SELECT ON public.lease_active_summary TO authenticated;


-- =====================================================================
-- 9. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('leases.manage', 'Create, activate, terminate, and renew leases', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'leases.manage'),
  ('manager', 'leases.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 10. RLS
-- =====================================================================

ALTER TABLE public.leases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leases_select ON public.leases;
CREATE POLICY leases_select ON public.leases FOR SELECT
  TO authenticated USING (public.lease_can_read(id));

DROP POLICY IF EXISTS leases_insert ON public.leases;
CREATE POLICY leases_insert ON public.leases FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    OR public.has_permission('leases.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS leases_update ON public.leases;
CREATE POLICY leases_update ON public.leases FOR UPDATE
  TO authenticated
  USING (public.lease_can_manage(id))
  WITH CHECK (public.lease_can_manage(id));

-- DELETE blocked. Use lease_terminate or status='cancelled'.


ALTER TABLE public.lease_parties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lease_parties_select ON public.lease_parties;
CREATE POLICY lease_parties_select ON public.lease_parties FOR SELECT
  TO authenticated USING (public.lease_can_read(lease_id));

DROP POLICY IF EXISTS lease_parties_insert ON public.lease_parties;
CREATE POLICY lease_parties_insert ON public.lease_parties FOR INSERT
  TO authenticated WITH CHECK (public.lease_can_manage(lease_id));

DROP POLICY IF EXISTS lease_parties_delete ON public.lease_parties;
CREATE POLICY lease_parties_delete ON public.lease_parties FOR DELETE
  TO authenticated
  USING (
    public.lease_can_manage(lease_id)
    AND EXISTS (
      SELECT 1 FROM public.leases l
       WHERE l.id = lease_id AND l.status = 'draft'
    )
  );


-- =====================================================================
-- 11. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.leases',                'table', 'userportal',
   ARRAY['userportal']::text[], 'Lease contract record',                       false),
  ('public.lease_parties',         'table', 'userportal',
   ARRAY['userportal']::text[], 'Multi-party roster (landlord/tenant/etc)',    false),
  ('public.lease_active_summary',  'view',  'userportal',
   ARRAY['userportal']::text[], 'Per-active-lease unit + parties + rent',      false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
