-- Plans + Entitlements (gating only — no billing).
--
-- B4 of the post-audit roadmap. Adds a plan-tier layer above RBAC so
-- features (envelopes.send, market_intel.read, listing capacity,
-- webhook count, ...) can be gated by org subscription. NO money
-- moves at this layer — billing is B6.
--
-- Existing surfaces preserved:
--   - permissions / role_permissions  — kept; unchanged.
--   - organization_memberships        — kept; unchanged.
--   - has_permission()                — kept; unchanged.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS organizations_assign_default_plan ON public.organizations;
--   DROP FUNCTION IF EXISTS public.assign_default_plan_fn();
--   DROP FUNCTION IF EXISTS public.org_feature_limit(uuid, text);
--   DROP FUNCTION IF EXISTS public.org_has_feature(uuid, text);
--   DROP VIEW IF EXISTS public.organization_entitlements;
--   DROP TABLE IF EXISTS public.organization_subscriptions;
--   DROP TABLE IF EXISTS public.plan_features;
--   DROP TABLE IF EXISTS public.plans;
--   DELETE FROM public.role_permissions WHERE permission = 'plans.manage';
--   DELETE FROM public.permissions WHERE name = 'plans.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.plans',
--      'public.plan_features',
--      'public.organization_subscriptions',
--      'public.organization_entitlements');


-- =====================================================================
-- 1. plans — the catalog
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable string handle ('free', 'starter', 'professional',
  -- 'enterprise', 'mls_partner'). Application code references plans
  -- by code, not uuid.
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  description     text,

  -- Display / sort order; lower tier is cheaper.
  tier            int  NOT NULL DEFAULT 0,

  is_public       boolean NOT NULL DEFAULT true,
  is_default      boolean NOT NULL DEFAULT false,

  -- 'active' = available for assignment.
  -- 'deprecated' = existing subscriptions retain it; no new ones.
  status          text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'deprecated')),

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Single default at any time.
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_default
  ON public.plans(is_default) WHERE is_default = true;

DROP TRIGGER IF EXISTS set_plans_updated_at ON public.plans;
CREATE TRIGGER set_plans_updated_at
  BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.plans IS
  'Plan catalog. code is the stable handle. is_default marks the plan auto-assigned to new orgs (single default enforced via partial unique index).';


-- =====================================================================
-- 2. plan_features — per-plan grants
-- =====================================================================
--
-- One row per (plan, feature_key). Two complementary expression modes:
--   - enabled boolean         — for binary features
--   - limit_value bigint      — for quota features (NULL = unlimited)
--                               limit_unit gives the display dimension
-- An entry can populate both when the feature is "enabled with a cap".
-- The application TS catalog interprets the row.

CREATE TABLE IF NOT EXISTS public.plan_features (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,

  -- snake-dot-namespace key. Examples:
  --   listings.active.max
  --   webhooks.subscriptions.max
  --   envelopes.send.monthly
  --   envelopes.send (boolean)
  --   market_intel.read (boolean)
  --   commissions.ledger.write (boolean)
  --   governance.drift_dashboard (boolean)
  feature_key     text NOT NULL CHECK (feature_key ~ '^[a-z][a-z0-9_.]+$'),

  enabled         boolean NOT NULL DEFAULT true,
  -- NULL = unlimited (when enabled). Otherwise a hard cap.
  limit_value     bigint  CHECK (limit_value IS NULL OR limit_value >= 0),
  limit_unit      text,
  metadata        jsonb   NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (plan_id, feature_key)
);

CREATE INDEX IF NOT EXISTS plan_features_plan_idx
  ON public.plan_features(plan_id);

DROP TRIGGER IF EXISTS set_plan_features_updated_at ON public.plan_features;
CREATE TRIGGER set_plan_features_updated_at
  BEFORE UPDATE ON public.plan_features
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 3. organization_subscriptions — org → plan binding + lifecycle
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.organization_subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: deleting a plan with extant subscriptions
  -- requires admin to migrate them off first.
  plan_id             uuid NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,

  status              text NOT NULL DEFAULT 'active'
                           CHECK (status IN
                             ('active', 'trialing', 'past_due',
                              'cancelled', 'suspended')),

  effective_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  trial_end_at        timestamptz,

  -- Provenance for manual grants. granted_reason examples:
  -- 'auto_default', 'comp', 'beta_launch', 'manual_admin',
  -- 'paid_via_stripe' (once B6 lands).
  granted_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  granted_reason      text,

  cancelled_at        timestamptz,
  cancel_reason       text,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (expires_at IS NULL OR expires_at > effective_at),
  CHECK (trial_end_at IS NULL OR status = 'trialing' OR trial_end_at <= effective_at)
);

-- One active/effective subscription per org. Cancelled / suspended
-- ones can coexist as history.
CREATE UNIQUE INDEX IF NOT EXISTS organization_subscriptions_one_current
  ON public.organization_subscriptions(organization_id)
  WHERE status IN ('active', 'trialing', 'past_due');

CREATE INDEX IF NOT EXISTS organization_subscriptions_org_idx
  ON public.organization_subscriptions(organization_id, status);
CREATE INDEX IF NOT EXISTS organization_subscriptions_plan_idx
  ON public.organization_subscriptions(plan_id, status);

DROP TRIGGER IF EXISTS set_organization_subscriptions_updated_at ON public.organization_subscriptions;
CREATE TRIGGER set_organization_subscriptions_updated_at
  BEFORE UPDATE ON public.organization_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 4. organization_entitlements view — flat lookup
-- =====================================================================
--
-- One row per (organization_id, feature_key). Composes the org's
-- current subscription with its plan's features. Time-bound: only
-- active/trialing/past_due subscriptions and only within their
-- effective_at..expires_at window.

CREATE OR REPLACE VIEW public.organization_entitlements AS
  SELECT
    os.organization_id,
    pf.feature_key,
    pf.enabled,
    pf.limit_value,
    pf.limit_unit,
    pf.metadata    AS feature_metadata,
    p.code         AS plan_code,
    p.tier         AS plan_tier,
    os.status      AS subscription_status,
    os.effective_at,
    os.expires_at
  FROM public.organization_subscriptions os
  JOIN public.plans          p  ON p.id  = os.plan_id
  JOIN public.plan_features  pf ON pf.plan_id = p.id
  WHERE os.status IN ('active', 'trialing', 'past_due')
    AND os.effective_at <= now()
    AND (os.expires_at IS NULL OR os.expires_at > now());

GRANT SELECT ON public.organization_entitlements TO authenticated;


-- =====================================================================
-- 5. RPCs — feature lookup (fail-closed)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.org_has_feature(
  p_org_id     uuid,
  p_feature_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((
    SELECT enabled
      FROM public.organization_entitlements
     WHERE organization_id = p_org_id
       AND feature_key = p_feature_key
     LIMIT 1
  ), false);
$$;

GRANT EXECUTE ON FUNCTION public.org_has_feature(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.org_feature_limit(
  p_org_id     uuid,
  p_feature_key text
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT limit_value
    FROM public.organization_entitlements
   WHERE organization_id = p_org_id
     AND feature_key = p_feature_key
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.org_feature_limit(uuid, text) TO authenticated;


-- =====================================================================
-- 6. assign_default_plan trigger — auto-subscribe new orgs
-- =====================================================================

CREATE OR REPLACE FUNCTION public.assign_default_plan_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_default_plan_id uuid;
BEGIN
  -- Skip if the org already has an active subscription (idempotent
  -- backfill safety).
  IF EXISTS (
    SELECT 1 FROM public.organization_subscriptions
     WHERE organization_id = NEW.id
       AND status IN ('active', 'trialing', 'past_due')
  ) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_default_plan_id
    FROM public.plans
   WHERE is_default = true AND status = 'active'
   LIMIT 1;
  IF v_default_plan_id IS NULL THEN
    RETURN NEW;  -- No default seeded yet — caller fills in later.
  END IF;

  INSERT INTO public.organization_subscriptions
    (organization_id, plan_id, status, effective_at,
     granted_by, granted_reason)
  VALUES
    (NEW.id, v_default_plan_id, 'active', now(),
     NEW.owner_user_id, 'auto_default');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_assign_default_plan ON public.organizations;
CREATE TRIGGER organizations_assign_default_plan
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.assign_default_plan_fn();


-- =====================================================================
-- 7. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('plans.manage', 'Create and edit plans, plan_features, and assign org subscriptions', 'platform')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'plans.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 8. RLS
-- =====================================================================

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_select ON public.plans;
CREATE POLICY plans_select ON public.plans FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS plans_modify ON public.plans;
CREATE POLICY plans_modify ON public.plans FOR ALL
  TO authenticated
  USING (public.has_permission('plans.manage'))
  WITH CHECK (public.has_permission('plans.manage'));


ALTER TABLE public.plan_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_features_select ON public.plan_features;
CREATE POLICY plan_features_select ON public.plan_features FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS plan_features_modify ON public.plan_features;
CREATE POLICY plan_features_modify ON public.plan_features FOR ALL
  TO authenticated
  USING (public.has_permission('plans.manage'))
  WITH CHECK (public.has_permission('plans.manage'));


ALTER TABLE public.organization_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_subscriptions_select ON public.organization_subscriptions;
CREATE POLICY organization_subscriptions_select ON public.organization_subscriptions FOR SELECT
  TO authenticated
  USING (
    public.has_permission('plans.manage')
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
       WHERE om.organization_id = organization_id
         AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS organization_subscriptions_modify ON public.organization_subscriptions;
CREATE POLICY organization_subscriptions_modify ON public.organization_subscriptions FOR ALL
  TO authenticated
  USING (public.has_permission('plans.manage'))
  WITH CHECK (public.has_permission('plans.manage'));


-- =====================================================================
-- 9. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.plans',                       'table', 'userportal',
   ARRAY['userportal']::text[], 'Plan catalog',                        false),
  ('public.plan_features',               'table', 'userportal',
   ARRAY['userportal']::text[], 'Per-plan feature grants',             false),
  ('public.organization_subscriptions',  'table', 'userportal',
   ARRAY['userportal']::text[], 'Org -> plan with lifecycle',          false),
  ('public.organization_entitlements',   'view',  'userportal',
   ARRAY['userportal']::text[], 'Effective entitlements per org',      false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- 10. Seed default plans + features
-- =====================================================================

DO $$
DECLARE
  v_free_id     uuid;
  v_starter_id  uuid;
  v_pro_id      uuid;
  v_ent_id      uuid;
BEGIN
  -- Free
  INSERT INTO public.plans (code, name, description, tier, is_public, is_default, status, metadata)
  VALUES ('free', 'Free', 'Onboarding tier — explore the platform.', 0, true, true, 'active',
          jsonb_build_object('badge_color', 'gray'))
  ON CONFLICT (code) DO NOTHING
  RETURNING id INTO v_free_id;
  IF v_free_id IS NULL THEN
    SELECT id INTO v_free_id FROM public.plans WHERE code = 'free';
  END IF;

  -- Starter
  INSERT INTO public.plans (code, name, description, tier, is_public, is_default, status, metadata)
  VALUES ('starter', 'Starter', 'Small brokerage essentials.', 10, true, false, 'active',
          jsonb_build_object('badge_color', 'blue'))
  ON CONFLICT (code) DO NOTHING
  RETURNING id INTO v_starter_id;
  IF v_starter_id IS NULL THEN
    SELECT id INTO v_starter_id FROM public.plans WHERE code = 'starter';
  END IF;

  -- Professional
  INSERT INTO public.plans (code, name, description, tier, is_public, is_default, status, metadata)
  VALUES ('professional', 'Professional', 'Established brokerage operations.', 20, true, false, 'active',
          jsonb_build_object('badge_color', 'purple'))
  ON CONFLICT (code) DO NOTHING
  RETURNING id INTO v_pro_id;
  IF v_pro_id IS NULL THEN
    SELECT id INTO v_pro_id FROM public.plans WHERE code = 'professional';
  END IF;

  -- Enterprise
  INSERT INTO public.plans (code, name, description, tier, is_public, is_default, status, metadata)
  VALUES ('enterprise', 'Enterprise', 'MLS-scale + governance + unlimited.', 30, true, false, 'active',
          jsonb_build_object('badge_color', 'gold'))
  ON CONFLICT (code) DO NOTHING
  RETURNING id INTO v_ent_id;
  IF v_ent_id IS NULL THEN
    SELECT id INTO v_ent_id FROM public.plans WHERE code = 'enterprise';
  END IF;

  -- Free features (fail-closed for premium ones).
  INSERT INTO public.plan_features (plan_id, feature_key, enabled, limit_value, limit_unit) VALUES
    (v_free_id, 'listings.active.max',          true,  5,    'listings'),
    (v_free_id, 'agents.seats.max',             true,  3,    'seats'),
    (v_free_id, 'webhooks.subscriptions.max',   false, 0,    'subscriptions'),
    (v_free_id, 'envelopes.send',               false, 0,    NULL),
    (v_free_id, 'envelopes.send.monthly',       false, 0,    'envelopes'),
    (v_free_id, 'commissions.ledger.write',     false, NULL, NULL),
    (v_free_id, 'market_intel.read',            false, NULL, NULL),
    (v_free_id, 'agreements.propose',           true,  NULL, NULL),
    (v_free_id, 'governance.drift_dashboard',   false, NULL, NULL)
  ON CONFLICT (plan_id, feature_key) DO NOTHING;

  -- Starter features.
  INSERT INTO public.plan_features (plan_id, feature_key, enabled, limit_value, limit_unit) VALUES
    (v_starter_id, 'listings.active.max',         true, 50,    'listings'),
    (v_starter_id, 'agents.seats.max',            true, 10,    'seats'),
    (v_starter_id, 'webhooks.subscriptions.max',  true, 2,     'subscriptions'),
    (v_starter_id, 'envelopes.send',              true, NULL,  NULL),
    (v_starter_id, 'envelopes.send.monthly',      true, 10,    'envelopes'),
    (v_starter_id, 'commissions.ledger.write',    true, NULL,  NULL),
    (v_starter_id, 'market_intel.read',           false, NULL, NULL),
    (v_starter_id, 'agreements.propose',          true, NULL,  NULL),
    (v_starter_id, 'governance.drift_dashboard',  false, NULL, NULL)
  ON CONFLICT (plan_id, feature_key) DO NOTHING;

  -- Professional features.
  INSERT INTO public.plan_features (plan_id, feature_key, enabled, limit_value, limit_unit) VALUES
    (v_pro_id, 'listings.active.max',         true, 500,   'listings'),
    (v_pro_id, 'agents.seats.max',            true, 50,    'seats'),
    (v_pro_id, 'webhooks.subscriptions.max',  true, 10,    'subscriptions'),
    (v_pro_id, 'envelopes.send',              true, NULL,  NULL),
    (v_pro_id, 'envelopes.send.monthly',      true, 100,   'envelopes'),
    (v_pro_id, 'commissions.ledger.write',    true, NULL,  NULL),
    (v_pro_id, 'market_intel.read',           true, NULL,  NULL),
    (v_pro_id, 'agreements.propose',          true, NULL,  NULL),
    (v_pro_id, 'governance.drift_dashboard',  false, NULL, NULL)
  ON CONFLICT (plan_id, feature_key) DO NOTHING;

  -- Enterprise features (NULL limit = unlimited).
  INSERT INTO public.plan_features (plan_id, feature_key, enabled, limit_value, limit_unit) VALUES
    (v_ent_id, 'listings.active.max',         true, NULL, 'listings'),
    (v_ent_id, 'agents.seats.max',            true, NULL, 'seats'),
    (v_ent_id, 'webhooks.subscriptions.max',  true, NULL, 'subscriptions'),
    (v_ent_id, 'envelopes.send',              true, NULL, NULL),
    (v_ent_id, 'envelopes.send.monthly',      true, NULL, 'envelopes'),
    (v_ent_id, 'commissions.ledger.write',    true, NULL, NULL),
    (v_ent_id, 'market_intel.read',           true, NULL, NULL),
    (v_ent_id, 'agreements.propose',          true, NULL, NULL),
    (v_ent_id, 'governance.drift_dashboard',  true, NULL, NULL)
  ON CONFLICT (plan_id, feature_key) DO NOTHING;
END $$;


-- =====================================================================
-- 11. Backfill — every existing org gets the default subscription
-- =====================================================================

INSERT INTO public.organization_subscriptions
  (organization_id, plan_id, status, effective_at, granted_reason)
SELECT
  o.id,
  (SELECT id FROM public.plans WHERE is_default = true AND status = 'active' LIMIT 1),
  'active',
  now(),
  'auto_default_backfill'
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.organization_subscriptions os
   WHERE os.organization_id = o.id
     AND os.status IN ('active', 'trialing', 'past_due')
)
AND EXISTS (SELECT 1 FROM public.plans WHERE is_default = true AND status = 'active');


NOTIFY pgrst, 'reload schema';
