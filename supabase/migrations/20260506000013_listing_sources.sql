-- External source ingestion: registry + foreign-id mapping.
--
-- Foundation for importing listings from MLS feeds, partner brokers,
-- and scraped sources. Adds:
--   - listing_sources           — partner registry + per-source secret
--   - listings.source_id        — FK to listing_sources (NULL = agent)
--   - listings.foreign_id       — partner's id for this listing
--   - listings.source_observed_at — last time the source reported it
--   - partial UNIQUE (source_id, foreign_id) — idempotent upsert key
--
-- Compatibility: every existing agent-created row keeps NULL across
-- the three new columns. The partial unique index doesn't see them.
-- Public read paths, cluster RPC, search indexes, agent UX —
-- unchanged.
--
-- ROLLBACK:
--   ALTER TABLE public.listings
--     DROP COLUMN IF EXISTS source_observed_at,
--     DROP COLUMN IF EXISTS foreign_id,
--     DROP COLUMN IF EXISTS source_id;
--   DROP INDEX IF EXISTS public.listings_source_foreign_unique_idx;
--   DROP TABLE IF EXISTS public.listing_sources CASCADE;
--   DELETE FROM public.permissions
--     WHERE name IN ('sources.manage', 'sources.ingest');
--   NOTIFY pgrst, 'reload schema';
--
-- DEPENDS ON:
--   20260429000006_phase4_rbac_audit.sql (has_permission)
--   20260501000006_buildings_first_class.sql (buildings table)


-- =====================================================================
-- 1. listing_sources registry
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listing_sources (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug            text NOT NULL UNIQUE,        -- machine name (e.g. 'mls_xyz')
  display_name    text NOT NULL,
  base_url        text,                         -- partner site root (reference)
  enabled         boolean NOT NULL DEFAULT true,

  -- Per-source bearer secret. Constant-time-compared in the ingestion
  -- endpoint. Rotation: UPDATE ... SET ingest_secret = encode(gen_random_bytes(32), 'hex').
  ingest_secret   text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),

  last_ingested_at timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_listing_sources_updated_at ON public.listing_sources;
CREATE TRIGGER set_listing_sources_updated_at
  BEFORE UPDATE ON public.listing_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.listing_sources IS
  'Partner / MLS registry. Each row defines an external listing feed; ingest_secret authenticates that feed''s POSTs to /api/admin/listings/ingest. Admin-only writes; authenticated reads (managers may want to see what sources are active).';
COMMENT ON COLUMN public.listing_sources.ingest_secret IS
  'Per-source bearer secret. Sent as x-source-secret header. Constant-time-compared. Rotate with UPDATE ... SET ingest_secret = encode(gen_random_bytes(32), ''hex'').';


-- =====================================================================
-- 2. listings columns + partial unique
-- =====================================================================

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS source_id bigint
    REFERENCES public.listing_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS foreign_id text,
  ADD COLUMN IF NOT EXISTS source_observed_at timestamptz;

COMMENT ON COLUMN public.listings.source_id IS
  'NULL for agent-created listings. Non-null = imported from listing_sources.id. Coexists with created_by — agent rows have source_id NULL + created_by populated; source rows typically have source_id populated + created_by NULL.';
COMMENT ON COLUMN public.listings.foreign_id IS
  'Partner-side listing identifier. Combined with source_id, forms the upsert key for ingestion.';
COMMENT ON COLUMN public.listings.source_observed_at IS
  'Last time the source reported this listing. Future cron sweep can auto-archive rows where now() - source_observed_at > N days for a given source.';

-- Idempotent upsert key. Partial because legacy / agent rows have
-- both fields NULL — they don't collide and shouldn't be in the index.
CREATE UNIQUE INDEX IF NOT EXISTS listings_source_foreign_unique_idx
  ON public.listings(source_id, foreign_id)
  WHERE source_id IS NOT NULL AND foreign_id IS NOT NULL;


-- =====================================================================
-- 3. RLS on listing_sources
-- =====================================================================

ALTER TABLE public.listing_sources ENABLE ROW LEVEL SECURITY;

-- Authenticated users can SEE the registry (managers should know
-- which sources are enabled). Secret column readability is gated
-- by the SELECT-list at the API layer; admins read the secret to
-- bootstrap a source's bearer.
DROP POLICY IF EXISTS listing_sources_select_authenticated ON public.listing_sources;
CREATE POLICY listing_sources_select_authenticated
  ON public.listing_sources FOR SELECT
  TO authenticated
  USING (true);

-- INSERT / UPDATE / DELETE require sources.manage (admin-only by default).
DROP POLICY IF EXISTS listing_sources_insert_admin ON public.listing_sources;
CREATE POLICY listing_sources_insert_admin
  ON public.listing_sources FOR INSERT
  TO authenticated
  WITH CHECK (public.has_permission('sources.manage'));

DROP POLICY IF EXISTS listing_sources_update_admin ON public.listing_sources;
CREATE POLICY listing_sources_update_admin
  ON public.listing_sources FOR UPDATE
  TO authenticated
  USING (public.has_permission('sources.manage'))
  WITH CHECK (public.has_permission('sources.manage'));

DROP POLICY IF EXISTS listing_sources_delete_admin ON public.listing_sources;
CREATE POLICY listing_sources_delete_admin
  ON public.listing_sources FOR DELETE
  TO authenticated
  USING (public.has_permission('sources.manage'));


-- =====================================================================
-- 4. Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('sources.manage', 'Create / edit / disable external listing sources', 'admin'),
  ('sources.ingest', 'Trigger source ingestion via /api/admin/listings/ingest', 'admin')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'sources.manage'),
  ('admin',   'sources.ingest'),
  ('manager', 'sources.ingest')
ON CONFLICT DO NOTHING;


NOTIFY pgrst, 'reload schema';
