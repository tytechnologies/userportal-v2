-- Maintenance + Vendors + Work Orders.
--
-- C4 of the post-audit roadmap. Adds the operational side of property
-- management: tenant-reported issues, vendor catalog, and work-order
-- scheduling/billing.
--
-- Existing surfaces preserved:
--   - units, leases, lease_parties     — unchanged.
--   - contacts, profiles, activities    — unchanged.
--   - has_permission, audit, notify     — unchanged.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.vendor_workload;
--   DROP VIEW IF EXISTS public.unit_open_maintenance;
--   DROP FUNCTION IF EXISTS public.work_order_assign(uuid, uuid, uuid);
--   DROP FUNCTION IF EXISTS public.maintenance_triage(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.next_work_order_no();
--   DROP FUNCTION IF EXISTS public.next_maintenance_request_no();
--   DROP TABLE IF EXISTS public.work_orders;
--   DROP TABLE IF EXISTS public.maintenance_requests;
--   DROP TABLE IF EXISTS public.vendors;
--   DROP SEQUENCE IF EXISTS public.work_order_seq;
--   DROP SEQUENCE IF EXISTS public.maintenance_request_seq;
--   DELETE FROM public.role_permissions WHERE permission IN
--     ('vendors.manage', 'maintenance.manage');
--   DELETE FROM public.permissions WHERE name IN
--     ('vendors.manage', 'maintenance.manage');
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.vendors', 'public.maintenance_requests',
--      'public.work_orders', 'public.unit_open_maintenance',
--      'public.vendor_workload');


-- =====================================================================
-- 1. vendors — service-provider catalog
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.vendors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,

  -- Documented kinds: 'plumber', 'electrician', 'pest_control',
  -- 'cleaning', 'hvac', 'painting', 'security', 'landscaping',
  -- 'general', 'appliance_repair'.
  kind                text NOT NULL,

  -- Optional link to existing CRM contact.
  contact_id          bigint REFERENCES public.contacts(id) ON DELETE SET NULL,

  email               text,
  phone               text,
  tax_id              text,

  -- Geo coverage. Documented keys: city_ids[bigint],
  -- barangay_ids[bigint], radius_km, notes.
  service_areas       jsonb NOT NULL DEFAULT '{}'::jsonb,

  rating              numeric(3,2) CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  -- Pricing reference. Documented keys: hourly_rate_minor,
  -- minimum_charge_minor, surcharge_emergency_minor, currency.
  rate_card           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Accreditation / insurance / business permit document refs.
  documents           jsonb NOT NULL DEFAULT '[]'::jsonb,

  status              text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'paused', 'suspended', 'archived')),

  notes               text,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendors_kind_idx
  ON public.vendors(kind, status);
CREATE INDEX IF NOT EXISTS vendors_status_idx
  ON public.vendors(status);

DROP TRIGGER IF EXISTS set_vendors_updated_at ON public.vendors;
CREATE TRIGGER set_vendors_updated_at
  BEFORE UPDATE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 2. Sequence helpers — request_no + work_order_no
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS public.maintenance_request_seq START 1000;
CREATE SEQUENCE IF NOT EXISTS public.work_order_seq          START 1000;

CREATE OR REPLACE FUNCTION public.next_maintenance_request_no()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN format(
    'MR-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.maintenance_request_seq')::text, 6, '0')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.next_work_order_no()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN format(
    'WO-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.work_order_seq')::text, 6, '0')
  );
END;
$$;


-- =====================================================================
-- 3. maintenance_requests — reported issue
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.maintenance_requests (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  request_no                  text NOT NULL UNIQUE
                                   DEFAULT public.next_maintenance_request_no(),

  unit_id                     uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  lease_id                    uuid REFERENCES public.leases(id) ON DELETE SET NULL,

  -- Reporter identity (≥1 required).
  reported_by_user_id         uuid   REFERENCES public.profiles(id) ON DELETE SET NULL,
  reported_by_contact_id      bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  reporter_external_name      text,
  reporter_external_email     text,
  -- Documented values: 'tenant', 'owner', 'manager', 'visitor', 'staff'.
  reporter_role               text,

  title                       text NOT NULL,
  description                 text,

  -- Documented values: 'plumbing', 'electrical', 'appliance', 'pest',
  -- 'hvac', 'common_area', 'security', 'cleaning', 'leakage',
  -- 'structural', 'other'.
  category                    text NOT NULL,

  urgency                     text NOT NULL DEFAULT 'normal'
                                   CHECK (urgency IN ('emergency', 'high', 'normal', 'low')),

  -- S3 keys / urls. Capped via application; jsonb array.
  photos                      jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Documented keys: start_at, end_at, contact_phone, instructions.
  access_window               jsonb NOT NULL DEFAULT '{}'::jsonb,
  access_granted              boolean NOT NULL DEFAULT false,

  status                      text NOT NULL DEFAULT 'submitted'
                                   CHECK (status IN
                                     ('submitted', 'triaged', 'scheduled',
                                      'in_progress', 'resolved', 'closed',
                                      'cancelled')),

  resolution_summary          text,
  tenant_satisfaction         int CHECK (tenant_satisfaction IS NULL
                                          OR (tenant_satisfaction BETWEEN 1 AND 5)),

  reported_at                 timestamptz NOT NULL DEFAULT now(),
  triaged_at                  timestamptz,
  scheduled_at                timestamptz,
  in_progress_at              timestamptz,
  resolved_at                 timestamptz,
  closed_at                   timestamptz,
  cancelled_at                timestamptz,

  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CHECK (
    reported_by_user_id IS NOT NULL
    OR reported_by_contact_id IS NOT NULL
    OR reporter_external_email IS NOT NULL
    OR reporter_external_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS maintenance_requests_unit_idx
  ON public.maintenance_requests(unit_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_requests_lease_idx
  ON public.maintenance_requests(lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS maintenance_requests_open_idx
  ON public.maintenance_requests(status, urgency, reported_at DESC)
  WHERE status NOT IN ('closed', 'cancelled');
CREATE INDEX IF NOT EXISTS maintenance_requests_reporter_idx
  ON public.maintenance_requests(reported_by_user_id)
  WHERE reported_by_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_maintenance_requests_updated_at ON public.maintenance_requests;
CREATE TRIGGER set_maintenance_requests_updated_at
  BEFORE UPDATE ON public.maintenance_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 4. work_orders — vendor / staff assignment + execution
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.work_orders (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  work_order_no               text NOT NULL UNIQUE DEFAULT public.next_work_order_no(),

  -- Optional link back to the originating request. NULL for proactive
  -- maintenance scheduled by management without a tenant request.
  maintenance_request_id      uuid REFERENCES public.maintenance_requests(id) ON DELETE SET NULL,

  unit_id                     uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  vendor_id                   uuid REFERENCES public.vendors(id) ON DELETE SET NULL,
  assigned_user_id            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  title                       text NOT NULL,
  description                 text,
  scope                       text,

  cost_estimate_minor         bigint CHECK (cost_estimate_minor IS NULL
                                             OR cost_estimate_minor >= 0),
  cost_actual_minor           bigint CHECK (cost_actual_minor IS NULL
                                             OR cost_actual_minor >= 0),
  currency                    text NOT NULL DEFAULT 'PHP',

  -- 'owner' | 'tenant' | 'platform' (e.g. promo, warranty)
  billing_target              text NOT NULL DEFAULT 'owner'
                                   CHECK (billing_target IN ('owner', 'tenant', 'platform')),

  scheduled_at                timestamptz,
  started_at                  timestamptz,
  completed_at                timestamptz,
  cancelled_at                timestamptz,

  status                      text NOT NULL DEFAULT 'draft'
                                   CHECK (status IN
                                     ('draft', 'pending_assignment', 'assigned',
                                      'in_progress', 'completed', 'cancelled')),

  photos_before               jsonb NOT NULL DEFAULT '[]'::jsonb,
  photos_after                jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Each entry: { name, sku, quantity, unit_cost_minor }
  parts_used                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_notes            text,

  approved_by                 uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at                 timestamptz,

  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_orders_request_idx
  ON public.work_orders(maintenance_request_id) WHERE maintenance_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_orders_unit_idx
  ON public.work_orders(unit_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS work_orders_vendor_idx
  ON public.work_orders(vendor_id, status) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_orders_assigned_idx
  ON public.work_orders(assigned_user_id, status) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_orders_open_idx
  ON public.work_orders(status, scheduled_at)
  WHERE status NOT IN ('completed', 'cancelled');

DROP TRIGGER IF EXISTS set_work_orders_updated_at ON public.work_orders;
CREATE TRIGGER set_work_orders_updated_at
  BEFORE UPDATE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 5. maintenance_triage RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.maintenance_triage(
  p_request_id uuid,
  p_status     text,    -- 'triaged' | 'cancelled'
  p_notes      text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing record;
BEGIN
  IF NOT (
    public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'maintenance_triage: permission denied' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('triaged', 'cancelled') THEN
    RAISE EXCEPTION 'maintenance_triage: status must be triaged or cancelled (got %)', p_status;
  END IF;

  SELECT id, status INTO v_existing FROM public.maintenance_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'maintenance_triage: request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_existing.status <> 'submitted' THEN
    RAISE EXCEPTION 'maintenance_triage: request must be in submitted status (got %)',
      v_existing.status;
  END IF;

  IF p_status = 'triaged' THEN
    UPDATE public.maintenance_requests
       SET status     = 'triaged',
           triaged_at = now(),
           metadata   = metadata || jsonb_build_object('triage_notes', p_notes)
     WHERE id = p_request_id;
  ELSE
    UPDATE public.maintenance_requests
       SET status       = 'cancelled',
           cancelled_at = now(),
           metadata     = metadata || jsonb_build_object('cancel_notes', p_notes)
     WHERE id = p_request_id;
  END IF;

  RETURN p_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.maintenance_triage(uuid, text, text) TO authenticated;


-- =====================================================================
-- 6. work_order_assign RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.work_order_assign(
  p_work_order_id    uuid,
  p_vendor_id        uuid DEFAULT NULL,
  p_assigned_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing record;
BEGIN
  IF NOT (
    public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'work_order_assign: permission denied' USING ERRCODE = '42501';
  END IF;

  IF p_vendor_id IS NULL AND p_assigned_user_id IS NULL THEN
    RAISE EXCEPTION 'work_order_assign: at least one of vendor_id / assigned_user_id is required';
  END IF;

  SELECT id, status INTO v_existing FROM public.work_orders WHERE id = p_work_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_order_assign: work order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_existing.status NOT IN ('draft', 'pending_assignment', 'assigned') THEN
    RAISE EXCEPTION 'work_order_assign: cannot assign from status % (must be draft/pending_assignment/assigned)',
      v_existing.status;
  END IF;

  -- Validate vendor active when supplied.
  IF p_vendor_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND status = 'active') THEN
      RAISE EXCEPTION 'work_order_assign: vendor not found or not active';
    END IF;
  END IF;

  UPDATE public.work_orders
     SET vendor_id        = coalesce(p_vendor_id, vendor_id),
         assigned_user_id = coalesce(p_assigned_user_id, assigned_user_id),
         status           = 'assigned'
   WHERE id = p_work_order_id;

  RETURN p_work_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.work_order_assign(uuid, uuid, uuid) TO authenticated;


-- =====================================================================
-- 7. unit_open_maintenance + vendor_workload views
-- =====================================================================

CREATE OR REPLACE VIEW public.unit_open_maintenance AS
SELECT
  u.id            AS unit_id,
  u.unit_number,
  u.building_id,
  count(*) FILTER (
    WHERE mr.status NOT IN ('closed', 'cancelled')
  )                                                                 AS open_count,
  count(*) FILTER (WHERE mr.urgency = 'emergency'
                     AND mr.status NOT IN ('closed', 'cancelled'))   AS emergency_open,
  count(*) FILTER (WHERE mr.status = 'submitted')                    AS submitted_count,
  count(*) FILTER (WHERE mr.status = 'in_progress')                  AS in_progress_count,
  max(mr.reported_at) FILTER (
    WHERE mr.status NOT IN ('closed', 'cancelled')
  )                                                                 AS most_recent_open_at
FROM public.units u
LEFT JOIN public.maintenance_requests mr ON mr.unit_id = u.id
GROUP BY u.id, u.unit_number, u.building_id;

GRANT SELECT ON public.unit_open_maintenance TO authenticated;


CREATE OR REPLACE VIEW public.vendor_workload AS
SELECT
  v.id                                                                AS vendor_id,
  v.name,
  v.kind,
  count(*) FILTER (WHERE wo.status IN ('assigned', 'in_progress'))    AS active_count,
  count(*) FILTER (WHERE wo.status = 'in_progress')                   AS in_progress_count,
  count(*) FILTER (WHERE wo.status = 'completed'
                     AND wo.completed_at >= now() - interval '30 days') AS completed_30d,
  avg(wo.cost_actual_minor) FILTER (WHERE wo.status = 'completed')    AS avg_cost_actual_minor,
  max(wo.completed_at) FILTER (WHERE wo.status = 'completed')         AS last_completed_at
FROM public.vendors v
LEFT JOIN public.work_orders wo ON wo.vendor_id = v.id
GROUP BY v.id, v.name, v.kind;

GRANT SELECT ON public.vendor_workload TO authenticated;


-- =====================================================================
-- 8. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('vendors.manage',     'Create / update vendors and rate cards',         'property'),
  ('maintenance.manage', 'Triage and resolve maintenance requests + WOs', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'vendors.manage'),
  ('admin',   'maintenance.manage'),
  ('manager', 'vendors.manage'),
  ('manager', 'maintenance.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 9. RLS
-- =====================================================================

-- vendors: catalog readable by any authenticated; writes admin/manager.
ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendors_select ON public.vendors;
CREATE POLICY vendors_select ON public.vendors FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS vendors_modify ON public.vendors;
CREATE POLICY vendors_modify ON public.vendors FOR ALL
  TO authenticated
  USING (
    public.has_permission('vendors.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('vendors.manage')
    OR public.has_permission('admin.access')
  );


-- maintenance_requests: reporter + lease parties + manager.
ALTER TABLE public.maintenance_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maintenance_requests_select ON public.maintenance_requests;
CREATE POLICY maintenance_requests_select ON public.maintenance_requests FOR SELECT
  TO authenticated
  USING (
    public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
    OR reported_by_user_id = auth.uid()
    OR (
      lease_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.lease_parties lp
         WHERE lp.lease_id = maintenance_requests.lease_id
           AND lp.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS maintenance_requests_insert ON public.maintenance_requests;
CREATE POLICY maintenance_requests_insert ON public.maintenance_requests FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Caller submitting their own report:
    reported_by_user_id = auth.uid()
    -- Or manager creating on behalf:
    OR public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS maintenance_requests_update ON public.maintenance_requests;
CREATE POLICY maintenance_requests_update ON public.maintenance_requests FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
    OR (reported_by_user_id = auth.uid() AND status IN ('submitted', 'triaged'))
  )
  WITH CHECK (
    public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
    OR (reported_by_user_id = auth.uid() AND status IN ('submitted', 'triaged', 'cancelled'))
  );


-- work_orders: read for property.manage, vendor (when user_id matches),
-- assigned in-house user, and underlying request reporter / lease parties.
ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS work_orders_select ON public.work_orders;
CREATE POLICY work_orders_select ON public.work_orders FOR SELECT
  TO authenticated
  USING (
    public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
    OR assigned_user_id = auth.uid()
    OR (
      maintenance_request_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.maintenance_requests mr
         WHERE mr.id = work_orders.maintenance_request_id
           AND (
             mr.reported_by_user_id = auth.uid()
             OR (
               mr.lease_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM public.lease_parties lp
                  WHERE lp.lease_id = mr.lease_id AND lp.user_id = auth.uid()
               )
             )
           )
      )
    )
  );

DROP POLICY IF EXISTS work_orders_modify ON public.work_orders;
CREATE POLICY work_orders_modify ON public.work_orders FOR ALL
  TO authenticated
  USING (
    public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('maintenance.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 10. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.vendors',                  'table', 'userportal',
   ARRAY['userportal']::text[], 'Service-provider catalog',                      false),
  ('public.maintenance_requests',     'table', 'userportal',
   ARRAY['userportal']::text[], 'Reporter-driven maintenance issues',            false),
  ('public.work_orders',              'table', 'userportal',
   ARRAY['userportal']::text[], 'Vendor / staff assignment + execution record', false),
  ('public.unit_open_maintenance',    'view',  'userportal',
   ARRAY['userportal']::text[], 'Open maintenance counts per unit',              false),
  ('public.vendor_workload',          'view',  'userportal',
   ARRAY['userportal']::text[], 'Per-vendor workload + 30d completion rollup',  false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
