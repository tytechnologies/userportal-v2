-- Raw + normalized staging tables for partner ingest — B-3.
--
-- Today, /api/admin/listings/ingest validates partner payloads and
-- upserts directly into public.listings keyed by
-- (source_id, foreign_id). That works but couples partner data
-- quality directly to the live marketplace: a partner that pushes
-- garbage temporarily corrupts the public surface.
--
-- This migration adds two staging tables that sit ABOVE listings:
--
--   listings_raw         — every partner POST row lands here verbatim
--                          (raw_json). Idempotent on
--                          (source_id, foreign_id, raw_hash) so
--                          re-pushes are no-ops.
--   listings_normalized  — resolution targets (FK ids), validated
--                          shapes, match_status state machine.
--
-- A normalization worker drains listings_raw → listings_normalized.
-- A future B-3.1 worker will drain listings_normalized → listings.
-- The existing ingest endpoint keeps writing to listings during the
-- dual-write window so behavior is unchanged at the public layer.
--
-- Strictly additive: no existing tables / columns / FKs are modified.
-- Reference schema untouched. RLS gated on admin.access; service-role
-- bypasses RLS for the cron worker path.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.set_listings_raw_hash();
--   DROP TRIGGER  IF EXISTS listings_raw_hash_trg ON public.listings_raw;
--   DROP TABLE    IF EXISTS public.listings_normalized;
--   DROP TABLE    IF EXISTS public.listings_raw;
--   DELETE FROM public.governance_schema_contracts
--    WHERE contract_name IN (
--      'public.listings_raw',
--      'public.listings_normalized'
--    );


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listing_sources') THEN
    v_missing := v_missing || 'public.listing_sources (mig 506000013)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listings') THEN
    v_missing := v_missing || 'public.listings (reference)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='properties') THEN
    v_missing := v_missing || 'public.properties (reference)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') THEN
    v_missing := v_missing || 'extension: pgcrypto (for digest())';
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 20260510000005 missing prerequisites: %.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. listings_raw — every partner POST row, verbatim
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listings_raw (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       bigint NOT NULL REFERENCES public.listing_sources(id) ON DELETE CASCADE,
  foreign_id      text   NOT NULL,
  -- Optional pointer to the ingest run that captured this row.
  -- listing_source_ingest_runs.id was bigint in mig 507000001;
  -- left nullable so manual / one-off captures still write here.
  ingest_run_id   bigint,
  raw_json        jsonb  NOT NULL,
  -- Trigger-populated SHA-256 of raw_json's textual form. Stored so
  -- the UNIQUE (source_id, foreign_id, raw_hash) idempotency works
  -- even on partial-update re-pushes.
  raw_hash        text NOT NULL,

  normalize_status text NOT NULL DEFAULT 'pending'
    CHECK (normalize_status IN ('pending', 'normalized', 'rejected')),
  rejection_reason text,

  ingested_at      timestamptz NOT NULL DEFAULT now(),
  normalized_at    timestamptz,

  UNIQUE (source_id, foreign_id, raw_hash)
);

CREATE INDEX IF NOT EXISTS listings_raw_pending_idx
  ON public.listings_raw(ingested_at)
  WHERE normalize_status = 'pending';

CREATE INDEX IF NOT EXISTS listings_raw_source_foreign_idx
  ON public.listings_raw(source_id, foreign_id);

COMMENT ON TABLE public.listings_raw IS
  'Every partner-pushed listing row, captured verbatim before normalization. Idempotent on (source_id, foreign_id, raw_hash) so re-pushes of identical payloads are no-ops. Drained by /api/internal/normalize-raw-batch.';
COMMENT ON COLUMN public.listings_raw.raw_hash IS
  'SHA-256(raw_json::text) — populated by trigger. Differentiates updated payloads from re-pushes of the same payload.';


-- =====================================================================
-- 2. Trigger — compute raw_hash on INSERT / UPDATE
-- =====================================================================
-- Done in a trigger (not as a STORED generated column) to avoid the
-- jsonb_out IMMUTABILITY edge case across Postgres minor versions
-- and to keep schema-qualification of extensions.digest explicit
-- per feedback_supabase_pgcrypto_search_path.

CREATE OR REPLACE FUNCTION public.set_listings_raw_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  NEW.raw_hash := encode(
    extensions.digest(NEW.raw_json::text, 'sha256'),
    'hex'
  );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listings_raw_hash_trg ON public.listings_raw;
CREATE TRIGGER listings_raw_hash_trg
  BEFORE INSERT OR UPDATE OF raw_json ON public.listings_raw
  FOR EACH ROW EXECUTE FUNCTION public.set_listings_raw_hash();


-- =====================================================================
-- 3. listings_normalized — resolved + validated shape
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listings_normalized (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_id               uuid REFERENCES public.listings_raw(id) ON DELETE CASCADE,
  source_id            bigint REFERENCES public.listing_sources(id) ON DELETE SET NULL,
  foreign_id           text,

  -- Mirrors the subset of listings columns the ingest endpoint already
  -- validates. INTEGER types match db-main-reference.
  title                text,
  description          text,
  property_category    text,
  property_type        text,
  sale_price           bigint,
  rent_price           integer,
  bedrooms             smallint,
  bathrooms            smallint,
  floor_area           smallint,
  lot_area             integer,
  parking_spaces       smallint,
  for_sale             boolean,
  for_rent             boolean,

  street_address       text,
  unit_number          text,
  normalized_address   text,
  -- Geocode hints — coarse for now; fine-grained geocoding lands later.
  geo_lat              double precision,
  geo_lng              double precision,

  -- Resolution targets — populated by the normalizer.
  resolved_city_id     smallint REFERENCES public.cities(id),
  resolved_barangay_id integer  REFERENCES public.barangays(id),
  resolved_property_id integer  REFERENCES public.properties(id),
  resolved_listing_id  integer  REFERENCES public.listings(id),

  -- Match-state machine. Drives the (future B-3.1) merge worker.
  match_status text NOT NULL DEFAULT 'pending'
    CHECK (match_status IN (
      'pending',                 -- not yet evaluated
      'matched_existing_listing', -- updates an existing listings row
      'matched_existing_property',-- creates a new listing under an existing property
      'new_property',             -- creates a new property + new listing
      'queued_for_review',        -- ambiguous; admin verdict required
      'rejected'                  -- validation failure
    )),
  match_notes text,

  ingested_at  timestamptz NOT NULL DEFAULT now(),
  matched_at   timestamptz
);

CREATE INDEX IF NOT EXISTS listings_normalized_pending_idx
  ON public.listings_normalized(ingested_at)
  WHERE match_status = 'pending';

CREATE INDEX IF NOT EXISTS listings_normalized_status_idx
  ON public.listings_normalized(match_status, ingested_at DESC);

COMMENT ON TABLE public.listings_normalized IS
  'Normalized form of listings_raw: resolved foreign keys, validated value ranges, normalized_address. match_status drives the eventual write into public.listings (B-3.1).';


-- =====================================================================
-- 4. RLS — admin-only writes; service-role bypasses for worker
-- =====================================================================

ALTER TABLE public.listings_raw         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings_normalized  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listings_raw_admin ON public.listings_raw;
CREATE POLICY listings_raw_admin ON public.listings_raw FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

DROP POLICY IF EXISTS listings_normalized_admin ON public.listings_normalized;
CREATE POLICY listings_normalized_admin ON public.listings_normalized FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 5. normalize_listings_raw_batch — the worker RPC
-- =====================================================================
-- Drains pending listings_raw → listings_normalized in batches. Pure
-- mapper for v1: copies the typed fields out of raw_json, attempts
-- to resolve city / barangay / property, sets match_status. Does
-- NOT yet write to listings — that's the B-3.1 follow-up.

CREATE OR REPLACE FUNCTION public.normalize_listings_raw_batch(p_max int DEFAULT 200)
RETURNS TABLE (
  processed int,
  normalized int,
  rejected int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_payload jsonb;
  v_city_id smallint;
  v_barangay_id integer;
  v_property_id integer;
  v_listing_id integer;
  v_normalized_id uuid;
  c_processed  int := 0;
  c_normalized int := 0;
  c_rejected   int := 0;
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: normalize worker is admin / cron only'
      USING ERRCODE = '42501';
  END IF;

  FOR v_row IN
    SELECT id, source_id, foreign_id, raw_json
      FROM public.listings_raw
     WHERE normalize_status = 'pending'
     ORDER BY ingested_at ASC
     LIMIT p_max
  LOOP
    c_processed := c_processed + 1;
    v_payload := v_row.raw_json;

    -- Minimal validation: must have a title.
    IF coalesce(length(trim(v_payload->>'title')), 0) < 1 THEN
      UPDATE public.listings_raw
         SET normalize_status = 'rejected',
             rejection_reason = 'missing title',
             normalized_at    = now()
       WHERE id = v_row.id;
      c_rejected := c_rejected + 1;
      CONTINUE;
    END IF;

    -- Best-effort city / barangay resolution from raw payload slugs.
    v_city_id := NULL;
    v_barangay_id := NULL;
    IF v_payload ? 'city_slug' THEN
      SELECT id INTO v_city_id FROM public.cities
       WHERE slug = v_payload->>'city_slug' LIMIT 1;
    ELSIF v_payload ? 'city_id' THEN
      SELECT id INTO v_city_id FROM public.cities
       WHERE id = (v_payload->>'city_id')::smallint LIMIT 1;
    END IF;
    IF v_city_id IS NOT NULL AND (v_payload ? 'barangay_slug') THEN
      SELECT id INTO v_barangay_id FROM public.barangays
       WHERE slug = v_payload->>'barangay_slug' AND city_id = v_city_id LIMIT 1;
    END IF;

    -- Match to an existing listing by (source_id, foreign_id).
    SELECT id INTO v_listing_id
      FROM public.listings
     WHERE source_id = v_row.source_id
       AND foreign_id = v_row.foreign_id
     LIMIT 1;

    -- Match by property pointer if the listing exists.
    v_property_id := NULL;
    IF v_listing_id IS NOT NULL THEN
      SELECT property_id INTO v_property_id
        FROM public.listings WHERE id = v_listing_id;
    END IF;

    INSERT INTO public.listings_normalized (
      raw_id, source_id, foreign_id,
      title, description, property_category, property_type,
      sale_price, rent_price,
      bedrooms, bathrooms, floor_area, lot_area, parking_spaces,
      for_sale, for_rent,
      street_address, unit_number,
      resolved_city_id, resolved_barangay_id,
      resolved_property_id, resolved_listing_id,
      match_status
    )
    VALUES (
      v_row.id, v_row.source_id, v_row.foreign_id,
      v_payload->>'title',
      v_payload->>'description',
      v_payload->>'property_category',
      v_payload->>'property_type',
      nullif(v_payload->>'sale_price','')::bigint,
      nullif(v_payload->>'rent_price','')::integer,
      nullif(v_payload->>'bedrooms','')::smallint,
      nullif(v_payload->>'bathrooms','')::smallint,
      nullif(v_payload->>'floor_area','')::smallint,
      nullif(v_payload->>'lot_area','')::integer,
      nullif(v_payload->>'parking_spaces','')::smallint,
      coalesce((v_payload->>'for_sale')::boolean, false),
      coalesce((v_payload->>'for_rent')::boolean, false),
      v_payload->>'street_address',
      v_payload->>'unit_number',
      v_city_id, v_barangay_id,
      v_property_id, v_listing_id,
      CASE
        WHEN v_listing_id IS NOT NULL  THEN 'matched_existing_listing'
        WHEN v_property_id IS NOT NULL THEN 'matched_existing_property'
        ELSE 'queued_for_review'
      END
    )
    RETURNING id INTO v_normalized_id;

    UPDATE public.listings_raw
       SET normalize_status = 'normalized',
           normalized_at    = now()
     WHERE id = v_row.id;

    c_normalized := c_normalized + 1;
  END LOOP;

  processed  := c_processed;
  normalized := c_normalized;
  rejected   := c_rejected;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION public.normalize_listings_raw_batch(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_listings_raw_batch(int)
  TO authenticated, service_role;


-- =====================================================================
-- 6. Governance
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
    ('public.listings_raw',                  'table',    'userportal', ARRAY['userportal'],
     'Verbatim partner payloads, raw_json + dedup hash. Idempotent on (source_id, foreign_id, raw_hash).', false),
    ('public.listings_normalized',           'table',    'userportal', ARRAY['userportal'],
     'Normalized form of listings_raw. match_status drives the eventual write into listings (B-3.1).', false),
    ('public.normalize_listings_raw_batch',  'function', 'userportal', ARRAY['userportal'],
     'Worker RPC. Drains pending listings_raw → listings_normalized in batches; does not write listings yet.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
--
-- 1) Shape.
-- SELECT count(*) AS raw, (SELECT count(*) FROM public.listings_normalized) AS normalized
--   FROM public.listings_raw;
--
-- 2) Insert a synthetic raw row resolved to an existing source.
-- INSERT INTO public.listings_raw (source_id, foreign_id, raw_json)
-- SELECT (SELECT id FROM public.listing_sources LIMIT 1),
--        'smoke-' || gen_random_uuid()::text,
--        jsonb_build_object(
--          'title', 'Smoke test listing',
--          'sale_price', 1000000,
--          'for_sale', true,
--          'city_slug', (SELECT slug FROM public.cities LIMIT 1)
--        );
--
-- 3) Run the worker.
-- SELECT * FROM public.normalize_listings_raw_batch(10);
--
-- 4) Inspect.
-- SELECT match_status, count(*)
--   FROM public.listings_normalized
--  WHERE ingested_at > now() - interval '5 minutes'
--  GROUP BY match_status;
