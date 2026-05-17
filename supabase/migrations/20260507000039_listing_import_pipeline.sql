-- Listing Ingestion Pipeline.
--
-- Two-step staged flow for bulk listing import. Same pattern as
-- mig 38's broker_import_*. NEVER auto-publishes — all created
-- listings get is_online = false; existing moderation flow handles
-- the publish flip.
--
-- Per-row resolution chain:
--   city_slug         → cities.id
--   barangay_slug     → barangays.id (must belong to resolved city)
--   organization_slug → organizations.id
--   broker_email      → profiles.id (must be a member of org)
--   building_name     → buildings.id (exact then trgm ≥ 0.7, scoped to city)
--
-- Each row's outcome is stamped with a specific status code; failures
-- isolate per-row (one bad row doesn't fail the whole batch).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.process_listing_import_batch(uuid);
--   DROP TABLE IF EXISTS public.listing_import_rows;
--   DROP TABLE IF EXISTS public.listing_import_batches;


-- =====================================================================
-- 1. listing_import_batches — one row per CSV upload
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listing_import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_label    text,
  uploaded_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Optional FK to listing_sources so the existing per-source
  -- staleness archival can apply. NULL for one-shot uploads.
  -- listing_sources.id is bigint (mig 13: GENERATED ALWAYS AS IDENTITY).
  source_id       bigint REFERENCES public.listing_sources(id) ON DELETE SET NULL,
  total_rows      int NOT NULL DEFAULT 0,
  processed_rows  int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'staged'
                       CHECK (status IN ('staged', 'processed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS listing_import_batches_status_idx
  ON public.listing_import_batches(status, created_at DESC);

ALTER TABLE public.listing_import_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_import_batches_admin ON public.listing_import_batches;
CREATE POLICY listing_import_batches_admin ON public.listing_import_batches FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 2. listing_import_rows — per-row staging
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listing_import_rows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL REFERENCES public.listing_import_batches(id) ON DELETE CASCADE,
  row_number          int NOT NULL,

  -- Staged data — captured exactly as the CSV says. Resolution
  -- happens at process time.
  title               text,
  description         text,
  property_category   text,
  property_type       text,
  -- For-sale or for-rent decided by which price column has a value.
  sale_price          bigint,
  rent_price          int,
  bedrooms            smallint,
  bathrooms           smallint,
  floor_area          smallint,
  lot_area            int,
  parking_spaces      smallint,

  -- Resolution targets (slugs / names from CSV).
  organization_slug   text NOT NULL,
  broker_email        text NOT NULL,
  city_slug           text NOT NULL,
  barangay_slug       text,
  building_name       text,

  -- Image URLs captured but NOT processed this turn (deferred to
  -- the async media pipeline sprint).
  image_urls          text[] NOT NULL DEFAULT '{}'::text[],

  -- Free-form metadata for fields we don't model explicitly v1
  -- (amenities, address-line, etc).
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  outcome             text NOT NULL DEFAULT 'pending'
                           CHECK (outcome IN (
                             'pending',
                             'created_pending_review',  -- listing created with is_online=false
                             'validation_error',
                             'org_not_found',
                             'broker_not_found',
                             'broker_not_in_org',
                             'city_not_found',
                             'barangay_not_found',
                             'building_unresolved',
                             'error'
                           )),
  outcome_detail      text,
  resolved_listing_id bigint,        -- FK populated on success
  resolved_building_id bigint,
  resolved_city_id    bigint,
  resolved_barangay_id bigint,
  resolved_broker_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_org_id     uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  processed_at        timestamptz,

  UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS listing_import_rows_batch_idx
  ON public.listing_import_rows(batch_id, outcome);
CREATE INDEX IF NOT EXISTS listing_import_rows_email_idx
  ON public.listing_import_rows(lower(broker_email));

ALTER TABLE public.listing_import_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_import_rows_admin ON public.listing_import_rows;
CREATE POLICY listing_import_rows_admin ON public.listing_import_rows FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 3. process_listing_import_batch — the matcher + creator
-- =====================================================================

CREATE OR REPLACE FUNCTION public.process_listing_import_batch(p_batch_id uuid)
RETURNS TABLE (
  total            int,
  created          int,
  validation_err   int,
  unresolved       int,
  errors           int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_batch        record;
  v_row          record;
  v_city_id      bigint;
  v_barangay_id  bigint;
  v_org_id       uuid;
  v_broker_id    uuid;
  v_building_id  bigint;
  v_membership   record;
  v_listing_id   bigint;
  v_for_sale     boolean;
  v_for_rent     boolean;
  c_total        int := 0;
  c_created      int := 0;
  c_valerr       int := 0;
  c_unresolved   int := 0;
  c_err          int := 0;
BEGIN
  IF NOT (session_user IN ('postgres','supabase_admin','service_role')
          OR public.has_permission('admin.access')) THEN
    RAISE EXCEPTION 'permission denied: process_listing_import_batch is admin only'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_batch FROM public.listing_import_batches WHERE id = p_batch_id;
  IF v_batch IS NULL THEN
    RAISE EXCEPTION 'batch not found: %', p_batch_id USING ERRCODE = '42704';
  END IF;
  IF v_batch.status = 'processed' THEN
    -- Idempotent re-run.
    SELECT
      count(*) FILTER (WHERE outcome = 'created_pending_review'),
      count(*) FILTER (WHERE outcome IN ('validation_error', 'org_not_found',
                                          'broker_not_found', 'broker_not_in_org',
                                          'city_not_found', 'barangay_not_found')),
      count(*) FILTER (WHERE outcome = 'building_unresolved'),
      count(*) FILTER (WHERE outcome = 'error'),
      count(*)
    INTO c_created, c_valerr, c_unresolved, c_err, c_total
    FROM public.listing_import_rows WHERE batch_id = p_batch_id;
    total := c_total; created := c_created; validation_err := c_valerr;
    unresolved := c_unresolved; errors := c_err;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR v_row IN
    SELECT * FROM public.listing_import_rows
     WHERE batch_id = p_batch_id AND outcome = 'pending'
     ORDER BY row_number
  LOOP
    c_total := c_total + 1;

    -- 1) Validate basic fields.
    IF v_row.title IS NULL OR length(trim(v_row.title)) < 3 THEN
      UPDATE public.listing_import_rows
         SET outcome = 'validation_error',
             outcome_detail = 'Missing or too-short title',
             processed_at = now()
       WHERE id = v_row.id;
      c_valerr := c_valerr + 1;
      CONTINUE;
    END IF;

    v_for_sale := v_row.sale_price IS NOT NULL AND v_row.sale_price > 0;
    v_for_rent := v_row.rent_price IS NOT NULL AND v_row.rent_price > 0;
    IF NOT v_for_sale AND NOT v_for_rent THEN
      UPDATE public.listing_import_rows
         SET outcome = 'validation_error',
             outcome_detail = 'Need either sale_price or rent_price > 0',
             processed_at = now()
       WHERE id = v_row.id;
      c_valerr := c_valerr + 1;
      CONTINUE;
    END IF;

    -- 2) Resolve organization.
    SELECT id INTO v_org_id FROM public.organizations
     WHERE slug = v_row.organization_slug LIMIT 1;
    IF v_org_id IS NULL THEN
      UPDATE public.listing_import_rows
         SET outcome = 'org_not_found',
             outcome_detail = 'No organization with slug ' || v_row.organization_slug,
             processed_at = now()
       WHERE id = v_row.id;
      c_valerr := c_valerr + 1;
      CONTINUE;
    END IF;

    -- 3) Resolve broker.
    SELECT id INTO v_broker_id FROM public.profiles
     WHERE lower(email) = lower(v_row.broker_email) LIMIT 1;
    IF v_broker_id IS NULL THEN
      UPDATE public.listing_import_rows
         SET outcome = 'broker_not_found',
             outcome_detail = 'No profile with email ' || v_row.broker_email,
             resolved_org_id = v_org_id,
             processed_at = now()
       WHERE id = v_row.id;
      c_valerr := c_valerr + 1;
      CONTINUE;
    END IF;

    -- 4) Confirm broker is a member of the target org.
    SELECT * INTO v_membership FROM public.organization_memberships
     WHERE user_id = v_broker_id
       AND organization_id = v_org_id
       AND status IN ('active', 'trial')
     LIMIT 1;
    IF v_membership IS NULL THEN
      UPDATE public.listing_import_rows
         SET outcome = 'broker_not_in_org',
             outcome_detail = 'Broker exists but is not a member of ' || v_row.organization_slug,
             resolved_org_id = v_org_id,
             resolved_broker_id = v_broker_id,
             processed_at = now()
       WHERE id = v_row.id;
      c_valerr := c_valerr + 1;
      CONTINUE;
    END IF;

    -- 5) Resolve city.
    SELECT id INTO v_city_id FROM public.cities
     WHERE slug = v_row.city_slug LIMIT 1;
    IF v_city_id IS NULL THEN
      UPDATE public.listing_import_rows
         SET outcome = 'city_not_found',
             outcome_detail = 'No city with slug ' || v_row.city_slug,
             resolved_org_id = v_org_id,
             resolved_broker_id = v_broker_id,
             processed_at = now()
       WHERE id = v_row.id;
      c_valerr := c_valerr + 1;
      CONTINUE;
    END IF;

    -- 6) Resolve barangay (optional).
    v_barangay_id := NULL;
    IF v_row.barangay_slug IS NOT NULL AND length(v_row.barangay_slug) > 0 THEN
      SELECT id INTO v_barangay_id FROM public.barangays
       WHERE slug = v_row.barangay_slug AND city_id = v_city_id LIMIT 1;
      IF v_barangay_id IS NULL THEN
        UPDATE public.listing_import_rows
           SET outcome = 'barangay_not_found',
               outcome_detail = 'No barangay ' || v_row.barangay_slug || ' in city ' || v_row.city_slug,
               resolved_org_id = v_org_id,
               resolved_broker_id = v_broker_id,
               resolved_city_id = v_city_id,
               processed_at = now()
         WHERE id = v_row.id;
        c_valerr := c_valerr + 1;
        CONTINUE;
      END IF;
    END IF;

    -- 7) Resolve building (optional but if provided, must resolve).
    v_building_id := NULL;
    IF v_row.building_name IS NOT NULL AND length(trim(v_row.building_name)) > 0 THEN
      -- Exact ci match first, then trgm fuzzy ≥ 0.7 within the city.
      SELECT id INTO v_building_id FROM public.buildings
       WHERE city_id = v_city_id
         AND lower(name) = lower(trim(v_row.building_name))
       LIMIT 1;
      IF v_building_id IS NULL THEN
        SELECT id INTO v_building_id FROM public.buildings
         WHERE city_id = v_city_id
           AND similarity(name, v_row.building_name) >= 0.7
         ORDER BY similarity(name, v_row.building_name) DESC
         LIMIT 1;
      END IF;
      IF v_building_id IS NULL THEN
        UPDATE public.listing_import_rows
           SET outcome = 'building_unresolved',
               outcome_detail = 'Building "' || v_row.building_name || '" not found in ' || v_row.city_slug,
               resolved_org_id = v_org_id,
               resolved_broker_id = v_broker_id,
               resolved_city_id = v_city_id,
               resolved_barangay_id = v_barangay_id,
               processed_at = now()
         WHERE id = v_row.id;
        c_unresolved := c_unresolved + 1;
        CONTINUE;
      END IF;
    END IF;

    -- 8) Insert listing with is_online = false. Moderation flips it
    --    online via the existing flow.
    BEGIN
      INSERT INTO public.listings (
        title, description,
        property_category, property_type,
        sale_price, rent_price,
        for_sale, for_rent,
        bedrooms, bathrooms, floor_area, lot_area, parking_spaces,
        city_id, barangay_id, building_id,
        created_by, source_id,
        is_online, status
      )
      VALUES (
        v_row.title, v_row.description,
        coalesce(v_row.property_category, 'residential'),
        coalesce(v_row.property_type, 'condo'),
        CASE WHEN v_for_sale THEN v_row.sale_price ELSE NULL END,
        CASE WHEN v_for_rent THEN v_row.rent_price ELSE NULL END,
        v_for_sale, v_for_rent,
        v_row.bedrooms, v_row.bathrooms, v_row.floor_area, v_row.lot_area, v_row.parking_spaces,
        v_city_id, v_barangay_id, v_building_id,
        v_broker_id, v_batch.source_id,
        false,            -- is_online — moderator flips later
        'available'
      )
      RETURNING id INTO v_listing_id;

      UPDATE public.listing_import_rows
         SET outcome = 'created_pending_review',
             outcome_detail = 'Listing created with is_online=false; ready for moderation',
             resolved_listing_id = v_listing_id,
             resolved_org_id = v_org_id,
             resolved_broker_id = v_broker_id,
             resolved_city_id = v_city_id,
             resolved_barangay_id = v_barangay_id,
             resolved_building_id = v_building_id,
             processed_at = now()
       WHERE id = v_row.id;
      c_created := c_created + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.listing_import_rows
         SET outcome = 'error',
             outcome_detail = SQLERRM,
             resolved_org_id = v_org_id,
             resolved_broker_id = v_broker_id,
             resolved_city_id = v_city_id,
             resolved_barangay_id = v_barangay_id,
             resolved_building_id = v_building_id,
             processed_at = now()
       WHERE id = v_row.id;
      c_err := c_err + 1;
    END;
  END LOOP;

  UPDATE public.listing_import_batches
     SET status = 'processed',
         processed_at = now(),
         processed_rows = c_total
   WHERE id = p_batch_id;

  total := c_total;
  created := c_created;
  validation_err := c_valerr;
  unresolved := c_unresolved;
  errors := c_err;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_listing_import_batch(uuid) TO authenticated;


-- =====================================================================
-- 4. Governance contracts
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.listing_import_batches', 'table',    'userportal', ARRAY['userportal'],
   'CSV upload metadata for bulk listing imports. is_online stays false on created listings — moderator flips them.', false),
  ('public.listing_import_rows',    'table',    'userportal', ARRAY['userportal'],
   'Per-row staging with resolved IDs + outcome state machine. Existing duplicate detector picks up created listings on next 30-min cron.', false),
  ('public.process_listing_import_batch', 'function', 'userportal', ARRAY['userportal'],
   'Two-step processor: validates + resolves slugs + creates listings with is_online=false. Per-row error isolation.', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
