-- Platform-wide settings keyed by string. Used initially for the
-- AI-generation config (endpoint, API key, model) that powers the
-- "Generate" option on the New Document wizard. Single global
-- config — same endpoint and key for every broker on the platform,
-- managed by a platform admin.
--
-- The api_key column is a secret. Read access is platform-admin
-- only via RLS; brokers calling the AI generation endpoint never
-- touch this table directly — the server endpoint reads it on
-- their behalf using the service role.
--
-- Schema is intentionally a key/value store rather than a fixed
-- column set so we can add more platform settings later (e.g.
-- email-relay credentials, SMS provider keys) without another
-- migration. Each row has its own purpose comment.

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text,
  updated_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Pre-seed the AI-generation row so the admin UI has something to
-- edit on first load. value defaults to {} — the endpoint treats
-- missing/empty config as "not configured" and surfaces a 503 with
-- a clear admin-configure message.
--
-- WHERE NOT EXISTS instead of ON CONFLICT (key) because migration
-- 20260507000077 dropped the PK on `key` alone in favor of a
-- composite UNIQUE INDEX on `(key, COALESCE(organization_id, …))`.
-- ON CONFLICT (key) errors on that schema with 42P10 "no unique or
-- exclusion constraint matching the ON CONFLICT specification".
-- WHERE NOT EXISTS is shape-agnostic — works on either schema and
-- on subsequent re-runs.
INSERT INTO public.platform_settings (key, description, value)
SELECT
  'ai_generation',
  'Document AI generation config — provider, endpoint, API key, model. Powers the Generate option on the New Document wizard.',
  '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1
    FROM public.platform_settings
   WHERE key = 'ai_generation'
);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Platform-admin only. Brokers reach the value indirectly via the
-- server endpoint which uses the service role; they never SELECT
-- this table directly.
DROP POLICY IF EXISTS platform_settings_admin_read   ON public.platform_settings;
DROP POLICY IF EXISTS platform_settings_admin_write  ON public.platform_settings;
DROP POLICY IF EXISTS platform_settings_admin_update ON public.platform_settings;

CREATE POLICY platform_settings_admin_read
  ON public.platform_settings
  FOR SELECT
  TO authenticated
  USING (public.has_permission('platform.settings.manage'));

CREATE POLICY platform_settings_admin_write
  ON public.platform_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_permission('platform.settings.manage'));

CREATE POLICY platform_settings_admin_update
  ON public.platform_settings
  FOR UPDATE
  TO authenticated
  USING (public.has_permission('platform.settings.manage'))
  WITH CHECK (public.has_permission('platform.settings.manage'));

-- Auto-stamp updated_at + updated_by on UPDATE.
CREATE OR REPLACE FUNCTION public.platform_settings_set_updated()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  -- auth.uid() is null in service-role contexts; preserve the
  -- supplied updated_by then.
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS platform_settings_set_updated ON public.platform_settings;
CREATE TRIGGER platform_settings_set_updated
  BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.platform_settings_set_updated();

GRANT SELECT, INSERT, UPDATE ON public.platform_settings TO authenticated;
