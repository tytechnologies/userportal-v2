-- Outbound webhook subscriptions + delivery log.
--
-- Partner counterpart to source ingestion: lets external systems
-- subscribe to platform events ('inquiry.received', 'listing.created',
-- 'verification.approved', etc.) via signed POSTs to a URL of their
-- choosing.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.webhook_deliveries;
--   DROP TABLE IF EXISTS public.webhook_subscriptions;
--   DELETE FROM public.permissions WHERE name = 'webhooks.manage';

-- =====================================================================
-- 1. webhook_subscriptions — who's listening + how to reach them
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.webhook_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional partner attribution. NULL = admin-managed (e.g., internal
  -- analytics service). Non-null = associated with a listing source
  -- so revoking the source also revokes its webhooks.
  source_id       bigint REFERENCES public.listing_sources(id) ON DELETE CASCADE,

  -- Human-readable label.
  display_name    text NOT NULL,

  -- The partner's HTTPS endpoint we POST to.
  url             text NOT NULL CHECK (url ~* '^https://'),

  -- HMAC-SHA256 secret. Auto-generated 32-byte hex on insert.
  -- Partner verifies signature on each delivery using this.
  signing_secret  text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),

  -- Event kinds this subscription wants. Empty = ALL events.
  -- Common values: 'inquiry.received', 'listing.created',
  -- 'listing.archived', 'verification.approved'.
  event_kinds     text[] NOT NULL DEFAULT ARRAY[]::text[],

  enabled         boolean NOT NULL DEFAULT true,

  -- Reliability state — incremented on delivery failure, reset on
  -- success. Auto-disables when consecutive_failures hits 10.
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_delivery_at      timestamptz,
  last_delivery_status  integer,

  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_subscriptions_source_idx
  ON public.webhook_subscriptions(source_id);
-- Partial index for the dispatcher's hot lookup (enabled subs only).
CREATE INDEX IF NOT EXISTS webhook_subscriptions_enabled_idx
  ON public.webhook_subscriptions(enabled) WHERE enabled = true;

DROP TRIGGER IF EXISTS set_webhook_subscriptions_updated_at
  ON public.webhook_subscriptions;
CREATE TRIGGER set_webhook_subscriptions_updated_at
  BEFORE UPDATE ON public.webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON TABLE public.webhook_subscriptions IS
  'Partner outbound webhook endpoints. Each row defines a URL we POST signed event payloads to. signing_secret is for HMAC-SHA256; event_kinds filters; enabled gates delivery. Auto-disables after 10 consecutive failures.';


-- =====================================================================
-- 2. webhook_deliveries — append-only delivery log
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL
                  REFERENCES public.webhook_subscriptions(id) ON DELETE CASCADE,
  event_kind      text NOT NULL,
  payload         jsonb NOT NULL,
  http_status     integer,
  -- First 1KB of response body — useful for debugging partner
  -- 4xx/5xx without storing unbounded blobs.
  response_excerpt text,
  error_message   text,
  duration_ms     integer,
  attempted_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_sub_recent_idx
  ON public.webhook_deliveries(subscription_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_failures_idx
  ON public.webhook_deliveries(attempted_at DESC)
  WHERE http_status IS NULL OR http_status >= 400;

COMMENT ON TABLE public.webhook_deliveries IS
  'Append-only log of every webhook dispatch. Captures status, response excerpt (first 1KB), error message, duration. Future cleanup cron prunes rows > 30d.';


-- =====================================================================
-- 3. RLS — admin only for both tables
-- =====================================================================

ALTER TABLE public.webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- All access via the new permission below.
DROP POLICY IF EXISTS webhook_subscriptions_select_admin
  ON public.webhook_subscriptions;
CREATE POLICY webhook_subscriptions_select_admin
  ON public.webhook_subscriptions FOR SELECT
  TO authenticated
  USING (public.has_permission('webhooks.manage'));

DROP POLICY IF EXISTS webhook_subscriptions_insert_admin
  ON public.webhook_subscriptions;
CREATE POLICY webhook_subscriptions_insert_admin
  ON public.webhook_subscriptions FOR INSERT
  TO authenticated
  WITH CHECK (public.has_permission('webhooks.manage'));

DROP POLICY IF EXISTS webhook_subscriptions_update_admin
  ON public.webhook_subscriptions;
CREATE POLICY webhook_subscriptions_update_admin
  ON public.webhook_subscriptions FOR UPDATE
  TO authenticated
  USING (public.has_permission('webhooks.manage'))
  WITH CHECK (public.has_permission('webhooks.manage'));

DROP POLICY IF EXISTS webhook_subscriptions_delete_admin
  ON public.webhook_subscriptions;
CREATE POLICY webhook_subscriptions_delete_admin
  ON public.webhook_subscriptions FOR DELETE
  TO authenticated
  USING (public.has_permission('webhooks.manage'));

DROP POLICY IF EXISTS webhook_deliveries_select_admin ON public.webhook_deliveries;
CREATE POLICY webhook_deliveries_select_admin
  ON public.webhook_deliveries FOR SELECT
  TO authenticated
  USING (public.has_permission('webhooks.manage'));
-- INSERT not granted to authenticated — service-role only via the
-- dispatcher, since auth.uid() doesn't exist in the dispatch path.


-- =====================================================================
-- 4. Permission catalog
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('webhooks.manage', 'Create / edit / disable outbound webhook subscriptions', 'admin')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'webhooks.manage')
ON CONFLICT DO NOTHING;


NOTIFY pgrst, 'reload schema';
