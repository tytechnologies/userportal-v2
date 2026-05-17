-- Schema Governance + Environment Consistency.
--
-- Read-only governance layer that registers cross-repo schema
-- contracts and detects drift between the registry and live
-- schema. ALL existing tables/views/policies are preserved.
--
-- Architecture:
--   governance_schema_contracts   -- one row per registered surface
--   governance_contract_columns   -- expected columns per contract
--   governance_materialized_views -- MV refresh tracking
--   governance_deprecated_columns -- sunset workflow
--   governance_drift_log          -- detection history
--
-- Helper functions for migrations to call (assertions) and for the
-- admin endpoint to call (drift check). All SECURITY DEFINER with
-- the session_user bypass for SQL editor smoke tests.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.governance_contract_health;
--   DROP VIEW IF EXISTS public.governance_drift_overview;
--   DROP FUNCTION IF EXISTS public.governance_check_all_contracts();
--   DROP FUNCTION IF EXISTS public.governance_check_contract(text);
--   DROP FUNCTION IF EXISTS public.governance_assert_column_type(text,text,text,text);
--   DROP FUNCTION IF EXISTS public.governance_assert_table_exists(text,text);
--   DROP FUNCTION IF EXISTS public.governance_record_mv_refresh_start(text);
--   DROP FUNCTION IF EXISTS public.governance_record_mv_refresh_end(text,text);
--   DROP FUNCTION IF EXISTS public.governance_register_drift(text,text,text,jsonb);
--   DROP TABLE IF EXISTS public.governance_drift_log;
--   DROP TABLE IF EXISTS public.governance_deprecated_columns;
--   DROP TABLE IF EXISTS public.governance_materialized_views;
--   DROP TABLE IF EXISTS public.governance_contract_columns;
--   DROP TABLE IF EXISTS public.governance_schema_contracts;

-- =====================================================================
-- 1. governance_schema_contracts — registered cross-repo surfaces
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.governance_schema_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Fully-qualified name: 'public.listing_details', 'public.trust_score'.
  -- UNIQUE so each surface registers once.
  contract_name   text NOT NULL UNIQUE,
  contract_type   text NOT NULL CHECK (contract_type IN
                       ('table', 'view', 'materialized_view', 'function', 'enum')),
  -- 'userportal' or 'website' — which repo's migrations own this
  -- surface. Both repos share one Supabase, but ownership of the
  -- DDL clarifies who reviews changes.
  owner_repo      text NOT NULL CHECK (owner_repo IN ('userportal', 'website', 'shared')),
  -- Array of consumer repos. ['userportal','website'] = both.
  consumers       text[] NOT NULL DEFAULT ARRAY['userportal']::text[],
  description     text,
  -- Anonymous-browser readable? Tightens what column changes are
  -- safe (public surfaces require dual-repo review).
  is_public       boolean NOT NULL DEFAULT false,
  -- NULL = active. Set when the contract is being phased out.
  deprecated_at   timestamptz,
  -- When the contract should actually be removed. UI surfaces a
  -- countdown for sunset planning.
  sunset_at       timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gov_contracts_active_idx
  ON public.governance_schema_contracts(contract_name) WHERE deprecated_at IS NULL;

DROP TRIGGER IF EXISTS set_governance_contracts_updated_at
  ON public.governance_schema_contracts;
CREATE TRIGGER set_governance_contracts_updated_at
  BEFORE UPDATE ON public.governance_schema_contracts
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.governance_schema_contracts IS
  'Registry of schema surfaces that act as cross-repo contracts. Each row pins a name + owner + consumers; column expectations live in governance_contract_columns. The drift checker validates registered contracts against the live information_schema.';


-- =====================================================================
-- 2. governance_contract_columns — expected columns per contract
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.governance_contract_columns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     uuid NOT NULL REFERENCES public.governance_schema_contracts(id) ON DELETE CASCADE,
  column_name     text NOT NULL,
  -- information_schema.columns.data_type token: 'uuid', 'bigint',
  -- 'text', 'timestamp with time zone', 'jsonb'. NULL = "any type
  -- accepted" (presence-only check).
  expected_type   text,
  required        boolean NOT NULL DEFAULT true,
  notes           text,
  UNIQUE (contract_id, column_name)
);

CREATE INDEX IF NOT EXISTS gov_contract_cols_idx
  ON public.governance_contract_columns(contract_id);


-- =====================================================================
-- 3. governance_materialized_views — MV refresh tracking
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.governance_materialized_views (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  view_name       text NOT NULL UNIQUE,
  -- Documentation only — not enforced. 'hourly', 'daily', 'on-demand',
  -- 'manual'. Future cron jobs read this when scheduling.
  refresh_cadence text NOT NULL DEFAULT 'manual',
  -- Tables/views this MV reads from. Documented for impact analysis
  -- when those upstreams change.
  depends_on      text[] NOT NULL DEFAULT '{}'::text[],
  last_refresh_started_at   timestamptz,
  last_refresh_completed_at timestamptz,
  -- bigint to absorb very long refreshes safely (24+ days max).
  last_refresh_duration_ms  bigint,
  last_refresh_error        text,
  consecutive_failures      int NOT NULL DEFAULT 0,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_gov_mvs_updated_at
  ON public.governance_materialized_views;
CREATE TRIGGER set_gov_mvs_updated_at
  BEFORE UPDATE ON public.governance_materialized_views
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 4. governance_deprecated_columns — sunset workflow
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.governance_deprecated_columns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name      text NOT NULL,            -- fully-qualified: 'public.listings'
  column_name     text NOT NULL,
  deprecated_at   timestamptz NOT NULL DEFAULT now(),
  sunset_at       timestamptz,              -- planned removal date
  replacement     text,                     -- e.g., 'use listings.created_by instead'
  notes           text,
  UNIQUE (table_name, column_name)
);

CREATE INDEX IF NOT EXISTS gov_deprecated_sunset_idx
  ON public.governance_deprecated_columns(sunset_at) WHERE sunset_at IS NOT NULL;


-- =====================================================================
-- 5. governance_drift_log — detection history
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.governance_drift_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_name   text NOT NULL,
  drift_type      text NOT NULL CHECK (drift_type IN (
                       'missing_table',
                       'missing_view',
                       'missing_column',
                       'type_mismatch',
                       'extra_column',
                       'mv_refresh_failure',
                       'manual_note'
                     )),
  severity        text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Resolved by an admin acknowledging? Allows the dashboard to
  -- separate "active drift" from "known/accepted exceptions" so
  -- pre-existing drift doesn't shout forever.
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  detected_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gov_drift_active_idx
  ON public.governance_drift_log(detected_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS gov_drift_contract_idx
  ON public.governance_drift_log(contract_name, detected_at DESC);

-- Daily prune at 03:35 — keeps drift_log bounded. Acknowledged
-- entries older than 90d are dropped; unacknowledged entries are
-- kept indefinitely (they're the active alert).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('governance_drift_log_prune')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'governance_drift_log_prune');
    PERFORM cron.schedule(
      'governance_drift_log_prune',
      '35 3 * * *',
      $cmd$
        DELETE FROM public.governance_drift_log
         WHERE acknowledged_at IS NOT NULL
           AND detected_at < now() - interval '90 days'
      $cmd$
    );
  END IF;
END $$;


-- =====================================================================
-- 6. RLS — admin-only across the board
-- =====================================================================

ALTER TABLE public.governance_schema_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gov_contracts_admin ON public.governance_schema_contracts;
CREATE POLICY gov_contracts_admin ON public.governance_schema_contracts FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

ALTER TABLE public.governance_contract_columns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gov_contract_cols_admin ON public.governance_contract_columns;
CREATE POLICY gov_contract_cols_admin ON public.governance_contract_columns FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

ALTER TABLE public.governance_materialized_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gov_mvs_admin ON public.governance_materialized_views;
CREATE POLICY gov_mvs_admin ON public.governance_materialized_views FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

ALTER TABLE public.governance_deprecated_columns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gov_deprecated_admin ON public.governance_deprecated_columns;
CREATE POLICY gov_deprecated_admin ON public.governance_deprecated_columns FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));

ALTER TABLE public.governance_drift_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gov_drift_admin ON public.governance_drift_log;
CREATE POLICY gov_drift_admin ON public.governance_drift_log FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- 7. Permission catalog entry
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('governance.read',  'Read schema governance registry and drift reports', 'governance'),
  ('governance.write', 'Modify schema governance registry',                  'governance')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'governance.read'),
  ('admin', 'governance.write')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 8. Migration assertion helpers
-- =====================================================================
--
-- Call from the top of a migration to fail-fast when an assumption
-- is wrong. Cheaper than discovering the mismatch mid-DDL and
-- rolling back a half-applied migration.

CREATE OR REPLACE FUNCTION public.governance_assert_table_exists(
  p_schema text,
  p_table  text
) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = p_schema AND table_name = p_table
  ) THEN
    RAISE EXCEPTION 'governance: expected table %.% does not exist', p_schema, p_table
      USING ERRCODE = '42P01';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.governance_assert_table_exists(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.governance_assert_column_type(
  p_schema        text,
  p_table         text,
  p_column        text,
  p_expected_type text  -- information_schema.columns.data_type token
) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_actual text;
BEGIN
  SELECT data_type INTO v_actual
    FROM information_schema.columns
   WHERE table_schema = p_schema AND table_name = p_table AND column_name = p_column;

  IF v_actual IS NULL THEN
    RAISE EXCEPTION 'governance: column %.%.% not found', p_schema, p_table, p_column
      USING ERRCODE = '42703';
  END IF;

  IF v_actual <> p_expected_type THEN
    RAISE EXCEPTION 'governance: %.%.% type drift — expected %, found %',
                    p_schema, p_table, p_column, p_expected_type, v_actual
      USING ERRCODE = '42804';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.governance_assert_column_type(text, text, text, text) TO authenticated;


-- =====================================================================
-- 9. Drift detection
-- =====================================================================

-- Validate one contract against information_schema. Returns one row
-- per drift finding (zero rows = healthy). Caller is admin-gated at
-- the endpoint; this function is SECURITY DEFINER so it can read
-- information_schema regardless of the caller's grants.
CREATE OR REPLACE FUNCTION public.governance_check_contract(
  p_contract_name text
) RETURNS TABLE (
  drift_type   text,
  severity     text,
  column_name  text,
  expected     text,
  actual       text,
  details      jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
DECLARE
  v_contract record;
  v_schema   text;
  v_object   text;
  v_kind     text;
  v_exists   boolean;
BEGIN
  -- Auth gate. session_user bypass per memory rule for SQL editor smoke tests.
  IF NOT (
    public.has_permission('governance.read')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: governance.read'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contract
    FROM public.governance_schema_contracts
   WHERE contract_name = p_contract_name AND deprecated_at IS NULL;

  IF v_contract IS NULL THEN
    RETURN;
  END IF;

  -- Split contract_name into schema + object.
  v_schema := split_part(v_contract.contract_name, '.', 1);
  v_object := split_part(v_contract.contract_name, '.', 2);
  v_kind   := v_contract.contract_type;

  -- Existence check by kind. information_schema.tables covers regular
  -- tables and views; matviews live in pg_matviews.
  IF v_kind IN ('table', 'view') THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = v_schema AND table_name = v_object
    ) INTO v_exists;
    IF NOT v_exists THEN
      drift_type  := CASE v_kind WHEN 'table' THEN 'missing_table' ELSE 'missing_view' END;
      severity    := 'critical';
      column_name := NULL;
      expected    := v_kind;
      actual      := 'absent';
      details     := jsonb_build_object('contract', p_contract_name);
      RETURN NEXT;
      RETURN;
    END IF;
  ELSIF v_kind = 'materialized_view' THEN
    SELECT EXISTS (
      SELECT 1 FROM pg_matviews
       WHERE schemaname = v_schema AND matviewname = v_object
    ) INTO v_exists;
    IF NOT v_exists THEN
      drift_type  := 'missing_view';
      severity    := 'critical';
      column_name := NULL;
      expected    := 'materialized_view';
      actual      := 'absent';
      details     := jsonb_build_object('contract', p_contract_name);
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    -- function/enum kinds not yet implemented; skip silently.
    RETURN;
  END IF;

  -- Per-column checks. information_schema.columns exposes view
  -- columns the same way as tables, so this works for tables, views,
  -- and matviews uniformly.
  RETURN QUERY
    WITH expected_cols AS (
      SELECT cc.column_name AS col, cc.expected_type AS exp_type, cc.required AS req
        FROM public.governance_contract_columns cc
       WHERE cc.contract_id = v_contract.id
    ),
    actual_cols AS (
      SELECT c.column_name AS col, c.data_type AS act_type
        FROM information_schema.columns c
       WHERE c.table_schema = v_schema AND c.table_name = v_object
    ),
    -- Required columns missing from actuals.
    missing AS (
      SELECT 'missing_column'::text AS dtype,
             'critical'::text       AS sev,
             e.col, e.exp_type::text, NULL::text AS act,
             jsonb_build_object('required', e.req) AS det
        FROM expected_cols e
        LEFT JOIN actual_cols a ON a.col = e.col
       WHERE a.col IS NULL AND e.req = true
    ),
    -- Type mismatches.
    mismatch AS (
      SELECT 'type_mismatch'::text   AS dtype,
             'warning'::text         AS sev,
             e.col, e.exp_type::text, a.act_type::text,
             jsonb_build_object('contract', p_contract_name) AS det
        FROM expected_cols e
        JOIN actual_cols   a ON a.col = e.col
       WHERE e.exp_type IS NOT NULL AND e.exp_type <> a.act_type
    )
    SELECT * FROM missing
    UNION ALL
    SELECT * FROM mismatch;
END;
$$;
GRANT EXECUTE ON FUNCTION public.governance_check_contract(text) TO authenticated;

-- Run all active contracts and return one summary row per contract.
-- Compact shape for the admin dashboard.
CREATE OR REPLACE FUNCTION public.governance_check_all_contracts()
RETURNS TABLE (
  contract_name   text,
  contract_type   text,
  owner_repo      text,
  status          text,             -- 'healthy' | 'drift' | 'missing'
  critical_count  int,
  warning_count   int,
  findings        jsonb             -- array of drift records
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
DECLARE
  v_contract record;
  v_findings jsonb;
  v_critical int;
  v_warning  int;
BEGIN
  IF NOT (
    public.has_permission('governance.read')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: governance.read'
      USING ERRCODE = '42501';
  END IF;

  FOR v_contract IN
    SELECT * FROM public.governance_schema_contracts
     WHERE deprecated_at IS NULL
     ORDER BY contract_name
  LOOP
    SELECT
      coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb),
      count(*) FILTER (WHERE d.severity = 'critical')::int,
      count(*) FILTER (WHERE d.severity = 'warning')::int
      INTO v_findings, v_critical, v_warning
      FROM public.governance_check_contract(v_contract.contract_name) d;

    contract_name  := v_contract.contract_name;
    contract_type  := v_contract.contract_type;
    owner_repo     := v_contract.owner_repo;
    critical_count := v_critical;
    warning_count  := v_warning;
    status         := CASE
                        WHEN v_critical > 0 THEN 'missing'
                        WHEN v_warning  > 0 THEN 'drift'
                        ELSE 'healthy'
                      END;
    findings       := v_findings;
    RETURN NEXT;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.governance_check_all_contracts() TO authenticated;


-- =====================================================================
-- 10. Drift log + MV refresh helpers
-- =====================================================================

CREATE OR REPLACE FUNCTION public.governance_register_drift(
  p_contract text,
  p_type     text,
  p_severity text,
  p_details  jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT (
    public.has_permission('governance.write')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: governance.write'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.governance_drift_log (contract_name, drift_type, severity, details)
  VALUES (p_contract, p_type, p_severity, coalesce(p_details, '{}'::jsonb))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.governance_register_drift(text, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.governance_record_mv_refresh_start(
  p_view text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.governance_materialized_views
     SET last_refresh_started_at = now()
   WHERE view_name = p_view;
  -- Silent no-op if the view isn't registered. Caller may not care.
END;
$$;
GRANT EXECUTE ON FUNCTION public.governance_record_mv_refresh_start(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.governance_record_mv_refresh_end(
  p_view  text,
  p_error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.governance_materialized_views
     SET last_refresh_completed_at = now(),
         last_refresh_duration_ms  = EXTRACT(EPOCH FROM (now() - last_refresh_started_at)) * 1000,
         last_refresh_error        = p_error,
         consecutive_failures      = CASE
                                       WHEN p_error IS NULL THEN 0
                                       ELSE consecutive_failures + 1
                                     END
   WHERE view_name = p_view;
END;
$$;
GRANT EXECUTE ON FUNCTION public.governance_record_mv_refresh_end(text, text) TO authenticated;


-- =====================================================================
-- 11. Convenience views for the dashboard
-- =====================================================================

CREATE OR REPLACE VIEW public.governance_drift_overview AS
SELECT
  count(*) FILTER (WHERE severity = 'critical' AND acknowledged_at IS NULL) AS active_critical,
  count(*) FILTER (WHERE severity = 'warning'  AND acknowledged_at IS NULL) AS active_warning,
  count(*) FILTER (WHERE severity = 'info'     AND acknowledged_at IS NULL) AS active_info,
  count(*) FILTER (WHERE acknowledged_at IS NOT NULL)                       AS acknowledged_count,
  max(detected_at) FILTER (WHERE acknowledged_at IS NULL)                   AS most_recent_drift_at
FROM public.governance_drift_log;
GRANT SELECT ON public.governance_drift_overview TO authenticated;

-- One-row-per-contract health snapshot. Materialized lazily on
-- query; admin dashboard reads it directly.
CREATE OR REPLACE VIEW public.governance_contract_health AS
SELECT
  c.contract_name,
  c.contract_type,
  c.owner_repo,
  c.is_public,
  c.deprecated_at,
  -- Latest unacknowledged drift for this contract, if any.
  (
    SELECT max(d.detected_at)
      FROM public.governance_drift_log d
     WHERE d.contract_name = c.contract_name
       AND d.acknowledged_at IS NULL
  ) AS last_drift_at,
  (
    SELECT count(*)::int
      FROM public.governance_drift_log d
     WHERE d.contract_name = c.contract_name
       AND d.acknowledged_at IS NULL
  ) AS active_drift_count
FROM public.governance_schema_contracts c
WHERE c.deprecated_at IS NULL;
GRANT SELECT ON public.governance_contract_health TO authenticated;


-- =====================================================================
-- 12. Seed the registry with known cross-repo contracts
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.listing_details',              'materialized_view', 'userportal', ARRAY['userportal','website'], 'Decorated listing read view; canonical source for both repos.', false),
  ('public.public_profiles',              'view',              'userportal', ARRAY['userportal','website'], 'Anon-readable agent profile projection (slug, name, avatar). Powers SEO + agent-card endpoints.', true),
  ('public.trust_score',                  'view',              'userportal', ARRAY['userportal','website'], 'Polymorphic reviews aggregate. Surfaces on listing/agent/building pages.', true),
  ('public.listing_market_status',        'view',              'userportal', ARRAY['userportal','website'], 'Live deal-state-derived availability for the Reserved/Sold badge.', true),
  ('public.organization_pipeline_summary','view',              'userportal', ARRAY['userportal'],           'Per-org × stage rollup for the manager dashboard.', false),
  ('public.branch_performance',           'view',              'userportal', ARRAY['userportal'],           'Per-branch performance aggregate.', false),
  ('public.broker_performance',           'view',              'userportal', ARRAY['userportal'],           'Per-agent performance aggregate.', false),
  ('public.ops_alerts',                   'view',              'userportal', ARRAY['userportal'],           'Operations-health alerts feed (admin only).', false),
  ('public.pipeline_alerts',              'view',              'userportal', ARRAY['userportal'],           'Workflow-automation alerts (operator-side).', false),
  ('public.notifications',                'table',             'userportal', ARRAY['userportal','website'], 'In-app notifications fan-out.', false),
  ('public.reviews',                      'table',             'userportal', ARRAY['userportal','website'], 'Polymorphic reviews. Website reads via /api/public/.../reviews; userportal mutates.', false)
ON CONFLICT (contract_name) DO NOTHING;

-- Seed expected columns for the most-load-bearing contracts. Each
-- column row pins (name, type) with type=NULL for "any" presence
-- check. Future PRs that touch a contract should update this list
-- as part of the diff.
DO $$
DECLARE
  c_id uuid;
BEGIN
  -- public_profiles
  SELECT id INTO c_id FROM public.governance_schema_contracts WHERE contract_name = 'public.public_profiles';
  IF c_id IS NOT NULL THEN
    INSERT INTO public.governance_contract_columns (contract_id, column_name, expected_type) VALUES
      (c_id, 'id',          'uuid'),
      (c_id, 'full_name',   'text'),
      (c_id, 'avatar_url',  'text'),
      (c_id, 'slug',        'text')
    ON CONFLICT DO NOTHING;
  END IF;

  -- trust_score
  SELECT id INTO c_id FROM public.governance_schema_contracts WHERE contract_name = 'public.trust_score';
  IF c_id IS NOT NULL THEN
    INSERT INTO public.governance_contract_columns (contract_id, column_name, expected_type) VALUES
      (c_id, 'target_type',     'text'),
      (c_id, 'target_id',       'text'),
      (c_id, 'review_count',    NULL),       -- numeric kind varies (bigint vs integer)
      (c_id, 'avg_rating',      NULL),
      (c_id, 'trust_score',     NULL),
      (c_id, 'verified',        'boolean')
    ON CONFLICT DO NOTHING;
  END IF;

  -- listing_market_status
  SELECT id INTO c_id FROM public.governance_schema_contracts WHERE contract_name = 'public.listing_market_status';
  IF c_id IS NOT NULL THEN
    INSERT INTO public.governance_contract_columns (contract_id, column_name, expected_type) VALUES
      (c_id, 'listing_id',     NULL),    -- listings.id type drifts; intentionally any
      (c_id, 'market_status',  'text')
    ON CONFLICT DO NOTHING;
  END IF;

  -- organization_pipeline_summary
  SELECT id INTO c_id FROM public.governance_schema_contracts WHERE contract_name = 'public.organization_pipeline_summary';
  IF c_id IS NOT NULL THEN
    INSERT INTO public.governance_contract_columns (contract_id, column_name, expected_type) VALUES
      (c_id, 'organization_id', 'uuid'),
      (c_id, 'stage_key',       'text'),
      (c_id, 'deal_count',      NULL),
      (c_id, 'won_count',       NULL),
      (c_id, 'lost_count',      NULL),
      (c_id, 'gmv_won',         NULL)
    ON CONFLICT DO NOTHING;
  END IF;

  -- broker_performance
  SELECT id INTO c_id FROM public.governance_schema_contracts WHERE contract_name = 'public.broker_performance';
  IF c_id IS NOT NULL THEN
    INSERT INTO public.governance_contract_columns (contract_id, column_name, expected_type) VALUES
      (c_id, 'organization_id',          'uuid'),
      (c_id, 'user_id',                  'uuid'),
      (c_id, 'org_role',                 'text'),
      (c_id, 'active_deal_count',        NULL),
      (c_id, 'deals_won_30d',            NULL),
      (c_id, 'inquiries_received_30d',   NULL),
      (c_id, 'inquiries_responded_30d',  NULL)
    ON CONFLICT DO NOTHING;
  END IF;

  -- branch_performance
  SELECT id INTO c_id FROM public.governance_schema_contracts WHERE contract_name = 'public.branch_performance';
  IF c_id IS NOT NULL THEN
    INSERT INTO public.governance_contract_columns (contract_id, column_name, expected_type) VALUES
      (c_id, 'branch_id',         'uuid'),
      (c_id, 'organization_id',   'uuid'),
      (c_id, 'branch_name',       'text'),
      (c_id, 'agent_count',       NULL),
      (c_id, 'active_deal_count', NULL)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Seed MV registry with the known one.
INSERT INTO public.governance_materialized_views
  (view_name, refresh_cadence, depends_on, notes)
VALUES
  ('public.listing_details', 'on-demand',
   ARRAY['public.listings','public.buildings','public.profiles','public.cities','public.barangays'],
   'Decorated listing MV. Refresh wired through refresh-listing-job cron + manual refresh endpoint.')
ON CONFLICT (view_name) DO NOTHING;

-- Seed deprecated_columns with the legacy quarantine columns.
INSERT INTO public.governance_deprecated_columns
  (table_name, column_name, deprecated_at, replacement, notes)
VALUES
  ('public.listings', 'created_by_legacy', now(), 'Use listings.created_by',
   'Quarantine column from migration 20260429000002. Not present on every environment (drift). Reconciled via legacy_creators_* RPCs.'),
  ('public.listings', 'updated_by_legacy', now(), 'Use listings.updated_by',
   'Quarantine column from migration 20260429000002. See legacy_creators_* RPCs.'),
  ('public.listings', 'deleted_by_legacy', now(), 'Use listings.deleted_by',
   'Quarantine column from migration 20260429000002. See legacy_creators_* RPCs.')
ON CONFLICT (table_name, column_name) DO NOTHING;

-- Seed drift_log with the known schema-drift items so the dashboard
-- shows them as "active drift" out of the box. Each is auto-
-- acknowledged because the project_schema_drift memory documents
-- the accepted handling.
INSERT INTO public.governance_drift_log
  (contract_name, drift_type, severity, details, acknowledged_at)
VALUES
  ('public.inquiries', 'type_mismatch', 'warning',
   jsonb_build_object('column', 'id',
                      'expected', 'uuid',
                      'observed', 'integer OR uuid',
                      'note', 'Drifts between environments. Endpoints accept both regex shapes; new FKs detect via information_schema.'),
   now()),
  ('public.cities', 'type_mismatch', 'warning',
   jsonb_build_object('column', 'id',
                      'expected', 'bigint',
                      'observed', 'bigint OR smallint',
                      'note', 'Drifts between mig 20260429000004 (bigint) and 20260501000002 (smallint). New FKs detect via information_schema.'),
   now())
ON CONFLICT DO NOTHING;


NOTIFY pgrst, 'reload schema';
