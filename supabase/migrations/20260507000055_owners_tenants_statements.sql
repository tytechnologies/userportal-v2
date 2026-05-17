-- Owners + Tenants + Statements.
--
-- C3 of the post-audit roadmap. Adds first-class owner records and
-- periodic financial statements for both owners and tenants.
-- Tenants stay represented via lease_parties.role='tenant' (no
-- separate tenant_profiles table — duplicating contacts is not worth
-- the cost). Tenancy-specific data extends via lease_parties.notes
-- and future jsonb fields.
--
-- Existing surfaces preserved:
--   - units, unit_occupancy, leases, lease_parties — unchanged
--   - profiles, contacts                          — unchanged
--   - existing has_permission, audit, notify       — unchanged
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.unit_current_owner;
--   DROP TRIGGER IF EXISTS owner_statements_post_guard ON public.owner_statements;
--   DROP TRIGGER IF EXISTS tenant_statements_post_guard ON public.tenant_statements;
--   DROP FUNCTION IF EXISTS public.statement_post_guard_fn();
--   DROP FUNCTION IF EXISTS public.statement_mark_issued(uuid, text);
--   DROP FUNCTION IF EXISTS public.register_unit_owner(uuid, jsonb, numeric, boolean);
--   DROP FUNCTION IF EXISTS public.next_tenant_statement_no();
--   DROP FUNCTION IF EXISTS public.next_owner_statement_no();
--   DROP TABLE IF EXISTS public.tenant_statements;
--   DROP TABLE IF EXISTS public.owner_statements;
--   DROP TABLE IF EXISTS public.unit_owners;
--   DROP TABLE IF EXISTS public.property_owners;
--   DROP SEQUENCE IF EXISTS public.tenant_statement_seq;
--   DROP SEQUENCE IF EXISTS public.owner_statement_seq;
--   DELETE FROM public.role_permissions WHERE permission = 'property.manage';
--   DELETE FROM public.permissions WHERE name = 'property.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.property_owners', 'public.unit_owners',
--      'public.owner_statements', 'public.tenant_statements',
--      'public.unit_current_owner');


-- =====================================================================
-- 1. property_owners — the owner identity record
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.property_owners (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity. ≥1 of user_id / contact_id / external_email is required.
  user_id             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  contact_id          bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  external_name       text,
  external_email      text,

  -- BIR TIN for Official Receipts. Free-form; OR generation is an
  -- out-of-scope compliance project.
  tax_id              text,
  billing_address     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- For future disbursement (C4+). Stored as jsonb so additional
  -- bank fields don't need a migration. Documented keys:
  -- bank_name, account_number, account_name, branch, swift_code.
  bank_account        jsonb NOT NULL DEFAULT '{}'::jsonb,

  notes               text,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (
    user_id IS NOT NULL
    OR contact_id IS NOT NULL
    OR external_email IS NOT NULL
    OR external_name IS NOT NULL
  )
);

-- Identity dedupe: one property_owners row per identity-shape.
CREATE UNIQUE INDEX IF NOT EXISTS property_owners_user_id_uniq
  ON public.property_owners(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS property_owners_contact_id_uniq
  ON public.property_owners(contact_id) WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS property_owners_external_email_uniq
  ON public.property_owners(lower(external_email)) WHERE external_email IS NOT NULL;

DROP TRIGGER IF EXISTS set_property_owners_updated_at ON public.property_owners;
CREATE TRIGGER set_property_owners_updated_at
  BEFORE UPDATE ON public.property_owners
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 2. unit_owners — M:N with ownership-period history
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.unit_owners (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id             uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  owner_id            uuid NOT NULL REFERENCES public.property_owners(id) ON DELETE RESTRICT,

  -- Joint ownership. NULL = full ownership; otherwise sums to 100 across
  -- active rows (application-enforced).
  share_pct           numeric(5,2) CHECK (share_pct IS NULL
                                          OR (share_pct > 0 AND share_pct <= 100)),
  is_primary          boolean NOT NULL DEFAULT false,

  effective_at        timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,

  -- Documented values: 'manual', 'title_deed', 'developer', 'mls', 'self_reported'.
  source              text NOT NULL DEFAULT 'manual',
  notes               text,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (ended_at IS NULL OR ended_at > effective_at)
);

CREATE INDEX IF NOT EXISTS unit_owners_unit_idx
  ON public.unit_owners(unit_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS unit_owners_owner_idx
  ON public.unit_owners(owner_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS unit_owners_active_idx
  ON public.unit_owners(unit_id, owner_id)
  WHERE ended_at IS NULL;

-- One primary owner per unit while active.
CREATE UNIQUE INDEX IF NOT EXISTS unit_owners_one_primary_per_unit
  ON public.unit_owners(unit_id)
  WHERE is_primary = true AND ended_at IS NULL;

-- Same owner cannot have two active links to the same unit.
CREATE UNIQUE INDEX IF NOT EXISTS unit_owners_one_active_per_pair
  ON public.unit_owners(unit_id, owner_id)
  WHERE ended_at IS NULL;

DROP TRIGGER IF EXISTS set_unit_owners_updated_at ON public.unit_owners;
CREATE TRIGGER set_unit_owners_updated_at
  BEFORE UPDATE ON public.unit_owners
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 3. unit_current_owner view
-- =====================================================================

CREATE OR REPLACE VIEW public.unit_current_owner AS
SELECT DISTINCT ON (uo.unit_id)
  uo.unit_id,
  uo.owner_id,
  uo.id            AS unit_owner_id,
  uo.is_primary,
  uo.share_pct,
  uo.effective_at,
  uo.source,
  po.user_id       AS owner_user_id,
  po.contact_id    AS owner_contact_id,
  po.external_name AS owner_external_name
FROM public.unit_owners uo
JOIN public.property_owners po ON po.id = uo.owner_id
WHERE uo.ended_at IS NULL
ORDER BY uo.unit_id, uo.is_primary DESC, uo.effective_at DESC;

GRANT SELECT ON public.unit_current_owner TO authenticated;


-- =====================================================================
-- 4. Statement number sequences + helpers
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS public.owner_statement_seq  START 1000;
CREATE SEQUENCE IF NOT EXISTS public.tenant_statement_seq START 1000;

CREATE OR REPLACE FUNCTION public.next_owner_statement_no()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN format(
    'OS-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.owner_statement_seq')::text, 6, '0')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.next_tenant_statement_no()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN format(
    'TS-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.tenant_statement_seq')::text, 6, '0')
  );
END;
$$;


-- =====================================================================
-- 5. owner_statements
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.owner_statements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                 uuid NOT NULL REFERENCES public.property_owners(id) ON DELETE RESTRICT,

  statement_no             text NOT NULL UNIQUE DEFAULT public.next_owner_statement_no(),

  period_start             date NOT NULL,
  period_end               date NOT NULL,
  currency                 text NOT NULL DEFAULT 'PHP',

  -- Money in minor units.
  rent_collected_minor     bigint NOT NULL DEFAULT 0 CHECK (rent_collected_minor >= 0),
  dues_collected_minor     bigint NOT NULL DEFAULT 0 CHECK (dues_collected_minor >= 0),
  expenses_minor           bigint NOT NULL DEFAULT 0 CHECK (expenses_minor >= 0),
  management_fee_minor     bigint NOT NULL DEFAULT 0 CHECK (management_fee_minor >= 0),
  tax_withheld_minor       bigint NOT NULL DEFAULT 0 CHECK (tax_withheld_minor >= 0),
  net_disbursement_minor   bigint NOT NULL DEFAULT 0,

  -- Each entry: { kind, unit_id, description, amount_minor, date }
  -- Documented kinds: 'rent', 'dues', 'late_fee', 'expense_repair',
  -- 'expense_maintenance', 'management_fee', 'tax_withheld', 'adjustment'.
  line_items               jsonb NOT NULL DEFAULT '[]'::jsonb,

  status                   text NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'issued', 'disbursed', 'void')),
  issued_at                timestamptz,
  disbursed_at             timestamptz,
  voided_at                timestamptz,
  void_reason              text,
  external_reference       text,

  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS owner_statements_owner_idx
  ON public.owner_statements(owner_id, period_start DESC);
CREATE INDEX IF NOT EXISTS owner_statements_status_idx
  ON public.owner_statements(status, period_end DESC);

DROP TRIGGER IF EXISTS set_owner_statements_updated_at ON public.owner_statements;
CREATE TRIGGER set_owner_statements_updated_at
  BEFORE UPDATE ON public.owner_statements
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 6. tenant_statements
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.tenant_statements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                 uuid NOT NULL REFERENCES public.leases(id) ON DELETE RESTRICT,
  -- Optional: which tenant party the statement applies to. NULL = all.
  tenant_party_id          uuid REFERENCES public.lease_parties(id) ON DELETE SET NULL,

  statement_no             text NOT NULL UNIQUE DEFAULT public.next_tenant_statement_no(),

  period_start             date NOT NULL,
  period_end               date NOT NULL,
  currency                 text NOT NULL DEFAULT 'PHP',

  rent_billed_minor        bigint NOT NULL DEFAULT 0 CHECK (rent_billed_minor >= 0),
  other_charges_minor      bigint NOT NULL DEFAULT 0 CHECK (other_charges_minor >= 0),
  payments_received_minor  bigint NOT NULL DEFAULT 0 CHECK (payments_received_minor >= 0),
  balance_due_minor        bigint NOT NULL DEFAULT 0,

  -- Documented kinds: 'rent', 'late_fee', 'utilities', 'parking',
  -- 'damage_charge', 'payment_received', 'adjustment'.
  line_items               jsonb NOT NULL DEFAULT '[]'::jsonb,

  status                   text NOT NULL DEFAULT 'draft'
                                CHECK (status IN
                                  ('draft', 'issued', 'paid', 'overdue', 'void')),
  issued_at                timestamptz,
  due_at                   timestamptz,
  paid_at                  timestamptz,
  voided_at                timestamptz,
  void_reason              text,

  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS tenant_statements_lease_idx
  ON public.tenant_statements(lease_id, period_start DESC);
CREATE INDEX IF NOT EXISTS tenant_statements_status_idx
  ON public.tenant_statements(status, due_at)
  WHERE status IN ('issued', 'overdue');
CREATE INDEX IF NOT EXISTS tenant_statements_party_idx
  ON public.tenant_statements(tenant_party_id) WHERE tenant_party_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_tenant_statements_updated_at ON public.tenant_statements;
CREATE TRIGGER set_tenant_statements_updated_at
  BEFORE UPDATE ON public.tenant_statements
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 7. statement_post_guard — append-only on issued/disbursed
-- =====================================================================
--
-- Once a statement is issued, economic fields are locked. status
-- transitions allowed: issued → paid (tenant), issued → disbursed
-- (owner), any → void (with reason).

CREATE OR REPLACE FUNCTION public.statement_post_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Drafts: free-form. Auto-stamp issued_at on draft -> issued.
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'issued' AND NEW.issued_at IS NULL THEN
      NEW.issued_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- Void: terminal.
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'statement: void rows cannot be modified';
  END IF;

  -- issued / paid / disbursed / overdue: lock economic fields.
  -- Allow only status transitions and timestamp/notes/external_reference soft fields.
  IF NEW.status = 'void' THEN
    IF NEW.voided_at IS NULL THEN NEW.voided_at := now(); END IF;
    IF coalesce(NEW.void_reason, '') = '' THEN
      RAISE EXCEPTION 'statement: void requires void_reason';
    END IF;
    -- Lock economic fields to OLD.
    IF TG_TABLE_NAME = 'owner_statements' THEN
      NEW.rent_collected_minor   := OLD.rent_collected_minor;
      NEW.dues_collected_minor   := OLD.dues_collected_minor;
      NEW.expenses_minor         := OLD.expenses_minor;
      NEW.management_fee_minor   := OLD.management_fee_minor;
      NEW.tax_withheld_minor     := OLD.tax_withheld_minor;
      NEW.net_disbursement_minor := OLD.net_disbursement_minor;
    ELSIF TG_TABLE_NAME = 'tenant_statements' THEN
      NEW.rent_billed_minor       := OLD.rent_billed_minor;
      NEW.other_charges_minor     := OLD.other_charges_minor;
      NEW.payments_received_minor := OLD.payments_received_minor;
      NEW.balance_due_minor       := OLD.balance_due_minor;
    END IF;
    NEW.line_items   := OLD.line_items;
    NEW.period_start := OLD.period_start;
    NEW.period_end   := OLD.period_end;
    RETURN NEW;
  END IF;

  -- Same-status soft-edits: notes / external_reference / metadata only.
  IF NEW.line_items IS DISTINCT FROM OLD.line_items
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
  THEN
    RAISE EXCEPTION 'statement: line_items / period are locked once issued';
  END IF;

  IF TG_TABLE_NAME = 'owner_statements' THEN
    IF NEW.rent_collected_minor IS DISTINCT FROM OLD.rent_collected_minor
       OR NEW.dues_collected_minor IS DISTINCT FROM OLD.dues_collected_minor
       OR NEW.expenses_minor IS DISTINCT FROM OLD.expenses_minor
       OR NEW.management_fee_minor IS DISTINCT FROM OLD.management_fee_minor
       OR NEW.tax_withheld_minor IS DISTINCT FROM OLD.tax_withheld_minor
       OR NEW.net_disbursement_minor IS DISTINCT FROM OLD.net_disbursement_minor
    THEN
      RAISE EXCEPTION 'owner_statements: economic fields locked once issued. Insert a void + new statement.';
    END IF;
  ELSIF TG_TABLE_NAME = 'tenant_statements' THEN
    IF NEW.rent_billed_minor IS DISTINCT FROM OLD.rent_billed_minor
       OR NEW.other_charges_minor IS DISTINCT FROM OLD.other_charges_minor
       OR NEW.payments_received_minor IS DISTINCT FROM OLD.payments_received_minor
       OR NEW.balance_due_minor IS DISTINCT FROM OLD.balance_due_minor
    THEN
      RAISE EXCEPTION 'tenant_statements: economic fields locked once issued. Insert a void + new statement.';
    END IF;
  END IF;

  -- Auto-stamp paid_at / disbursed_at on respective transitions.
  IF TG_TABLE_NAME = 'tenant_statements'
     AND OLD.status IN ('issued', 'overdue')
     AND NEW.status = 'paid'
     AND NEW.paid_at IS NULL
  THEN
    NEW.paid_at := now();
  END IF;
  IF TG_TABLE_NAME = 'owner_statements'
     AND OLD.status = 'issued'
     AND NEW.status = 'disbursed'
     AND NEW.disbursed_at IS NULL
  THEN
    NEW.disbursed_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS owner_statements_post_guard ON public.owner_statements;
CREATE TRIGGER owner_statements_post_guard
  BEFORE UPDATE ON public.owner_statements
  FOR EACH ROW EXECUTE FUNCTION public.statement_post_guard_fn();

DROP TRIGGER IF EXISTS tenant_statements_post_guard ON public.tenant_statements;
CREATE TRIGGER tenant_statements_post_guard
  BEFORE UPDATE ON public.tenant_statements
  FOR EACH ROW EXECUTE FUNCTION public.statement_post_guard_fn();


-- =====================================================================
-- 8. register_unit_owner — atomic create-or-find + link
-- =====================================================================

CREATE OR REPLACE FUNCTION public.register_unit_owner(
  p_unit_id    uuid,
  p_owner      jsonb,                   -- { user_id, contact_id, external_name, external_email, tax_id }
  p_share_pct  numeric DEFAULT NULL,
  p_is_primary boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id    uuid;
  v_link_id     uuid;
  v_user_id     uuid;
  v_contact_id  bigint;
  v_email       text;
BEGIN
  IF NOT (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'register_unit_owner: permission denied' USING ERRCODE = '42501';
  END IF;

  v_user_id    := nullif(p_owner->>'user_id', '')::uuid;
  v_contact_id := nullif(p_owner->>'contact_id', '')::bigint;
  v_email      := lower(nullif(p_owner->>'external_email', ''));

  IF v_user_id IS NULL AND v_contact_id IS NULL AND v_email IS NULL
     AND nullif(p_owner->>'external_name', '') IS NULL THEN
    RAISE EXCEPTION 'register_unit_owner: at least one identity field required';
  END IF;

  -- Find existing.
  IF v_user_id IS NOT NULL THEN
    SELECT id INTO v_owner_id FROM public.property_owners WHERE user_id = v_user_id;
  END IF;
  IF v_owner_id IS NULL AND v_contact_id IS NOT NULL THEN
    SELECT id INTO v_owner_id FROM public.property_owners WHERE contact_id = v_contact_id;
  END IF;
  IF v_owner_id IS NULL AND v_email IS NOT NULL THEN
    SELECT id INTO v_owner_id FROM public.property_owners
     WHERE lower(external_email) = v_email;
  END IF;

  -- Or create.
  IF v_owner_id IS NULL THEN
    INSERT INTO public.property_owners
      (user_id, contact_id, external_name, external_email, tax_id, created_by)
    VALUES
      (v_user_id, v_contact_id,
       nullif(p_owner->>'external_name', ''),
       v_email,
       nullif(p_owner->>'tax_id', ''),
       auth.uid())
    RETURNING id INTO v_owner_id;
  END IF;

  -- If new ownership is primary, end any prior primary on this unit.
  IF p_is_primary THEN
    UPDATE public.unit_owners
       SET ended_at = now()
     WHERE unit_id = p_unit_id
       AND is_primary = true
       AND ended_at IS NULL
       AND owner_id <> v_owner_id;
  END IF;

  -- Insert the link (or no-op if already active).
  INSERT INTO public.unit_owners
    (unit_id, owner_id, share_pct, is_primary, source, created_by)
  VALUES
    (p_unit_id, v_owner_id, p_share_pct, p_is_primary, 'manual', auth.uid())
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_link_id;

  IF v_link_id IS NULL THEN
    SELECT id INTO v_link_id FROM public.unit_owners
     WHERE unit_id = p_unit_id AND owner_id = v_owner_id AND ended_at IS NULL
     LIMIT 1;
  END IF;

  RETURN jsonb_build_object('owner_id', v_owner_id, 'unit_owner_id', v_link_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_unit_owner(uuid, jsonb, numeric, boolean)
  TO authenticated;


-- =====================================================================
-- 9. statement_mark_issued
-- =====================================================================

CREATE OR REPLACE FUNCTION public.statement_mark_issued(
  p_statement_id uuid,
  p_kind         text   -- 'owner' | 'tenant'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'statement_mark_issued: permission denied' USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'owner' THEN
    UPDATE public.owner_statements
       SET status = 'issued', issued_at = now()
     WHERE id = p_statement_id AND status = 'draft';
  ELSIF p_kind = 'tenant' THEN
    UPDATE public.tenant_statements
       SET status = 'issued', issued_at = now()
     WHERE id = p_statement_id AND status = 'draft';
  ELSE
    RAISE EXCEPTION 'statement_mark_issued: unknown kind %', p_kind;
  END IF;

  RETURN p_statement_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.statement_mark_issued(uuid, text) TO authenticated;


-- =====================================================================
-- 10. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('property.manage', 'Manage property owners, ownership records, and statements', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'property.manage'),
  ('manager', 'property.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 11. RLS
-- =====================================================================

-- property_owners — owner sees their own; admin sees all.
ALTER TABLE public.property_owners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_owners_select ON public.property_owners;
CREATE POLICY property_owners_select ON public.property_owners FOR SELECT
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR user_id = auth.uid()
  );

DROP POLICY IF EXISTS property_owners_insert ON public.property_owners;
CREATE POLICY property_owners_insert ON public.property_owners FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS property_owners_update ON public.property_owners;
CREATE POLICY property_owners_update ON public.property_owners FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR user_id = auth.uid()
  )
  WITH CHECK (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR user_id = auth.uid()
  );


-- unit_owners — admin/manager + the owner themselves can read.
ALTER TABLE public.unit_owners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unit_owners_select ON public.unit_owners;
CREATE POLICY unit_owners_select ON public.unit_owners FOR SELECT
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.property_owners po
       WHERE po.id = unit_owners.owner_id AND po.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS unit_owners_modify ON public.unit_owners;
CREATE POLICY unit_owners_modify ON public.unit_owners FOR ALL
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  );


-- owner_statements — owner sees own; admin/manager all; writes admin-only.
ALTER TABLE public.owner_statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_statements_select ON public.owner_statements;
CREATE POLICY owner_statements_select ON public.owner_statements FOR SELECT
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.property_owners po
       WHERE po.id = owner_statements.owner_id AND po.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS owner_statements_modify ON public.owner_statements;
CREATE POLICY owner_statements_modify ON public.owner_statements FOR ALL
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  );


-- tenant_statements — tenant sees own (via lease_parties); admin all.
ALTER TABLE public.tenant_statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_statements_select ON public.tenant_statements;
CREATE POLICY tenant_statements_select ON public.tenant_statements FOR SELECT
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.lease_parties lp
       WHERE lp.lease_id = tenant_statements.lease_id
         AND lp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS tenant_statements_modify ON public.tenant_statements;
CREATE POLICY tenant_statements_modify ON public.tenant_statements FOR ALL
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 12. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.property_owners',     'table', 'userportal',
   ARRAY['userportal']::text[], 'Property owner identity records',          false),
  ('public.unit_owners',         'table', 'userportal',
   ARRAY['userportal']::text[], 'M:N unit-owner with ownership history',    false),
  ('public.owner_statements',    'table', 'userportal',
   ARRAY['userportal']::text[], 'Periodic owner financial statements',      false),
  ('public.tenant_statements',   'table', 'userportal',
   ARRAY['userportal']::text[], 'Periodic tenant statements per lease',     false),
  ('public.unit_current_owner',  'view',  'userportal',
   ARRAY['userportal']::text[], 'Most-recent active primary owner per unit', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
