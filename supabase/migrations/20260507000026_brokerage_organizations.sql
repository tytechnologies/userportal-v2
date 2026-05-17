-- Brokerage Organizations layer.
--
-- Hierarchy: organization (brokerage) → branch → team (existing) → profile
--
-- Existing tables (`profiles.role`, `profiles.team_id`, `teams`,
-- `permissions`) are preserved; only ADD COLUMN IF NOT EXISTS and
-- new tables. System-wide RBAC (`profiles.role`) and org-scoped
-- roles (`organization_memberships.org_role`) are independent —
-- a system `admin` is unrelated to a `brokerage_owner`.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.broker_performance;
--   DROP VIEW IF EXISTS public.branch_performance;
--   DROP VIEW IF EXISTS public.organization_pipeline_summary;
--   DROP TABLE IF EXISTS public.organization_kpi_snapshots;
--   DROP TABLE IF EXISTS public.organization_kpi_targets;
--   DROP TABLE IF EXISTS public.profile_specializations;
--   DROP TABLE IF EXISTS public.organization_memberships;
--   ALTER TABLE public.teams DROP COLUMN IF EXISTS branch_id;
--   DROP TABLE IF EXISTS public.organization_branches;
--   DROP TABLE IF EXISTS public.organizations;


-- =====================================================================
-- 1. organizations — top-level brokerage entity
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  -- Future white-label hooks (deferred): logo_url, primary_color,
  -- custom_domain. Stored as jsonb so adding fields doesn't need a
  -- migration. Empty {} default — no branding by default.
  branding        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Brokerage owner — typically the founding broker. Distinct from
  -- system `admin` role (which is platform-level).
  owner_user_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Optional verified flag — admin sets when org provides licensing
  -- documentation. Surfaces as a badge on org pages.
  verified        boolean NOT NULL DEFAULT false,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organizations_owner_idx
  ON public.organizations(owner_user_id) WHERE owner_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_organizations_updated_at ON public.organizations;
CREATE TRIGGER set_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.organizations IS
  'Top-level brokerage entity. branding jsonb is the white-label hook (logo, theme, domain) — empty {} default leaves the org on the standard platform UI. Multi-org supported: an agent can be a member of multiple organizations via organization_memberships.';


-- =====================================================================
-- 2. organization_branches — regional offices within an org
-- =====================================================================

-- Detect actual cities.id type before adding the FK column.
-- Schema drift between bigint (20260429000004) and smallint
-- (20260501000002) means we can't hardcode the type. Build the
-- table with EXECUTE so the FK constraint resolves on either DB.
DO $$
DECLARE
  v_city_type text;
BEGIN
  SELECT data_type INTO v_city_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'cities'
     AND column_name = 'id';

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS public.organization_branches (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
      name            text NOT NULL,
      slug            text NOT NULL,
      address         text,
      manager_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      %s,
      active          boolean NOT NULL DEFAULT true,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, slug)
    )
    $f$,
    CASE
      WHEN v_city_type IN ('smallint','integer','bigint','uuid')
        THEN format('city_id %s REFERENCES public.cities(id) ON DELETE SET NULL', v_city_type)
      ELSE 'city_id text'  -- cities table not present yet; degrade to text
    END
  );
END $$;

CREATE INDEX IF NOT EXISTS organization_branches_org_idx
  ON public.organization_branches(organization_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS organization_branches_manager_idx
  ON public.organization_branches(manager_user_id) WHERE manager_user_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_organization_branches_updated_at ON public.organization_branches;
CREATE TRIGGER set_organization_branches_updated_at
  BEFORE UPDATE ON public.organization_branches
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 3. teams.branch_id — additive link from teams up to branch
-- =====================================================================
--
-- Existing teams keep their data; new column is nullable so legacy
-- teams stay branchless until an admin assigns them.

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.organization_branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS teams_branch_idx
  ON public.teams(branch_id) WHERE branch_id IS NOT NULL;


-- =====================================================================
-- 4. organization_memberships — user × org × role
-- =====================================================================
--
-- A user can be in multiple orgs (consultant relationships, multi-
-- brokerage agents). One row per (user, org, role) — same user can
-- hold multiple roles if needed (e.g., team_lead + senior_agent).
--
-- branch_id and team_id are optional refinements:
--   - branch_id NULL: org-wide membership (typical for brokerage
--     owners and floating agents)
--   - branch_id set, team_id NULL: branch-level membership
--   - both set: full hierarchy down to team

CREATE TABLE IF NOT EXISTS public.organization_memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  branch_id       uuid REFERENCES public.organization_branches(id) ON DELETE SET NULL,
  -- teams.id is uuid (not bigint) per 20260429000006_phase4_rbac_audit.
  team_id         uuid REFERENCES public.teams(id) ON DELETE SET NULL,

  org_role        text NOT NULL CHECK (org_role IN (
                       'brokerage_owner',
                       'branch_manager',
                       'team_lead',
                       'senior_agent',
                       'junior_agent',
                       'assistant'
                     )),

  -- Lifecycle: pending = invited but not accepted; active = full
  -- member; trial = probationary onboarding; suspended = paused
  -- without remove (e.g., leave of absence).
  status          text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'trial', 'suspended', 'removed')),

  -- Optional: when the trial/probation period ends.
  trial_ends_at   timestamptz,

  -- Onboarding checklist as a jsonb of completed steps. Open-ended
  -- so future steps can be added without migration.
  onboarding_completed jsonb NOT NULL DEFAULT '{}'::jsonb,

  invited_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  invited_at      timestamptz,
  joined_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- One (user, org, role) tuple at a time. Same user can re-occupy
  -- a role after suspension/removal by inserting a new row (UNIQUE
  -- doesn't include status — soft-deleted rows would need cleanup).
  UNIQUE (organization_id, user_id, org_role)
);

CREATE INDEX IF NOT EXISTS org_memberships_user_idx
  ON public.organization_memberships(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS org_memberships_org_idx
  ON public.organization_memberships(organization_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS org_memberships_branch_idx
  ON public.organization_memberships(branch_id) WHERE branch_id IS NOT NULL AND status = 'active';

DROP TRIGGER IF EXISTS set_org_memberships_updated_at ON public.organization_memberships;
CREATE TRIGGER set_org_memberships_updated_at
  BEFORE UPDATE ON public.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 5. profile_specializations — agent expertise tags
-- =====================================================================
--
-- (user_id × category × value). Categories are free-form strings;
-- v1 conventions:
--   segment      → 'luxury' | 'prime' | 'uptown' | 'central'
--   property_type → 'commercial' | 'residential' | 'land' | ...
--   city         → city name or city_id
--   building     → building id (specific-building specialist)
--   developer    → developer name

CREATE TABLE IF NOT EXISTS public.profile_specializations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category        text NOT NULL,
  value           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, category, value)
);

CREATE INDEX IF NOT EXISTS profile_specializations_user_idx
  ON public.profile_specializations(user_id);
CREATE INDEX IF NOT EXISTS profile_specializations_category_value_idx
  ON public.profile_specializations(category, value);


-- =====================================================================
-- 6. organization_kpi_targets — quotas per role per period
-- =====================================================================
--
-- (org, role, metric, period) → target_value. v1 metric_keys:
--   listings_created   — listings owned by user, period bounded
--   inquiries_responded — inquiries with status != 'new' (responded)
--   deals_closed       — closed_won deals
--   gmv_closed         — sum of deal_value on closed_won deals
--   response_sla_hours — median first-response time on inquiries
--
-- period: 'weekly' | 'monthly' | 'quarterly' | 'yearly'

CREATE TABLE IF NOT EXISTS public.organization_kpi_targets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  org_role        text NOT NULL,  -- subset of organization_memberships.org_role; not enforced here
  metric_key      text NOT NULL,
  period          text NOT NULL CHECK (period IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  target_value    numeric(14,2) NOT NULL,
  notes           text,
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, org_role, metric_key, period)
);

CREATE INDEX IF NOT EXISTS kpi_targets_org_idx
  ON public.organization_kpi_targets(organization_id);

DROP TRIGGER IF EXISTS set_kpi_targets_updated_at ON public.organization_kpi_targets;
CREATE TRIGGER set_kpi_targets_updated_at
  BEFORE UPDATE ON public.organization_kpi_targets
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 7. organization_kpi_snapshots — periodic actuals
-- =====================================================================
--
-- Captured by a future weekly cron. Stores actuals against targets
-- for trend analysis. v1 schema; cron implementation is its own
-- follow-up turn.

CREATE TABLE IF NOT EXISTS public.organization_kpi_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  branch_id       uuid REFERENCES public.organization_branches(id) ON DELETE SET NULL,
  metric_key      text NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  actual_value    numeric(14,2) NOT NULL,
  target_value    numeric(14,2),
  captured_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kpi_snapshots_org_period_idx
  ON public.organization_kpi_snapshots(organization_id, period_start DESC);
CREATE INDEX IF NOT EXISTS kpi_snapshots_user_period_idx
  ON public.organization_kpi_snapshots(user_id, period_start DESC) WHERE user_id IS NOT NULL;


-- =====================================================================
-- 8. RLS — gates each table to org members + admin
-- =====================================================================
--
-- Helper: deal_can_read pattern. is_org_member(org_id) check used
-- across all org-scoped tables.

CREATE OR REPLACE FUNCTION public.is_org_member(p_org_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT
    public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.organization_id = p_org_id
         AND m.user_id = auth.uid()
         AND m.status IN ('active', 'trial')
    );
$$;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_org_manager(p_org_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT
    public.has_permission('admin.access')
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.organization_id = p_org_id
         AND m.user_id = auth.uid()
         AND m.status = 'active'
         AND m.org_role IN ('brokerage_owner', 'branch_manager', 'team_lead')
    );
$$;
GRANT EXECUTE ON FUNCTION public.is_org_manager(uuid) TO authenticated;


-- organizations: members read; only owners + admin write
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_select ON public.organizations;
CREATE POLICY organizations_select ON public.organizations FOR SELECT
  TO authenticated USING (public.is_org_member(id));
DROP POLICY IF EXISTS organizations_update ON public.organizations;
CREATE POLICY organizations_update ON public.organizations FOR UPDATE
  TO authenticated
  USING (public.has_permission('admin.access') OR owner_user_id = auth.uid())
  WITH CHECK (public.has_permission('admin.access') OR owner_user_id = auth.uid());
-- INSERT/DELETE restricted to admin via service-role; no policy.

-- branches: same — org members read, managers write
ALTER TABLE public.organization_branches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_branches_select ON public.organization_branches;
CREATE POLICY organization_branches_select ON public.organization_branches FOR SELECT
  TO authenticated USING (public.is_org_member(organization_id));
DROP POLICY IF EXISTS organization_branches_modify ON public.organization_branches;
CREATE POLICY organization_branches_modify ON public.organization_branches FOR ALL
  TO authenticated
  USING (public.is_org_manager(organization_id))
  WITH CHECK (public.is_org_manager(organization_id));

-- memberships: org members see all rows in their org; managers write
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_memberships_select ON public.organization_memberships;
CREATE POLICY org_memberships_select ON public.organization_memberships FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()  -- always see your own row
    OR public.is_org_member(organization_id)
  );
DROP POLICY IF EXISTS org_memberships_insert ON public.organization_memberships;
CREATE POLICY org_memberships_insert ON public.organization_memberships FOR INSERT
  TO authenticated
  WITH CHECK (public.is_org_manager(organization_id));
DROP POLICY IF EXISTS org_memberships_update ON public.organization_memberships;
CREATE POLICY org_memberships_update ON public.organization_memberships FOR UPDATE
  TO authenticated
  USING (
    -- Member updating their own onboarding state OR a manager
    -- changing role/status
    (user_id = auth.uid() AND status IN ('pending', 'trial'))
    OR public.is_org_manager(organization_id)
  )
  WITH CHECK (
    (user_id = auth.uid() AND status IN ('pending', 'trial', 'active'))
    OR public.is_org_manager(organization_id)
  );

-- specializations: own row + readable to other org members for
-- search/recommendations
ALTER TABLE public.profile_specializations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profile_specializations_select ON public.profile_specializations;
CREATE POLICY profile_specializations_select ON public.profile_specializations FOR SELECT
  TO authenticated USING (true);  -- read by any authenticated user
DROP POLICY IF EXISTS profile_specializations_insert ON public.profile_specializations;
CREATE POLICY profile_specializations_insert ON public.profile_specializations FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_permission('admin.access'));
DROP POLICY IF EXISTS profile_specializations_delete ON public.profile_specializations;
CREATE POLICY profile_specializations_delete ON public.profile_specializations FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() OR public.has_permission('admin.access'));

-- KPI targets: org managers write, members read
ALTER TABLE public.organization_kpi_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kpi_targets_select ON public.organization_kpi_targets;
CREATE POLICY kpi_targets_select ON public.organization_kpi_targets FOR SELECT
  TO authenticated USING (public.is_org_member(organization_id));
DROP POLICY IF EXISTS kpi_targets_modify ON public.organization_kpi_targets;
CREATE POLICY kpi_targets_modify ON public.organization_kpi_targets FOR ALL
  TO authenticated
  USING (public.is_org_manager(organization_id))
  WITH CHECK (public.is_org_manager(organization_id));

-- KPI snapshots: members read their own, managers read all in org
ALTER TABLE public.organization_kpi_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kpi_snapshots_select ON public.organization_kpi_snapshots;
CREATE POLICY kpi_snapshots_select ON public.organization_kpi_snapshots FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_org_manager(organization_id)
  );
-- INSERT: service-role only (KPI cron writes them).


-- =====================================================================
-- 9. Permissions catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('org.read.own',     'Read own organization data',                     'organizations'),
  ('org.manage.own',   'Manage own organization (branches, settings)',  'organizations'),
  ('org.kpi.set',      'Set KPI targets within an organization',         'organizations'),
  ('org.member.invite','Invite and manage members within an organization','organizations')
ON CONFLICT (name) DO NOTHING;

-- All baseline roles get org.read.own (the policies further gate by
-- actual org membership). Manager + admin get the broader rights.
INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'org.read.own'),
  ('admin',   'org.manage.own'),
  ('admin',   'org.kpi.set'),
  ('admin',   'org.member.invite'),
  ('manager', 'org.read.own'),
  ('manager', 'org.manage.own'),
  ('manager', 'org.kpi.set'),
  ('manager', 'org.member.invite'),
  ('agent',   'org.read.own')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 10. Aggregate views — org pipeline + branch + broker performance
-- =====================================================================

-- organization_pipeline_summary: per-org × stage counts + GMV
CREATE OR REPLACE VIEW public.organization_pipeline_summary AS
SELECT
  m.organization_id,
  d.stage_key,
  count(DISTINCT d.id)                                AS deal_count,
  count(DISTINCT d.id) FILTER (WHERE d.closed_won = true)  AS won_count,
  count(DISTINCT d.id) FILTER (WHERE d.closed_won = false) AS lost_count,
  sum(d.deal_value) FILTER (WHERE d.closed_won = true)     AS gmv_won
FROM public.deals d
JOIN public.organization_memberships m
  ON m.user_id = d.buyer_agent_user_id
 AND m.status = 'active'
GROUP BY m.organization_id, d.stage_key;
GRANT SELECT ON public.organization_pipeline_summary TO authenticated;

COMMENT ON VIEW public.organization_pipeline_summary IS
  'Per-org × stage rollup of deals where any active member is the buyer_agent. Powers the manager dashboard pipeline overview.';


-- branch_performance: per-branch agent count, active deals, 30d closings
CREATE OR REPLACE VIEW public.branch_performance AS
SELECT
  b.id AS branch_id,
  b.organization_id,
  b.name AS branch_name,
  count(DISTINCT m.user_id) FILTER (WHERE m.status = 'active') AS agent_count,
  count(DISTINCT d.id) FILTER (
    WHERE d.closed_at IS NULL
      AND d.stage_key NOT IN ('closed_won', 'closed_lost')
  ) AS active_deal_count,
  count(DISTINCT d.id) FILTER (
    WHERE d.closed_won = true AND d.closed_at > now() - interval '30 days'
  ) AS deals_closed_30d,
  sum(d.deal_value) FILTER (
    WHERE d.closed_won = true AND d.closed_at > now() - interval '30 days'
  ) AS gmv_30d
FROM public.organization_branches b
LEFT JOIN public.organization_memberships m
  ON m.branch_id = b.id
LEFT JOIN public.deals d
  ON d.buyer_agent_user_id = m.user_id
GROUP BY b.id, b.organization_id, b.name;
GRANT SELECT ON public.branch_performance TO authenticated;


-- broker_performance: per-agent pipeline depth + 30d activity
CREATE OR REPLACE VIEW public.broker_performance AS
SELECT
  m.organization_id,
  m.branch_id,
  m.user_id,
  m.org_role,
  count(DISTINCT d.id) FILTER (
    WHERE d.closed_at IS NULL
      AND d.stage_key NOT IN ('closed_won', 'closed_lost')
  ) AS active_deal_count,
  count(DISTINCT d.id) FILTER (
    WHERE d.closed_won = true AND d.closed_at > now() - interval '30 days'
  ) AS deals_won_30d,
  sum(d.deal_value) FILTER (
    WHERE d.closed_won = true AND d.closed_at > now() - interval '90 days'
  ) AS gmv_90d,
  count(DISTINCT i.id) FILTER (
    WHERE i.created_at > now() - interval '30 days'
  ) AS inquiries_received_30d,
  count(DISTINCT i.id) FILTER (
    WHERE i.created_at > now() - interval '30 days'
      AND i.status != 'new'
  ) AS inquiries_responded_30d
FROM public.organization_memberships m
LEFT JOIN public.deals d
  ON d.buyer_agent_user_id = m.user_id
LEFT JOIN public.inquiries i
  ON i.assigned_user_id = m.user_id
WHERE m.status = 'active'
GROUP BY m.organization_id, m.branch_id, m.user_id, m.org_role;
GRANT SELECT ON public.broker_performance TO authenticated;


NOTIFY pgrst, 'reload schema';
