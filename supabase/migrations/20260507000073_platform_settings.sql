-- Platform settings — admin-managed key/value config.
--
-- Phase E follow-on. Operator-facing config that doesn't belong in
-- env vars (because it changes between sandbox/staging/production
-- runs and we want a UI for it). One row per setting key. Values
-- are JSON so different settings can carry different shapes.
--
-- Documented keys:
--   eis_provider              { url: text, token: text }
--   eis_supplier              { tin: text, name: text, address: text }
--
-- Trust boundaries:
--   * Read: admin.access only (settings include secrets like the
--     EIS provider token).
--   * Write: admin.access only.
--   * The EIS submitter worker (which does NOT run as a logged-in
--     admin — it uses the service role) reads via SECURITY DEFINER
--     helper so the worker can fetch its config without an env var.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.get_platform_setting(text);
--   DROP TABLE IF EXISTS public.platform_settings;
--   DELETE FROM public.governance_schema_contracts
--     WHERE contract_name IN ('public.platform_settings', 'public.get_platform_setting');


CREATE TABLE IF NOT EXISTS public.platform_settings (
  key          text PRIMARY KEY,
  value        jsonb NOT NULL DEFAULT '{}'::jsonb,
  description  text,
  updated_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_platform_settings_updated_at ON public.platform_settings;
CREATE TRIGGER set_platform_settings_updated_at
  BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_settings_select ON public.platform_settings;
CREATE POLICY platform_settings_select ON public.platform_settings FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.access'));

DROP POLICY IF EXISTS platform_settings_modify ON public.platform_settings;
CREATE POLICY platform_settings_modify ON public.platform_settings FOR ALL
  TO authenticated
  USING (public.has_permission('admin.access'))
  WITH CHECK (public.has_permission('admin.access'));


-- =====================================================================
-- Worker-facing read helper. SECURITY DEFINER so the service role
-- can fetch its config without granting authenticated users blanket
-- platform_settings reads. Returns NULL if the key isn't set.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_platform_setting(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_value jsonb;
BEGIN
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSIF NOT public.has_permission('admin.access') THEN
    RAISE EXCEPTION 'permission denied: requires admin.access';
  END IF;

  SELECT value INTO v_value
    FROM public.platform_settings
   WHERE key = p_key;

  RETURN v_value;
END;
$$;

REVOKE ALL ON FUNCTION public.get_platform_setting(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_setting(text)
  TO authenticated, service_role;


-- Documented seed rows so the operator's settings UI shows them
-- with placeholder text (not "missing key" 404s).
INSERT INTO public.platform_settings (key, value, description) VALUES
  ('eis_provider',
   '{"url": "", "token": ""}'::jsonb,
   'EIS (BIR e-invoicing) provider URL + bearer token. Empty = noop mode.'),
  ('eis_supplier',
   '{"tin": "", "name": "", "address": ""}'::jsonb,
   'Supplier (the platform) identity: BIR TIN, registered name, address.')
ON CONFLICT (key) DO NOTHING;


COMMENT ON TABLE public.platform_settings IS
  'Admin-managed config (replaces some env vars). Reads via get_platform_setting().';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.platform_settings', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Admin-managed key/value platform config.',
   false),
  ('public.get_platform_setting', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Read helper for platform_settings. Service role / admin only.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
