-- Auto-capture field-level diffs on UPDATE of public.listings.
--
-- WHY:
-- The current edit path in app/services/listing.services.js
-- (`_updateListing`) writes directly to listings via the supabase
-- client. There's no application-level call to log_activity for the
-- generic "edit a listing" flow — only special-case verbs like
-- archive / unarchive / remarks_updated / cloned go through the
-- repository.
--
-- A BEFORE UPDATE trigger captures the diff in `activities` so the
-- listing-history drawer has data to show — without touching the
-- write path. Pure additive: existing readers and writers are unaffected.
--
-- WHAT GETS CAPTURED:
-- An allowlist of business-meaningful columns. Excluded:
--   - updated_at / updated_by  (noise — every update touches them)
--   - created_*, deleted_*     (handled by other audit verbs)
--   - *_legacy                 (reconciliation handles its own audit)
--   - tsvector / search columns (derived)
--   - geom / lat_lng           (PostGIS, large + opaque diff payloads)
--
-- Storing diffs as jsonb { col: { from: <text>, to: <text> } }
-- keeps the activity row compact and human-renderable.
--
-- ACTOR IDENTIFICATION:
-- We stamp activities.user_id from auth.uid(). When the trigger fires
-- inside a PostgREST request, the JWT-derived auth.uid() is set, so
-- this works. For a future server-cron path that updates listings
-- without a JWT, auth.uid() returns NULL and the audit row simply
-- has user_id = NULL — already supported by the activities schema.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS listings_audit_diff ON public.listings;
--   DROP FUNCTION IF EXISTS public.listings_audit_diff_fn();

CREATE OR REPLACE FUNCTION public.listings_audit_diff_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changes jsonb := '{}'::jsonb;
  v_actor uuid := auth.uid();
BEGIN
  -- Skip when the row was just touched by other audit verbs that
  -- already log their own diff (avoid double-counting).
  --   - archive / unarchive flip is_online and call logActivity
  --   - remarks_updated patches `remarks` and calls logActivity
  --   - soft_delete sets deleted_at and calls logActivity
  -- We can't perfectly detect those here (the trigger fires on every
  -- UPDATE), but the diff payload they emit is identical in shape to
  -- ours, so worst case the timeline shows two consecutive entries
  -- with overlapping data — readable, not duplicate-confusing.

  -- Per-column diff. IS DISTINCT FROM handles NULLs correctly.
  -- Group columns by category to keep the function readable.

  -- Identification / classification
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    v_changes := v_changes || jsonb_build_object(
      'title', jsonb_build_object('from', OLD.title, 'to', NEW.title));
  END IF;
  IF NEW.unit_number IS DISTINCT FROM OLD.unit_number THEN
    v_changes := v_changes || jsonb_build_object(
      'unit_number', jsonb_build_object('from', OLD.unit_number, 'to', NEW.unit_number));
  END IF;
  IF NEW.property_category IS DISTINCT FROM OLD.property_category THEN
    v_changes := v_changes || jsonb_build_object(
      'property_category', jsonb_build_object('from', OLD.property_category, 'to', NEW.property_category));
  END IF;
  IF NEW.property_type IS DISTINCT FROM OLD.property_type THEN
    v_changes := v_changes || jsonb_build_object(
      'property_type', jsonb_build_object('from', OLD.property_type, 'to', NEW.property_type));
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_changes := v_changes || jsonb_build_object(
      'status', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  IF NEW.condition IS DISTINCT FROM OLD.condition THEN
    v_changes := v_changes || jsonb_build_object(
      'condition', jsonb_build_object('from', OLD.condition, 'to', NEW.condition));
  END IF;
  IF NEW.is_online IS DISTINCT FROM OLD.is_online THEN
    v_changes := v_changes || jsonb_build_object(
      'is_online', jsonb_build_object('from', OLD.is_online, 'to', NEW.is_online));
  END IF;
  IF NEW.for_sale IS DISTINCT FROM OLD.for_sale THEN
    v_changes := v_changes || jsonb_build_object(
      'for_sale', jsonb_build_object('from', OLD.for_sale, 'to', NEW.for_sale));
  END IF;
  IF NEW.for_rent IS DISTINCT FROM OLD.for_rent THEN
    v_changes := v_changes || jsonb_build_object(
      'for_rent', jsonb_build_object('from', OLD.for_rent, 'to', NEW.for_rent));
  END IF;

  -- Pricing
  IF NEW.sale_price IS DISTINCT FROM OLD.sale_price THEN
    v_changes := v_changes || jsonb_build_object(
      'sale_price', jsonb_build_object('from', OLD.sale_price, 'to', NEW.sale_price));
  END IF;
  IF NEW.rent_price IS DISTINCT FROM OLD.rent_price THEN
    v_changes := v_changes || jsonb_build_object(
      'rent_price', jsonb_build_object('from', OLD.rent_price, 'to', NEW.rent_price));
  END IF;
  IF NEW.security_deposit IS DISTINCT FROM OLD.security_deposit THEN
    v_changes := v_changes || jsonb_build_object(
      'security_deposit', jsonb_build_object('from', OLD.security_deposit, 'to', NEW.security_deposit));
  END IF;
  IF NEW.rent_advance IS DISTINCT FROM OLD.rent_advance THEN
    v_changes := v_changes || jsonb_build_object(
      'rent_advance', jsonb_build_object('from', OLD.rent_advance, 'to', NEW.rent_advance));
  END IF;
  IF NEW.association_dues IS DISTINCT FROM OLD.association_dues THEN
    v_changes := v_changes || jsonb_build_object(
      'association_dues', jsonb_build_object('from', OLD.association_dues, 'to', NEW.association_dues));
  END IF;

  -- Physical attributes
  IF NEW.bedrooms IS DISTINCT FROM OLD.bedrooms THEN
    v_changes := v_changes || jsonb_build_object(
      'bedrooms', jsonb_build_object('from', OLD.bedrooms, 'to', NEW.bedrooms));
  END IF;
  IF NEW.bathrooms IS DISTINCT FROM OLD.bathrooms THEN
    v_changes := v_changes || jsonb_build_object(
      'bathrooms', jsonb_build_object('from', OLD.bathrooms, 'to', NEW.bathrooms));
  END IF;
  IF NEW.parking_spaces IS DISTINCT FROM OLD.parking_spaces THEN
    v_changes := v_changes || jsonb_build_object(
      'parking_spaces', jsonb_build_object('from', OLD.parking_spaces, 'to', NEW.parking_spaces));
  END IF;
  IF NEW.floor_area IS DISTINCT FROM OLD.floor_area THEN
    v_changes := v_changes || jsonb_build_object(
      'floor_area', jsonb_build_object('from', OLD.floor_area, 'to', NEW.floor_area));
  END IF;
  IF NEW.lot_area IS DISTINCT FROM OLD.lot_area THEN
    v_changes := v_changes || jsonb_build_object(
      'lot_area', jsonb_build_object('from', OLD.lot_area, 'to', NEW.lot_area));
  END IF;

  -- Availability / lease terms
  IF NEW.availability_date IS DISTINCT FROM OLD.availability_date THEN
    v_changes := v_changes || jsonb_build_object(
      'availability_date', jsonb_build_object('from', OLD.availability_date, 'to', NEW.availability_date));
  END IF;
  IF NEW.lease_term IS DISTINCT FROM OLD.lease_term THEN
    v_changes := v_changes || jsonb_build_object(
      'lease_term', jsonb_build_object('from', OLD.lease_term, 'to', NEW.lease_term));
  END IF;

  -- Description / remarks (truncate large fields to keep activity rows
  -- bounded — full-text diffing is not the point here, just "this
  -- changed at this time").
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    v_changes := v_changes || jsonb_build_object(
      'description', jsonb_build_object(
        'from', LEFT(COALESCE(OLD.description, ''), 200),
        'to',   LEFT(COALESCE(NEW.description, ''), 200)));
  END IF;
  IF NEW.remarks IS DISTINCT FROM OLD.remarks THEN
    v_changes := v_changes || jsonb_build_object(
      'remarks', jsonb_build_object(
        'from', LEFT(COALESCE(OLD.remarks, ''), 200),
        'to',   LEFT(COALESCE(NEW.remarks, ''), 200)));
  END IF;

  -- FK movement (assignment / building)
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    v_changes := v_changes || jsonb_build_object(
      'contact_id', jsonb_build_object('from', OLD.contact_id, 'to', NEW.contact_id));
  END IF;
  IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    v_changes := v_changes || jsonb_build_object(
      'property_id', jsonb_build_object('from', OLD.property_id, 'to', NEW.property_id));
  END IF;

  -- Nothing changed (or nothing on the allowlist changed). Don't write
  -- a noise audit row.
  IF v_changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  -- Direct INSERT (not via log_activity RPC) because the RPC re-derives
  -- auth.uid() and we already have it; one less function call per write.
  -- INSERT runs with the function owner's privs (SECURITY DEFINER) so
  -- the activities_insert_self RLS policy isn't in our way here.
  INSERT INTO public.activities (user_id, action, entity, entity_id, metadata)
  VALUES (
    v_actor,
    'listing.updated',
    'listing',
    NULL,
    jsonb_build_object(
      'listing_id', NEW.id,
      'changes',    v_changes
    )
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.listings_audit_diff_fn() IS
  'BEFORE UPDATE trigger on public.listings — captures field-level diffs for whitelisted columns into public.activities (action=listing.updated, metadata.changes={col:{from,to}}). Excludes updated_at/_by, _legacy, derived/PostGIS columns.';

DROP TRIGGER IF EXISTS listings_audit_diff ON public.listings;
CREATE TRIGGER listings_audit_diff
  AFTER UPDATE ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.listings_audit_diff_fn();


NOTIFY pgrst, 'reload schema';
