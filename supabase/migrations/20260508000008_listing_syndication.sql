-- Listing syndication outbound.
--
-- New domain — addresses the audit's "MISSING: listing syndication
-- outbound" entry. Lets HHI push our listings to external portals
-- (Lamudi, Property24-style PH portals, MLS partners, OLX) via
-- configurable feeds. Two delivery modes:
--
--   pull — external system polls our public /syndication/<slug>.json
--          endpoint on its own cadence. Operator never has to push.
--   push — we POST/PUT serialized listings to the partner's endpoint
--          on a registered cron. (Push wiring deferred to phase B;
--          schema supports it now.)
--
-- Three additive tables:
--   listing_syndication_targets   — per-portal configuration
--   listing_syndication_overrides — per-listing force-include / -exclude
--   listing_syndication_runs      — append-only audit
--
-- Existing surfaces preserved:
--   - listings (read-only consumption)
--   - has_permission, audit, governance (unchanged)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.listing_syndication_runs;
--   DROP TABLE IF EXISTS public.listing_syndication_overrides;
--   DROP TABLE IF EXISTS public.listing_syndication_targets;
--   DELETE FROM public.role_permissions WHERE permission = 'syndication.manage';
--   DELETE FROM public.permissions WHERE name = 'syndication.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.listing_syndication_targets',
--      'public.listing_syndication_overrides',
--      'public.listing_syndication_runs');


-- =====================================================================
-- 0. Hard preconditions
-- =====================================================================

DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listings') THEN
    v_missing := v_missing || 'public.listings';
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 20260508000008 requires tables: %.', array_to_string(v_missing, ', ');
  END IF;
END $$;


-- =====================================================================
-- 1. listing_syndication_targets — per-portal config
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listing_syndication_targets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Operator-facing slug. Doubles as the public feed path:
  -- /syndication/<slug>.json (and future /syndication/<slug>.xml).
  slug                     text NOT NULL UNIQUE
                                CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  display_name             text NOT NULL,

  -- Documented values. JSON is the only serializer wired in phase A;
  -- XML / CSV / RSS land in phase B without a migration (the column
  -- is already string-shaped to permit it).
  feed_format              text NOT NULL DEFAULT 'json'
                                CHECK (feed_format IN ('json', 'xml', 'csv', 'rss')),

  -- Delivery mode:
  --   pull — anonymous external systems poll the public feed URL
  --   push — we POST/PUT to push_endpoint_url on a cron
  delivery_mode            text NOT NULL DEFAULT 'pull'
                                CHECK (delivery_mode IN ('pull', 'push')),

  -- For push targets only.
  push_endpoint_url        text,
  push_auth_kind           text CHECK (push_auth_kind IS NULL
                                       OR push_auth_kind IN
                                         ('none', 'bearer', 'hmac', 'basic')),
  -- Auth secret(s) live in the Supabase Vault under a key derived from
  -- this row's id; see runtime helper. NEVER store secrets here.
  push_secret_vault_key    text,

  -- Server-side filters applied to the eligible listing set. Documented
  -- shape (additive over time):
  --   {
  --     "property_type":  "condo" | string[],
  --     "city_id":        bigint | bigint[],
  --     "min_sale_price": numeric, "max_sale_price": numeric,
  --     "min_rent_price": numeric, "max_rent_price": numeric,
  --     "status":         "active" | string[]   (defaults to active-only)
  --   }
  include_filters          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Per-run cap to keep feed size bounded.
  max_listings_per_run     int NOT NULL DEFAULT 1000
                                CHECK (max_listings_per_run BETWEEN 1 AND 50000),

  -- pg_cron expression for scheduled push runs. NULL = pull-only or
  -- manual-only push.
  refresh_cron             text,

  -- Lifecycle.
  status                   text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'paused', 'archived')),

  -- Bookkeeping (denormalised from runs for fast read on the targets list).
  last_run_at              timestamptz,
  last_run_listings        int,
  last_run_status          text,

  notes                    text,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Push targets must specify the endpoint.
  CHECK (delivery_mode = 'pull' OR push_endpoint_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS listing_syndication_targets_status_idx
  ON public.listing_syndication_targets(status);

DROP TRIGGER IF EXISTS set_listing_syndication_targets_updated_at
  ON public.listing_syndication_targets;
CREATE TRIGGER set_listing_syndication_targets_updated_at
  BEFORE UPDATE ON public.listing_syndication_targets
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.listing_syndication_targets IS
  'Per-portal outbound listing syndication config. Pull (anonymous /syndication/<slug>) or push (we POST to a partner URL on a cron).';


-- =====================================================================
-- 2. listing_syndication_overrides — per-listing force-in/out
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listing_syndication_overrides (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  target_id                uuid NOT NULL REFERENCES public.listing_syndication_targets(id)
                                ON DELETE CASCADE,
  listing_id               bigint NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,

  -- 'force_include' beats target filters; 'force_exclude' beats
  -- target filters AND any force_include from another op.
  override_kind            text NOT NULL CHECK (override_kind IN
                              ('force_include', 'force_exclude')),

  reason                   text,

  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),

  -- One override per (target, listing).
  UNIQUE (target_id, listing_id)
);

CREATE INDEX IF NOT EXISTS listing_syndication_overrides_target_idx
  ON public.listing_syndication_overrides(target_id, override_kind);


-- =====================================================================
-- 3. listing_syndication_runs — append-only audit
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.listing_syndication_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  target_id                uuid NOT NULL REFERENCES public.listing_syndication_targets(id)
                                ON DELETE CASCADE,
  triggered_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Documented values.
  --   cron — scheduled push run
  --   manual — admin POST /run-now
  --   pull — external system fetched our public feed
  run_kind                 text NOT NULL CHECK (run_kind IN ('cron', 'manual', 'pull')),

  started_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz,

  listings_included        int NOT NULL DEFAULT 0,
  listings_excluded        int NOT NULL DEFAULT 0,
  bytes_emitted            bigint,

  status                   text NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running', 'completed', 'failed')),
  errors                   jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- For push runs only.
  push_response_status     int,
  push_response_body_excerpt text,

  -- For pull runs: who fetched (IP / user-agent / signed-token claim).
  pull_origin              jsonb,

  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS listing_syndication_runs_target_idx
  ON public.listing_syndication_runs(target_id, started_at DESC);
CREATE INDEX IF NOT EXISTS listing_syndication_runs_status_idx
  ON public.listing_syndication_runs(status, started_at DESC)
  WHERE status IN ('running', 'failed');


-- =====================================================================
-- 4. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('syndication.manage',
   'Manage listing syndication targets and trigger feed runs',
   'platform')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'syndication.manage'),
  ('manager', 'syndication.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5. RLS
-- =====================================================================

ALTER TABLE public.listing_syndication_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_syndication_targets_select
  ON public.listing_syndication_targets;
CREATE POLICY listing_syndication_targets_select
  ON public.listing_syndication_targets FOR SELECT
  TO authenticated
  USING (
    public.has_permission('syndication.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS listing_syndication_targets_modify
  ON public.listing_syndication_targets;
CREATE POLICY listing_syndication_targets_modify
  ON public.listing_syndication_targets FOR ALL
  TO authenticated
  USING (
    public.has_permission('syndication.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('syndication.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.listing_syndication_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_syndication_overrides_modify
  ON public.listing_syndication_overrides;
CREATE POLICY listing_syndication_overrides_modify
  ON public.listing_syndication_overrides FOR ALL
  TO authenticated
  USING (
    public.has_permission('syndication.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('syndication.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.listing_syndication_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_syndication_runs_select
  ON public.listing_syndication_runs;
CREATE POLICY listing_syndication_runs_select
  ON public.listing_syndication_runs FOR SELECT
  TO authenticated
  USING (
    public.has_permission('syndication.manage')
    OR public.has_permission('admin.access')
  );

-- Writes happen via service-role from the feed generator; no direct
-- DML from authenticated users.


-- =====================================================================
-- 6. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.listing_syndication_targets', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Outbound listing syndication target config', false),
  ('public.listing_syndication_overrides', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Per-listing force-include / -exclude on a syndication target', false),
  ('public.listing_syndication_runs', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Append-only audit of syndication feed runs (cron / manual / pull)', false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
