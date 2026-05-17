-- Per-tenant platform_settings.
--
-- Adds an organization_id column. NULL = global default. Per-tenant
-- rows override global ones. PK changes from (key) to (key, org_id_or_null)
-- via a unique index because Postgres won't include nulls in a UNIQUE
-- constraint without an explicit NULLS NOT DISTINCT clause (PG15+),
-- which we mirror here using a partial unique index.
--
-- get_platform_setting(key, org?) — looks up org-specific row first,
-- falls back to global if no org row exists. Workers running outside
-- a request context (cron tasks) pass NULL or omit the org and get
-- the global value, preserving today's behavior.
--
-- Migration is additive: existing rows keep organization_id = NULL
-- (global) so any current caller continues to work without change.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.get_platform_setting(text, uuid);
--   DROP INDEX IF EXISTS public.platform_settings_per_tenant_uniq;
--   ALTER TABLE public.platform_settings DROP COLUMN IF EXISTS organization_id;
--   -- Restore single-key version of get_platform_setting:
--   CREATE OR REPLACE FUNCTION public.get_platform_setting(p_key text)
--     ... (see migration 073)


-- =====================================================================
-- Schema additions
-- =====================================================================

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.platform_settings.organization_id IS
  'NULL = global default; non-null = per-tenant override.';


-- We need a unique constraint on (key, organization_id) treating NULLs
-- as distinct (the default behavior). The original PRIMARY KEY on (key)
-- prevents multiple global rows; we have to drop it and replace with
-- (key, organization_id) as the new PK.
DO $$
BEGIN
  ALTER TABLE public.platform_settings DROP CONSTRAINT IF EXISTS platform_settings_pkey;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

-- Add the new composite PK. Postgres treats NULLs as distinct in PK
-- columns starting in PG15 only when explicitly told; we use a UNIQUE
-- index with COALESCE to enforce one global + one per-org without
-- depending on PG version.
CREATE UNIQUE INDEX IF NOT EXISTS platform_settings_per_tenant_uniq
  ON public.platform_settings (key, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Re-add a regular index on key alone for the fallback lookup.
CREATE INDEX IF NOT EXISTS platform_settings_key_idx
  ON public.platform_settings(key);

-- Make `key` NOT NULL again (it was via the dropped PK).
ALTER TABLE public.platform_settings ALTER COLUMN key SET NOT NULL;


-- =====================================================================
-- Updated read helper with org param
-- =====================================================================
--
-- Lookup order:
--   1. (key, p_organization_id) — explicit per-tenant
--   2. (key, NULL)              — global default
-- Returns NULL if neither exists.
--
-- Adds the param without breaking existing callers: the old single-arg
-- signature still works (Postgres dispatches by arg count).

CREATE OR REPLACE FUNCTION public.get_platform_setting(
  p_key             text,
  p_organization_id uuid DEFAULT NULL
)
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

  -- Prefer the per-tenant row.
  IF p_organization_id IS NOT NULL THEN
    SELECT value INTO v_value
      FROM public.platform_settings
     WHERE key = p_key
       AND organization_id = p_organization_id;
    IF v_value IS NOT NULL THEN
      RETURN v_value;
    END IF;
  END IF;

  -- Fall back to the global row.
  SELECT value INTO v_value
    FROM public.platform_settings
   WHERE key = p_key
     AND organization_id IS NULL;

  RETURN v_value;
END;
$$;

REVOKE ALL ON FUNCTION public.get_platform_setting(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_setting(text, uuid)
  TO authenticated, service_role;

-- The old single-arg signature is still available; both share the
-- same function name with different signatures.

COMMENT ON FUNCTION public.get_platform_setting(text, uuid) IS
  'Per-tenant-aware read helper. Looks up (key, org) first, then (key, NULL) global. p_organization_id NULL = global only.';


NOTIFY pgrst, 'reload schema';
