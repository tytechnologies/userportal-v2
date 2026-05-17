-- Reference RBAC bridge.
--
-- Background:
--   The reference schema (db-main-reference/security.sql) declares 13
--   snake_case permission names against a security.permissions table
--   and grants them to roles `admin / internal / external / dev`.
--   Mig 20260430000003 layered a NEW catalog at public.permissions /
--   public.role_permissions using dotted names ('admin.access',
--   'listings.read.all', etc.) against roles `admin / manager / agent`,
--   and REPLACED public.has_permission(text) to read from the new
--   catalog. The reference's catalog became dormant.
--
-- The user's directive (2026-05-13): the reference schema must stay
-- true. If anything still calls a reference-named permission — either
-- a lingering RLS policy from before mig 430000003 or future code
-- written against the reference contract — public.has_permission()
-- must resolve it correctly.
--
-- This migration is the bridge. STRICTLY ADDITIVE:
--   - Registers each reference permission name in public.permissions.
--   - Grants each name to the userportal role that semantically owns
--     it (admin → all; manager → the read.all-equivalents per the
--     reference's `internal` role intent).
--   - Does NOT modify existing rows (ON CONFLICT DO NOTHING).
--   - Does NOT touch the reference's security.* tables.
--   - Does NOT touch has_permission() body.
--
-- Effect after apply:
--   public.has_permission('view_all_listings')   -- returns TRUE for admin / manager
--   public.has_permission('edit_any_listing')    -- returns TRUE for admin
--   public.has_permission('listings.read.all')   -- unchanged
--   public.has_permission('admin.access')        -- unchanged
--
-- Reference RLS policies, IF still applied to public.listings /
-- public.properties / public.contacts / public.inquiries /
-- public.listing_images / public.listing_amenities /
-- public.property_amenities / public.featured_listings, become
-- functional again instead of silently denying.
--
-- ROLLBACK:
--   DELETE FROM public.role_permissions
--    WHERE permission IN (
--      'view_all_listings', 'edit_any_listing', 'delete_any_listing',
--      'view_all_properties', 'edit_any_property', 'delete_any_property',
--      'view_all_contacts', 'edit_any_contact', 'delete_any_contact',
--      'view_all_inquiries', 'edit_any_inquiry', 'delete_any_inquiry',
--      'edit_featured_listings'
--    );
--   DELETE FROM public.permissions
--    WHERE name IN (
--      'view_all_listings', 'edit_any_listing', 'delete_any_listing',
--      'view_all_properties', 'edit_any_property', 'delete_any_property',
--      'view_all_contacts', 'edit_any_contact', 'delete_any_contact',
--      'view_all_inquiries', 'edit_any_inquiry', 'delete_any_inquiry',
--      'edit_featured_listings'
--    );


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='permissions') THEN
    v_missing := v_missing || 'public.permissions (mig 430000003)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='role_permissions') THEN
    v_missing := v_missing || 'public.role_permissions (mig 430000003)';
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 20260513000001 missing prerequisites: %.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. Register reference permission names
-- =====================================================================
-- One row per reference permission, categorised 'reference_bridge' so
-- the admin UI matrix groups them distinctly from the dotted catalog.

INSERT INTO public.permissions (name, description, category) VALUES
  ('view_all_listings',     'Reference RBAC bridge — equivalent of listings.read.all',     'reference_bridge'),
  ('edit_any_listing',      'Reference RBAC bridge — equivalent of listings.write.all',    'reference_bridge'),
  ('delete_any_listing',    'Reference RBAC bridge — equivalent of listings.delete',       'reference_bridge'),
  ('view_all_properties',   'Reference RBAC bridge — read every property',                 'reference_bridge'),
  ('edit_any_property',     'Reference RBAC bridge — write any property',                  'reference_bridge'),
  ('delete_any_property',   'Reference RBAC bridge — delete any property',                 'reference_bridge'),
  ('view_all_contacts',     'Reference RBAC bridge — equivalent of contacts.read.all',     'reference_bridge'),
  ('edit_any_contact',      'Reference RBAC bridge — equivalent of contacts.write.all',    'reference_bridge'),
  ('delete_any_contact',    'Reference RBAC bridge — delete any contact',                  'reference_bridge'),
  ('view_all_inquiries',    'Reference RBAC bridge — read every inquiry',                  'reference_bridge'),
  ('edit_any_inquiry',      'Reference RBAC bridge — write any inquiry',                   'reference_bridge'),
  ('delete_any_inquiry',    'Reference RBAC bridge — delete any inquiry',                  'reference_bridge'),
  ('edit_featured_listings','Reference RBAC bridge — manage featured listings carousel',   'reference_bridge')
ON CONFLICT (name) DO NOTHING;


-- =====================================================================
-- 2. Grant reference permissions to userportal roles
-- =====================================================================
-- admin gets everything (the reference's `admin` role had every grant).
-- manager gets the read.* equivalents (the reference's `internal` role
-- got view_all_listings / view_all_contacts / view_all_properties).
-- agent gets nothing here — the reference's `external` role got only
-- view_all_listings, which we intentionally do NOT bridge: in the
-- userportal model, an agent's RLS is "own data only" by default and
-- granting view_all_listings would silently widen visibility.

INSERT INTO public.role_permissions (role, permission) VALUES
  -- admin — full bridge
  ('admin', 'view_all_listings'),
  ('admin', 'edit_any_listing'),
  ('admin', 'delete_any_listing'),
  ('admin', 'view_all_properties'),
  ('admin', 'edit_any_property'),
  ('admin', 'delete_any_property'),
  ('admin', 'view_all_contacts'),
  ('admin', 'edit_any_contact'),
  ('admin', 'delete_any_contact'),
  ('admin', 'view_all_inquiries'),
  ('admin', 'edit_any_inquiry'),
  ('admin', 'delete_any_inquiry'),
  ('admin', 'edit_featured_listings'),
  -- manager — read.* equivalents (matches reference `internal` role intent)
  ('manager', 'view_all_listings'),
  ('manager', 'view_all_properties'),
  ('manager', 'view_all_contacts'),
  ('manager', 'view_all_inquiries')
ON CONFLICT (role, permission) DO NOTHING;


-- =====================================================================
-- 3. Governance contract
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RETURN;
  END IF;
  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('rbac.reference_bridge', 'function', 'userportal', ARRAY['userportal','website'],
     'Bridge keeping the reference schema''s permission catalog (view_all_listings, edit_any_listing, …) honored by public.has_permission(). 13 reference permissions registered in public.permissions; admin/manager grants follow reference intent. Additive only.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE — paste in the SQL editor.
-- =====================================================================
--
-- 1) All 13 reference names registered.
-- SELECT name, category, description
--   FROM public.permissions
--  WHERE category = 'reference_bridge'
--  ORDER BY name;
--
-- 2) Admin grants are complete (expect 13 rows).
-- SELECT role, count(*)
--   FROM public.role_permissions
--  WHERE permission IN (
--    'view_all_listings','edit_any_listing','delete_any_listing',
--    'view_all_properties','edit_any_property','delete_any_property',
--    'view_all_contacts','edit_any_contact','delete_any_contact',
--    'view_all_inquiries','edit_any_inquiry','delete_any_inquiry',
--    'edit_featured_listings'
--  )
--  GROUP BY role
--  ORDER BY role;
--
-- 3) Functional test — has_permission resolves reference names.
--    (Run as your own user — admin should return true for all.)
-- SELECT public.has_permission('view_all_listings')     AS reference_view_all_listings,
--        public.has_permission('edit_any_listing')      AS reference_edit_any_listing,
--        public.has_permission('listings.read.all')     AS userportal_listings_read_all;
