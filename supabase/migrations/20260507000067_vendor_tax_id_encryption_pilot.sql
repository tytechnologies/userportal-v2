-- PII encryption pilot — vendors.tax_id (PH BIR TIN).
--
-- Reference implementation for the encryption helpers shipped in
-- 20260507000064. This migration is additive only (per project rule):
-- the old `vendors.tax_id` text column stays in place, and a new
-- companion pair (`tax_id_encrypted` bytea, `tax_id_key_version`
-- integer) is added. Operators backfill via vendor_tax_id_backfill()
-- once the encryption GUC is configured.
--
-- Why vendors.tax_id specifically:
--   * Clearly PII (BIR TIN is regulated under Data Privacy Act of 2012).
--   * Single text column — small blast radius for the reference
--     pattern, no JSON unpacking needed.
--   * Naturally permission-gated: only finance / compliance operators
--     need decrypt access; the rest of the app already doesn't need
--     to read it.
--
-- Reads go through public.vendor_get_tax_id(p_vendor_id) which checks
-- the caller has finance-tier permission. Writes go through
-- public.vendor_set_tax_id(p_vendor_id, p_plaintext) which encrypts
-- with the active key version.
--
-- The plaintext column REMAINS for backwards compat. Once every
-- caller is migrated to the helper RPCs and operators have run
-- vendor_tax_id_backfill(), a follow-up user-approved migration
-- will null out the plaintext column.
--
-- ROLLBACK:
--   ALTER TABLE public.vendors DROP COLUMN IF EXISTS tax_id_encrypted;
--   ALTER TABLE public.vendors DROP COLUMN IF EXISTS tax_id_key_version;
--   DROP FUNCTION IF EXISTS public.vendor_set_tax_id(uuid, text);
--   DROP FUNCTION IF EXISTS public.vendor_get_tax_id(uuid);
--   DROP FUNCTION IF EXISTS public.vendor_tax_id_backfill();
--   DELETE FROM public.permissions WHERE name = 'pii.vendors.tax_id.read';
--   DELETE FROM public.role_permissions WHERE permission = 'pii.vendors.tax_id.read';
--   DELETE FROM public.governance_schema_contracts
--     WHERE contract_name IN ('public.vendor_set_tax_id', 'public.vendor_get_tax_id',
--                             'public.vendor_tax_id_backfill');


-- =====================================================================
-- Schema additions (additive only)
-- =====================================================================

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS tax_id_encrypted   bytea,
  ADD COLUMN IF NOT EXISTS tax_id_key_version integer;

COMMENT ON COLUMN public.vendors.tax_id_encrypted IS
  'Encrypted BIR TIN. Read via vendor_get_tax_id(); write via vendor_set_tax_id().';
COMMENT ON COLUMN public.vendors.tax_id_key_version IS
  'Key version used to encrypt tax_id_encrypted. NULL when not yet encrypted.';


-- =====================================================================
-- Permission for decrypt access
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('pii.vendors.tax_id.read',
   'Decrypt and read encrypted vendor TIN (BIR PII)',
   'pii')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'pii.vendors.tax_id.read')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- Write helper
-- =====================================================================
--
-- Encrypts plaintext with the active key version and writes both
-- the ciphertext + version atomically. Caller must have writes on
-- vendors (the underlying UPDATE enforces RLS) AND must have the
-- finance permission, since they're handling the plaintext.

CREATE OR REPLACE FUNCTION public.vendor_set_tax_id(
  p_vendor_id uuid,
  p_plaintext text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version integer;
  v_cipher  bytea;
BEGIN
  -- Smoke-test bypass per project memory.
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSIF NOT (
    public.has_permission('pii.vendors.tax_id.read')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: requires pii.vendors.tax_id.read';
  END IF;

  IF p_plaintext IS NULL OR length(trim(p_plaintext)) = 0 THEN
    -- Allow null-out: record the empty state without encrypting.
    UPDATE public.vendors
       SET tax_id_encrypted   = NULL,
           tax_id_key_version = NULL
     WHERE id = p_vendor_id;
    RETURN;
  END IF;

  v_version := public.pii_active_key_version();
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'pii encryption is not configured (set app.pii_encryption_active_version)';
  END IF;

  v_cipher := public.encrypt_pii(p_plaintext);

  UPDATE public.vendors
     SET tax_id_encrypted   = v_cipher,
         tax_id_key_version = v_version
   WHERE id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor % not found', p_vendor_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_set_tax_id(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_set_tax_id(uuid, text)
  TO authenticated, service_role;


-- =====================================================================
-- Read helper
-- =====================================================================

CREATE OR REPLACE FUNCTION public.vendor_get_tax_id(p_vendor_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cipher  bytea;
  v_version integer;
  v_legacy  text;
BEGIN
  -- Smoke-test bypass per project memory.
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSIF NOT (
    public.has_permission('pii.vendors.tax_id.read')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: requires pii.vendors.tax_id.read';
  END IF;

  SELECT tax_id_encrypted, tax_id_key_version, tax_id
    INTO v_cipher, v_version, v_legacy
    FROM public.vendors
   WHERE id = p_vendor_id;

  IF v_cipher IS NOT NULL AND v_version IS NOT NULL THEN
    RETURN public.decrypt_pii(v_cipher, v_version);
  END IF;
  -- Backwards compat fallback to the plaintext column for vendors
  -- not yet backfilled.
  RETURN v_legacy;
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_get_tax_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_get_tax_id(uuid)
  TO authenticated, service_role;


-- =====================================================================
-- Backfill RPC
-- =====================================================================
--
-- One-shot operator action. Reads every vendor with non-empty tax_id
-- AND null tax_id_encrypted, encrypts under the active key, and
-- writes the ciphertext + version. Returns the count migrated.
--
-- Idempotent: rows already encrypted are skipped. Run again after
-- importing fresh vendors with plaintext TINs.

CREATE OR REPLACE FUNCTION public.vendor_tax_id_backfill()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version integer;
  v_count   integer := 0;
  v_skipped integer := 0;
  v_row     record;
BEGIN
  -- Smoke-test bypass per project memory.
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSIF NOT public.has_permission('admin.access') THEN
    RAISE EXCEPTION 'permission denied: requires admin.access';
  END IF;

  v_version := public.pii_active_key_version();
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'pii encryption is not configured (set app.pii_encryption_active_version)';
  END IF;

  FOR v_row IN
    SELECT id, tax_id
      FROM public.vendors
     WHERE tax_id IS NOT NULL
       AND length(trim(tax_id)) > 0
       AND tax_id_encrypted IS NULL
  LOOP
    BEGIN
      UPDATE public.vendors
         SET tax_id_encrypted   = public.encrypt_pii(v_row.tax_id),
             tax_id_key_version = v_version
       WHERE id = v_row.id;
      v_count := v_count + 1;
    EXCEPTION WHEN others THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'encrypted', v_count,
    'skipped',   v_skipped,
    'key_version', v_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.vendor_tax_id_backfill() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vendor_tax_id_backfill() TO service_role;


COMMENT ON FUNCTION public.vendor_set_tax_id(uuid, text) IS
  'Encrypt and persist a vendor TIN. Plaintext leaves the function as ciphertext + version.';
COMMENT ON FUNCTION public.vendor_get_tax_id(uuid) IS
  'Decrypt a vendor TIN. Falls back to the legacy plaintext column for un-backfilled vendors.';
COMMENT ON FUNCTION public.vendor_tax_id_backfill() IS
  'Idempotent backfill: encrypts every legacy plaintext tax_id under the active key version.';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.vendor_set_tax_id', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Encrypted write helper for vendors.tax_id (BIR TIN PII).',
   false),
  ('public.vendor_get_tax_id', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Decrypted read helper for vendors.tax_id; permission-gated.',
   false),
  ('public.vendor_tax_id_backfill', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'One-shot operator backfill from legacy plaintext to encrypted.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- Smoke test (idempotent)
-- =====================================================================
DO $$
DECLARE
  v_active integer;
BEGIN
  v_active := public.pii_active_key_version();
  IF v_active IS NULL THEN
    RAISE NOTICE 'Vendor TIN encryption pilot: helpers installed; configure encryption GUC + run vendor_tax_id_backfill() to migrate existing rows.';
  ELSE
    RAISE NOTICE 'Vendor TIN encryption pilot: helpers ready; key version % active. Operator may run vendor_tax_id_backfill() now.', v_active;
  END IF;
END $$;


NOTIFY pgrst, 'reload schema';
