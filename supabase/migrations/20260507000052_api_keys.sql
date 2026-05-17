-- Public API keys + scoped tokens.
--
-- B7 of the post-audit roadmap. Inbound counterpart to the existing
-- outbound webhook system: third-party integrations get scoped
-- bearer tokens to call our API. Stripe-shaped lifecycle:
-- generate-once-show-once + hash-only storage.
--
-- The full key value leaves the DB only at api_key_generate() return
-- time. Subsequent reads expose prefix + last4 only.
--
-- Existing surfaces preserved:
--   - rate_limit_buckets             — kept; reusable per-key keys.
--   - has_permission, deal_can_*     — unchanged.
--   - webhook_subscriptions          — unchanged (outbound side).
--
-- ROLLBACK:
--   SELECT cron.unschedule('api_key_usage_prune_daily');
--   SELECT cron.unschedule('api_key_expire_daily');
--   DROP FUNCTION IF EXISTS public.api_key_expire_fn();
--   DROP FUNCTION IF EXISTS public.api_key_usage_prune_fn();
--   DROP FUNCTION IF EXISTS public.api_key_record_usage(uuid, text, text, text, int, int, text, text, text);
--   DROP FUNCTION IF EXISTS public.api_key_revoke(uuid, text);
--   DROP FUNCTION IF EXISTS public.api_key_verify(text);
--   DROP FUNCTION IF EXISTS public.api_key_generate(text, uuid, text[], text, timestamptz, int);
--   DROP TABLE IF EXISTS public.api_key_audit_events;
--   DROP TABLE IF EXISTS public.api_key_usage;
--   DROP TABLE IF EXISTS public.api_keys;
--   DROP TABLE IF EXISTS public.api_key_scopes;
--   DELETE FROM public.role_permissions WHERE permission IN
--     ('api_keys.manage.own', 'api_keys.manage.platform');
--   DELETE FROM public.permissions WHERE name IN
--     ('api_keys.manage.own', 'api_keys.manage.platform');
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.api_keys', 'public.api_key_scopes',
--      'public.api_key_usage', 'public.api_key_audit_events');


-- pgcrypto needed for digest(); already enabled on Supabase but
-- the explicit ensure-step keeps the migration self-contained.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =====================================================================
-- 1. api_key_scopes — catalog of valid scopes
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.api_key_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- snake-colon-namespace: 'listings:read', 'inquiries:write',
  -- 'webhooks:manage'. Lowercase, alphanum + colon + dot.
  scope           text NOT NULL UNIQUE
                       CHECK (scope ~ '^[a-z][a-z0-9_]*(:[a-z0-9_]+)+$'),

  description     text,
  category        text NOT NULL,

  -- false = scope removed from the catalog; existing keys keep it,
  -- new keys can't request it.
  enabled         boolean NOT NULL DEFAULT true,

  -- Platform-admin-only scopes ('organizations:manage', 'users:manage').
  -- Repo enforces caller has 'admin.access' before including.
  requires_admin  boolean NOT NULL DEFAULT false,

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_key_scopes_category_idx
  ON public.api_key_scopes(category, scope);


-- =====================================================================
-- 2. api_keys — bearer tokens
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.api_keys (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL = platform-wide admin key (admin-creator only).
  organization_id       uuid REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Operator-facing label.
  name                  text NOT NULL,

  -- Display-only. Format: 'hipk_live_a1b2c3d4' (16-20 chars).
  prefix                text NOT NULL,
  -- Last 4 chars of the secret portion.
  last4                 text NOT NULL CHECK (length(last4) = 4),
  -- SHA-256 hex of the full key value. UNIQUE for constant-time lookup.
  key_hash              text NOT NULL UNIQUE,

  kind                  text NOT NULL DEFAULT 'live'
                             CHECK (kind IN ('live', 'test', 'restricted')),

  scopes                text[] NOT NULL DEFAULT '{}',

  status                text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'revoked', 'expired')),

  last_used_at          timestamptz,
  expires_at            timestamptz,
  rate_limit_per_minute int NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute > 0),

  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoked_at            timestamptz,
  revoked_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoke_reason         text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_org_idx
  ON public.api_keys(organization_id, status, created_at DESC)
  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_keys_status_idx
  ON public.api_keys(status, created_at DESC);
-- GIN index for "any key with scope X" queries (admin auditing).
CREATE INDEX IF NOT EXISTS api_keys_scopes_gin_idx
  ON public.api_keys USING gin (scopes);

DROP TRIGGER IF EXISTS set_api_keys_updated_at ON public.api_keys;
CREATE TRIGGER set_api_keys_updated_at
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.api_keys IS
  'API key bearer tokens. key_hash is SHA-256 of the full secret. Full key value returned ONCE at api_key_generate; subsequent reads expose prefix + last4 only.';


-- =====================================================================
-- 3. api_key_usage — per-request access log
-- =====================================================================
--
-- Async fire-and-forget from the middleware. 90-day retention via cron.

CREATE TABLE IF NOT EXISTS public.api_key_usage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id          uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,

  request_id          text,
  method              text NOT NULL,
  path                text NOT NULL,
  status_code         int  NOT NULL,
  response_time_ms    int  CHECK (response_time_ms IS NULL OR response_time_ms >= 0),

  ip                  inet,
  user_agent          text,
  error_code          text,

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_key_usage_key_idx
  ON public.api_key_usage(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_key_usage_status_idx
  ON public.api_key_usage(status_code, created_at DESC)
  WHERE status_code >= 400;
-- Hot path for retention prune.
CREATE INDEX IF NOT EXISTS api_key_usage_created_idx
  ON public.api_key_usage(created_at);


-- =====================================================================
-- 4. api_key_audit_events — append-only key lifecycle log
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.api_key_audit_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id          uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,

  -- Documented kinds: 'created', 'rotated', 'revoked', 'expired',
  -- 'scope_added', 'scope_removed'.
  event_kind          text NOT NULL,

  actor_user_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_ip            inet,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_key_audit_events_key_idx
  ON public.api_key_audit_events(api_key_id, created_at DESC);


-- =====================================================================
-- 5. api_key_generate — create a key (returns secret ONCE)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.api_key_generate(
  p_name                  text,
  p_organization_id       uuid,
  p_scopes                text[],
  p_kind                  text DEFAULT 'live',
  p_expires_at            timestamptz DEFAULT NULL,
  p_rate_limit_per_minute int DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret      text;
  v_full_key    text;
  v_hash        text;
  v_prefix      text;
  v_last4       text;
  v_id          uuid;
  v_kind_seg    text;
BEGIN
  -- Permission: caller must have api_keys.manage.own (org-scoped) or
  -- api_keys.manage.platform (admin) or be the brokerage_owner of the
  -- target org. Service-role bypass for SQL editor.
  IF NOT (
    public.has_permission('api_keys.manage.platform')
    OR (
      p_organization_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.organization_memberships om
         WHERE om.organization_id = p_organization_id
           AND om.user_id = auth.uid()
           AND om.status  = 'active'
           AND om.org_role = 'brokerage_owner'
      )
    )
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'api_key_generate: permission denied' USING ERRCODE = '42501';
  END IF;

  -- Validate kind.
  IF p_kind NOT IN ('live', 'test', 'restricted') THEN
    RAISE EXCEPTION 'api_key_generate: invalid kind %', p_kind;
  END IF;

  -- Validate scopes against catalog.
  IF EXISTS (
    SELECT 1 FROM unnest(p_scopes) AS s
    LEFT JOIN public.api_key_scopes c ON c.scope = s
    WHERE c.scope IS NULL OR c.enabled = false
  ) THEN
    RAISE EXCEPTION 'api_key_generate: one or more scopes are invalid or disabled';
  END IF;

  -- requires_admin scopes need admin.access.
  IF EXISTS (
    SELECT 1 FROM unnest(p_scopes) AS s
    JOIN public.api_key_scopes c ON c.scope = s
    WHERE c.requires_admin = true
  ) AND NOT public.has_permission('admin.access')
    AND session_user NOT IN ('postgres', 'supabase_admin', 'service_role')
  THEN
    RAISE EXCEPTION 'api_key_generate: scope requires admin.access' USING ERRCODE = '42501';
  END IF;

  -- restricted-kind keys: only :read scopes allowed.
  IF p_kind = 'restricted' THEN
    IF EXISTS (
      SELECT 1 FROM unnest(p_scopes) AS s
      WHERE s !~ ':read$'
    ) THEN
      RAISE EXCEPTION 'api_key_generate: restricted-kind keys only allow :read scopes';
    END IF;
  END IF;

  -- Generate. v_secret is 32 hex chars (16 bytes); the full key is
  -- 'hipk_<kind>_<32 hex>' = ~42 chars total.
  v_secret   := encode(gen_random_bytes(16), 'hex');
  v_kind_seg := CASE p_kind
                  WHEN 'live'       THEN 'live'
                  WHEN 'test'       THEN 'test'
                  WHEN 'restricted' THEN 'rest'
                END;
  v_full_key := 'hipk_' || v_kind_seg || '_' || v_secret;
  v_hash     := encode(digest(v_full_key, 'sha256'), 'hex');
  v_prefix   := 'hipk_' || v_kind_seg || '_' || substring(v_secret, 1, 8);
  v_last4    := substring(v_secret, length(v_secret) - 3, 4);

  INSERT INTO public.api_keys
    (organization_id, name, prefix, last4, key_hash, kind, scopes,
     expires_at, rate_limit_per_minute, created_by)
  VALUES
    (p_organization_id, p_name, v_prefix, v_last4, v_hash, p_kind, p_scopes,
     p_expires_at, p_rate_limit_per_minute, auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO public.api_key_audit_events (api_key_id, event_kind, actor_user_id, metadata)
  VALUES (v_id, 'created', auth.uid(),
          jsonb_build_object('kind', p_kind, 'scope_count', array_length(p_scopes, 1)));

  RETURN jsonb_build_object(
    'id',        v_id,
    'key_value', v_full_key,
    'prefix',    v_prefix,
    'last4',     v_last4,
    'kind',      p_kind
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_key_generate(text, uuid, text[], text, timestamptz, int)
  TO authenticated;


-- =====================================================================
-- 6. api_key_verify — middleware lookup
-- =====================================================================

CREATE OR REPLACE FUNCTION public.api_key_verify(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash text;
  v_row  record;
BEGIN
  IF p_key IS NULL OR length(p_key) < 16 THEN
    RETURN NULL;
  END IF;

  v_hash := encode(digest(p_key, 'sha256'), 'hex');

  SELECT id, organization_id, scopes, kind, status, expires_at, rate_limit_per_minute
    INTO v_row
  FROM public.api_keys
  WHERE key_hash = v_hash
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_row.status <> 'active' THEN
    RETURN NULL;
  END IF;

  IF v_row.expires_at IS NOT NULL AND v_row.expires_at <= now() THEN
    -- Best-effort flip; idempotent.
    UPDATE public.api_keys SET status = 'expired'
     WHERE id = v_row.id AND status = 'active';
    RETURN NULL;
  END IF;

  -- Update last_used_at; ignore concurrent-update wars.
  UPDATE public.api_keys SET last_used_at = now() WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'id',                v_row.id,
    'organization_id',   v_row.organization_id,
    'scopes',            v_row.scopes,
    'kind',              v_row.kind,
    'rate_limit_per_minute', v_row.rate_limit_per_minute
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_key_verify(text) TO authenticated, anon;


-- =====================================================================
-- 7. api_key_revoke
-- =====================================================================

CREATE OR REPLACE FUNCTION public.api_key_revoke(
  p_key_id uuid,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_status text;
BEGIN
  SELECT organization_id, status INTO v_org_id, v_status
  FROM public.api_keys WHERE id = p_key_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'api_key_revoke: key not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.has_permission('api_keys.manage.platform')
    OR (
      v_org_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.organization_memberships om
         WHERE om.organization_id = v_org_id
           AND om.user_id = auth.uid()
           AND om.status = 'active'
           AND om.org_role = 'brokerage_owner'
      )
    )
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'api_key_revoke: permission denied' USING ERRCODE = '42501';
  END IF;

  IF v_status <> 'active' THEN
    -- Idempotent.
    RETURN p_key_id;
  END IF;

  UPDATE public.api_keys
     SET status        = 'revoked',
         revoked_at    = now(),
         revoked_by    = auth.uid(),
         revoke_reason = p_reason
   WHERE id = p_key_id;

  INSERT INTO public.api_key_audit_events (api_key_id, event_kind, actor_user_id, metadata)
  VALUES (p_key_id, 'revoked', auth.uid(),
          jsonb_build_object('reason', p_reason));

  RETURN p_key_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_key_revoke(uuid, text) TO authenticated;


-- =====================================================================
-- 8. api_key_record_usage — middleware logger
-- =====================================================================

CREATE OR REPLACE FUNCTION public.api_key_record_usage(
  p_api_key_id      uuid,
  p_request_id      text,
  p_method          text,
  p_path            text,
  p_status_code     int,
  p_response_time_ms int,
  p_ip              text,
  p_user_agent      text,
  p_error_code      text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Service-role only; the middleware uses the admin client.
  IF session_user NOT IN ('postgres', 'supabase_admin', 'service_role')
     AND NOT public.has_permission('api_keys.manage.platform')
  THEN
    RAISE EXCEPTION 'api_key_record_usage: service-role only' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.api_key_usage
    (api_key_id, request_id, method, path, status_code, response_time_ms,
     ip, user_agent, error_code)
  VALUES
    (p_api_key_id, p_request_id, p_method, p_path, p_status_code, p_response_time_ms,
     NULLIF(p_ip, '')::inet, p_user_agent, p_error_code)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_key_record_usage(uuid, text, text, text, int, int, text, text, text)
  TO authenticated;


-- =====================================================================
-- 9. api_key_usage_prune_fn + api_key_expire_fn — daily crons
-- =====================================================================

CREATE OR REPLACE FUNCTION public.api_key_usage_prune_fn()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  WITH deleted AS (
    DELETE FROM public.api_key_usage
     WHERE created_at < now() - interval '90 days'
     RETURNING id
  )
  SELECT count(*) INTO v_count FROM deleted;
  RETURN coalesce(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_key_usage_prune_fn() TO authenticated;


CREATE OR REPLACE FUNCTION public.api_key_expire_fn()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  WITH expired AS (
    UPDATE public.api_keys
       SET status = 'expired'
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at <= now()
     RETURNING id
  ), audited AS (
    INSERT INTO public.api_key_audit_events (api_key_id, event_kind, metadata)
    SELECT id, 'expired', jsonb_build_object('reason', 'auto_expired_by_cron')
      FROM expired
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM expired;
  RETURN coalesce(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_key_expire_fn() TO authenticated;


DO $$
BEGIN
  PERFORM cron.unschedule('api_key_usage_prune_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'api_key_usage_prune_daily');
  PERFORM cron.schedule(
    'api_key_usage_prune_daily',
    '30 2 * * *',
    $cron$ SELECT public.api_key_usage_prune_fn(); $cron$
  );

  PERFORM cron.unschedule('api_key_expire_daily')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'api_key_expire_daily');
  PERFORM cron.schedule(
    'api_key_expire_daily',
    '0 2 * * *',
    $cron$ SELECT public.api_key_expire_fn(); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RAISE NOTICE 'api_key cron schedules: pg_cron unavailable; skipping';
END $$;


-- =====================================================================
-- 10. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('api_keys.manage.own',      'Create / list / revoke API keys for own org', 'api'),
  ('api_keys.manage.platform', 'Manage API keys across all orgs',             'api')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'api_keys.manage.platform'),
  ('admin',   'api_keys.manage.own')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 11. RLS
-- =====================================================================

ALTER TABLE public.api_key_scopes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_key_scopes_select ON public.api_key_scopes;
CREATE POLICY api_key_scopes_select ON public.api_key_scopes FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS api_key_scopes_modify ON public.api_key_scopes;
CREATE POLICY api_key_scopes_modify ON public.api_key_scopes FOR ALL
  TO authenticated
  USING (public.has_permission('api_keys.manage.platform'))
  WITH CHECK (public.has_permission('api_keys.manage.platform'));


ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- SELECT: brokerage_owner of the org, OR platform admin. Plain
-- members see only the prefix/last4 anyway because the RPC enforces
-- visibility; the SELECT policy is the safety net.
DROP POLICY IF EXISTS api_keys_select ON public.api_keys;
CREATE POLICY api_keys_select ON public.api_keys FOR SELECT
  TO authenticated
  USING (
    public.has_permission('api_keys.manage.platform')
    OR (
      organization_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.organization_memberships om
         WHERE om.organization_id = api_keys.organization_id
           AND om.user_id = auth.uid()
           AND om.status = 'active'
           AND om.org_role = 'brokerage_owner'
      )
    )
  );

-- INSERT/UPDATE/DELETE not exposed to authenticated. RPCs handle
-- writes (api_key_generate, api_key_revoke).


ALTER TABLE public.api_key_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_key_usage_select ON public.api_key_usage;
CREATE POLICY api_key_usage_select ON public.api_key_usage FOR SELECT
  TO authenticated
  USING (
    public.has_permission('api_keys.manage.platform')
    OR EXISTS (
      SELECT 1 FROM public.api_keys k
      JOIN public.organization_memberships om
        ON om.organization_id = k.organization_id
       AND om.user_id = auth.uid()
       AND om.status = 'active'
       AND om.org_role = 'brokerage_owner'
     WHERE k.id = api_key_usage.api_key_id
    )
  );


ALTER TABLE public.api_key_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_key_audit_events_select ON public.api_key_audit_events;
CREATE POLICY api_key_audit_events_select ON public.api_key_audit_events FOR SELECT
  TO authenticated
  USING (
    public.has_permission('api_keys.manage.platform')
    OR EXISTS (
      SELECT 1 FROM public.api_keys k
      JOIN public.organization_memberships om
        ON om.organization_id = k.organization_id
       AND om.user_id = auth.uid()
       AND om.status = 'active'
       AND om.org_role = 'brokerage_owner'
     WHERE k.id = api_key_audit_events.api_key_id
    )
  );


-- =====================================================================
-- 12. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.api_keys',             'table', 'userportal',
   ARRAY['userportal']::text[], 'API bearer tokens (hash-only storage)',  false),
  ('public.api_key_scopes',       'table', 'userportal',
   ARRAY['userportal']::text[], 'Catalog of valid scopes',                false),
  ('public.api_key_usage',        'table', 'userportal',
   ARRAY['userportal']::text[], 'Per-request access log (90-day retain)', false),
  ('public.api_key_audit_events', 'table', 'userportal',
   ARRAY['userportal']::text[], 'Append-only key lifecycle log',          false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- 13. Seed scope catalog
-- =====================================================================

INSERT INTO public.api_key_scopes (scope, description, category, requires_admin) VALUES
  -- Listings
  ('listings:read',              'Read listings and listing details',         'listings', false),
  ('listings:write',             'Create or update listings',                 'listings', false),
  ('listings:moderate',          'Moderate listings',                         'listings', true),
  -- Inquiries / CRM
  ('inquiries:read',             'Read inquiries',                            'crm',      false),
  ('inquiries:write',            'Create or update inquiries',                'crm',      false),
  ('contacts:read',              'Read contacts',                             'crm',      false),
  ('contacts:write',             'Create or update contacts',                 'crm',      false),
  ('tasks:read',                 'Read tasks',                                'crm',      false),
  ('tasks:write',                'Create or update tasks',                    'crm',      false),
  ('notes:read',                 'Read notes',                                'crm',      false),
  ('notes:write',                'Create or update notes',                    'crm',      false),
  -- Deals + commissions
  ('deals:read',                 'Read deals',                                'deals',    false),
  ('deals:write',                'Create or update deals',                    'deals',    false),
  ('commissions:read',           'Read commission ledger entries',            'deals',    false),
  -- Documents + envelopes
  ('documents:read',             'Read documents and drafts',                 'documents', false),
  ('documents:write',            'Create or update documents and drafts',     'documents', false),
  ('envelopes:read',             'Read envelopes',                            'documents', false),
  ('envelopes:send',             'Send envelopes',                            'documents', false),
  -- Webhooks
  ('webhooks:read',              'Read webhook subscriptions',                'webhooks', false),
  ('webhooks:manage',            'Create or update webhook subscriptions',    'webhooks', false),
  -- Market + analytics
  ('market:read',                'Read market intelligence data',             'market',   false),
  ('analytics:read',             'Read analytics for own org',                'analytics', false),
  -- Billing
  ('billing:read',               'Read billing data for own org',             'billing',  false),
  -- Plans
  ('plans:read',                 'Read plan catalog',                         'plans',    false),
  -- Platform-only
  ('organizations:manage',       'Manage organizations across the platform',  'platform', true),
  ('users:manage',               'Manage users across the platform',          'platform', true)
ON CONFLICT (scope) DO NOTHING;


NOTIFY pgrst, 'reload schema';
