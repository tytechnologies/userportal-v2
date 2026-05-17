-- Units (under buildings) + Occupancy ledger.
--
-- C1 of the post-audit roadmap. Introduces the physical-asset layer
-- between buildings and listings. A listing is a marketing artifact;
-- a unit is the actual property. Many listings can refer to the
-- same unit over its lifetime (resale, re-let, status change).
--
-- Lease integration (C2) will FK leases.unit_id → units.id and tie
-- occupancy rows to leases. Until then, unit_occupancy.lease_id is
-- an unconstrained uuid that the C2 migration will harden.
--
-- Existing surfaces preserved:
--   - buildings, listings           — unchanged.
--   - listing_details view          — unchanged (unit_id is additive).
--   - public listing surfaces       — unchanged.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.unit_listing_history;
--   DROP VIEW IF EXISTS public.unit_current_occupancy;
--   DROP TABLE IF EXISTS public.unit_occupancy;
--   ALTER TABLE public.listings DROP COLUMN IF EXISTS unit_id;
--   DROP TABLE IF EXISTS public.units;
--   DELETE FROM public.role_permissions WHERE permission = 'units.manage';
--   DELETE FROM public.permissions WHERE name = 'units.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.units', 'public.unit_occupancy',
--      'public.unit_listing_history', 'public.unit_current_occupancy');


-- =====================================================================
-- 1. units — physical asset inventory
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.units (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- buildings.id is bigint per mig 20260501000006.
  building_id         bigint NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,

  -- Operator-displayed identifier within the building. Application
  -- normalises before insert (uppercase, no leading 'Unit '/'#').
  unit_number         text NOT NULL,

  floor               int,
  -- Optional sub-grouping for multi-tower complexes.
  tower               text,

  -- Physical specs.
  bedrooms            numeric(3,1) CHECK (bedrooms IS NULL OR bedrooms >= 0),
  bathrooms           numeric(3,1) CHECK (bathrooms IS NULL OR bathrooms >= 0),
  floor_area_sqm      numeric(8,2) CHECK (floor_area_sqm IS NULL OR floor_area_sqm > 0),
  balcony_area_sqm    numeric(8,2) CHECK (balcony_area_sqm IS NULL OR balcony_area_sqm >= 0),
  parking_slots       int CHECK (parking_slots IS NULL OR parking_slots >= 0),
  storage_units       int CHECK (storage_units IS NULL OR storage_units >= 0),

  -- N / E / S / W / NE / NW / SE / SW
  orientation         text CHECK (orientation IS NULL OR orientation IN
                           ('N','E','S','W','NE','NW','SE','SW')),
  -- Documented values: 'sea_view', 'city_view', 'pool_view',
  -- 'mountain_view', 'inner_court', 'park_view', 'street_view'.
  facing              text,

  -- Documented values: 'studio', '1br', '2br', '3br', '4br_plus',
  -- 'penthouse', 'duplex', 'townhouse', 'commercial'.
  unit_type           text,

  status              text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'inactive', 'demolished')),

  -- Free-form, non-pricing physical/amenity attributes. Documented
  -- keys: smart_home, walk_in_closet, en_suite_master, fireplace,
  -- private_pool, accessibility, finishings_grade.
  features            jsonb NOT NULL DEFAULT '{}'::jsonb,

  notes               text,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (building_id, unit_number)
);

CREATE INDEX IF NOT EXISTS units_building_idx
  ON public.units(building_id, status);
CREATE INDEX IF NOT EXISTS units_active_idx
  ON public.units(building_id, unit_type)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS set_units_updated_at ON public.units;
CREATE TRIGGER set_units_updated_at
  BEFORE UPDATE ON public.units
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.units IS
  'Physical asset inventory under a building. UNIQUE(building_id, unit_number). Listings reference units via listings.unit_id (nullable; many listings may share a unit over its lifetime).';


-- =====================================================================
-- 2. listings.unit_id — additive nullable FK
-- =====================================================================
--
-- Existing listings stay functional with NULL. Future ingestion can
-- populate via (building_id, unit_number) lookup-or-create.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES public.units(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS listings_unit_idx
  ON public.listings(unit_id) WHERE unit_id IS NOT NULL;

COMMENT ON COLUMN public.listings.unit_id IS
  'Optional FK to public.units. When set, the listing represents a marketing offer for this physical unit. Many listings may bind to the same unit over time.';


-- =====================================================================
-- 3. unit_occupancy — append-only ledger
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.unit_occupancy (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id             uuid NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,

  -- Documented values:
  --   'owner_occupied' — owner lives there
  --   'tenant_lease'   — bound to a lease (lease_id set when C2 lands)
  --   'vacant'         — empty
  --   'developer_held' — pre-handover, developer holds
  --   'undisclosed'    — operator records but won't say which
  occupancy_kind      text NOT NULL CHECK (occupancy_kind IN
                           ('owner_occupied', 'tenant_lease', 'vacant',
                            'developer_held', 'undisclosed')),

  -- Occupant identity. At least one of user_id / contact_id /
  -- external_email is set when occupancy_kind ∈ (owner_occupied,
  -- tenant_lease). vacant / developer_held / undisclosed leave all NULL.
  occupant_user_id        uuid   REFERENCES public.profiles(id) ON DELETE SET NULL,
  occupant_contact_id     bigint REFERENCES public.contacts(id) ON DELETE SET NULL,
  occupant_external_name  text,
  occupant_external_email text,

  -- Forward-FK to leases (added in C2). Loose uuid here; C2 will add
  -- the FK constraint via information_schema-check.
  lease_id            uuid,

  move_in_at          timestamptz NOT NULL DEFAULT now(),
  move_out_at         timestamptz,

  -- Provenance.
  reported_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Documented values: 'admin', 'self_reported', 'lease_signed',
  -- 'mls_import', 'building_management'.
  source              text NOT NULL DEFAULT 'admin',

  notes               text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (move_out_at IS NULL OR move_out_at > move_in_at),
  CHECK (
    occupancy_kind IN ('vacant', 'developer_held', 'undisclosed')
    OR occupant_user_id IS NOT NULL
    OR occupant_contact_id IS NOT NULL
    OR occupant_external_email IS NOT NULL
    OR occupant_external_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS unit_occupancy_unit_idx
  ON public.unit_occupancy(unit_id, move_in_at DESC);
CREATE INDEX IF NOT EXISTS unit_occupancy_active_idx
  ON public.unit_occupancy(unit_id, move_in_at DESC)
  WHERE move_out_at IS NULL;
CREATE INDEX IF NOT EXISTS unit_occupancy_user_idx
  ON public.unit_occupancy(occupant_user_id) WHERE occupant_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS unit_occupancy_lease_idx
  ON public.unit_occupancy(lease_id) WHERE lease_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_unit_occupancy_updated_at ON public.unit_occupancy;
CREATE TRIGGER set_unit_occupancy_updated_at
  BEFORE UPDATE ON public.unit_occupancy
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.unit_occupancy IS
  'Append-only occupancy ledger. lease_id is a forward-FK to leases (C2). DELETE blocked at API layer; corrections are new rows with move_out_at on the prior row.';


-- =====================================================================
-- 4. unit_current_occupancy view — most-recent open row per unit
-- =====================================================================

CREATE OR REPLACE VIEW public.unit_current_occupancy AS
SELECT DISTINCT ON (uo.unit_id)
  uo.unit_id,
  uo.id                       AS occupancy_id,
  uo.occupancy_kind,
  uo.occupant_user_id,
  uo.occupant_contact_id,
  uo.occupant_external_name,
  uo.occupant_external_email,
  uo.lease_id,
  uo.move_in_at,
  uo.move_out_at,
  uo.source
FROM public.unit_occupancy uo
WHERE uo.move_out_at IS NULL
ORDER BY uo.unit_id, uo.move_in_at DESC, uo.created_at DESC;

GRANT SELECT ON public.unit_current_occupancy TO authenticated;


-- =====================================================================
-- 5. unit_listing_history view
-- =====================================================================
--
-- Joins units → all their listings, ordered by listing.created_at.
-- Underlying listings RLS still applies — non-permitted callers see
-- no rows for listings they can't read.

CREATE OR REPLACE VIEW public.unit_listing_history AS
SELECT
  l.unit_id,
  l.id           AS listing_id,
  l.title,
  l.is_online,
  l.created_at,
  l.created_by,
  l.sale_price,
  l.rent_price
FROM public.listings l
WHERE l.unit_id IS NOT NULL
  AND l.deleted_at IS NULL
ORDER BY l.unit_id, l.created_at DESC;

GRANT SELECT ON public.unit_listing_history TO authenticated;


-- =====================================================================
-- 6. RLS helpers
-- =====================================================================

CREATE OR REPLACE FUNCTION public.unit_can_manage(p_unit_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('units.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.listings l
       WHERE l.unit_id = p_unit_id
         AND l.created_by = auth.uid()
         AND l.deleted_at IS NULL
    );
$$;
GRANT EXECUTE ON FUNCTION public.unit_can_manage(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.unit_occupancy_can_read(p_unit_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_permission('units.manage')
    OR public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.unit_occupancy uo
       WHERE uo.unit_id = p_unit_id
         AND uo.occupant_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.listings l
       WHERE l.unit_id = p_unit_id
         AND l.created_by = auth.uid()
         AND l.deleted_at IS NULL
    );
$$;
GRANT EXECUTE ON FUNCTION public.unit_occupancy_can_read(uuid) TO authenticated;


-- =====================================================================
-- 7. RLS
-- =====================================================================

ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS units_select ON public.units;
CREATE POLICY units_select ON public.units FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS units_insert ON public.units;
CREATE POLICY units_insert ON public.units FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('units.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS units_update ON public.units;
CREATE POLICY units_update ON public.units FOR UPDATE
  TO authenticated
  USING (public.unit_can_manage(id))
  WITH CHECK (public.unit_can_manage(id));

-- DELETE not exposed. Use status='inactive'.


ALTER TABLE public.unit_occupancy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unit_occupancy_select ON public.unit_occupancy;
CREATE POLICY unit_occupancy_select ON public.unit_occupancy FOR SELECT
  TO authenticated USING (public.unit_occupancy_can_read(unit_id));

DROP POLICY IF EXISTS unit_occupancy_insert ON public.unit_occupancy;
CREATE POLICY unit_occupancy_insert ON public.unit_occupancy FOR INSERT
  TO authenticated
  WITH CHECK (
    public.unit_can_manage(unit_id)
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS unit_occupancy_update ON public.unit_occupancy;
CREATE POLICY unit_occupancy_update ON public.unit_occupancy FOR UPDATE
  TO authenticated
  USING (
    public.unit_can_manage(unit_id)
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.unit_can_manage(unit_id)
    OR public.has_permission('admin.access')
  );

-- DELETE blocked. Append-only.


-- =====================================================================
-- 8. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('units.manage', 'Create and update units; record occupancy', 'property')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'units.manage'),
  ('manager', 'units.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 9. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.units',                   'table', 'userportal',
   ARRAY['userportal']::text[], 'Physical asset inventory under buildings',  false),
  ('public.unit_occupancy',          'table', 'userportal',
   ARRAY['userportal']::text[], 'Append-only occupancy ledger',              false),
  ('public.unit_current_occupancy',  'view',  'userportal',
   ARRAY['userportal']::text[], 'Most recent open occupancy row per unit',   false),
  ('public.unit_listing_history',    'view',  'userportal',
   ARRAY['userportal']::text[], 'Listings history per unit',                 false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
