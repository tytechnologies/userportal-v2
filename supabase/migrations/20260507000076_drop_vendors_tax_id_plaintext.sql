-- Drop vendors.tax_id plaintext column.
--
-- This violates the project's normal additive-only rule. User signed
-- off via "all, go" on the explicit option to drop after backfill.
--
-- Safety: refuses to drop if any row has a non-empty plaintext that
-- has NOT been encrypted into tax_id_encrypted. Operators must run
--    SELECT public.vendor_tax_id_backfill();
-- first, then re-apply this migration. The check is deliberately
-- run inside the same migration so partial state is impossible.
--
-- Post-drop, every vendor TIN read MUST go through
-- public.vendor_get_tax_id(vendor_id). The earlier migration 074
-- already updated the BIR generators to do this; verify any new
-- callers via:
--    SELECT relname FROM pg_class WHERE oid IN (
--      SELECT objid FROM pg_depend
--      WHERE refobjsubid = (
--        SELECT attnum FROM pg_attribute
--        WHERE attrelid = 'public.vendors'::regclass AND attname = 'tax_id'
--      )
--    );
--
-- ROLLBACK:
--   ALTER TABLE public.vendors ADD COLUMN tax_id text;
--   -- The plaintext is unrecoverable; backfill from vendor_get_tax_id():
--   UPDATE public.vendors SET tax_id = public.vendor_get_tax_id(id)
--     WHERE tax_id_encrypted IS NOT NULL;
--
-- CONSEQUENCES:
--   * The legacy plaintext fallback inside vendor_get_tax_id() (which
--     reads v.tax_id when tax_id_encrypted is NULL) becomes a no-op
--     forever — un-backfilled rows are now permanently TIN-less.
--   * External tooling that selected v.tax_id directly will silently
--     get NULL after this migration. Code-search before deploy:
--       grep -rn "vendors\?.*tax_id" --include='*.ts' --include='*.sql'

DO $$
DECLARE
  v_unencrypted_count integer;
BEGIN
  SELECT count(*) INTO v_unencrypted_count
    FROM public.vendors
   WHERE tax_id IS NOT NULL
     AND length(trim(tax_id)) > 0
     AND tax_id_encrypted IS NULL;

  IF v_unencrypted_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop vendors.tax_id: % vendors still have un-encrypted plaintext. Run SELECT public.vendor_tax_id_backfill(); first, then re-apply.',
      v_unencrypted_count;
  END IF;
END $$;

-- Update the helper to remove the plaintext fallback path. Without
-- this change, vendor_get_tax_id() would still try to SELECT
-- v.tax_id, which no longer exists.
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
BEGIN
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSIF NOT (
    public.has_permission('pii.vendors.tax_id.read')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: requires pii.vendors.tax_id.read';
  END IF;

  SELECT tax_id_encrypted, tax_id_key_version
    INTO v_cipher, v_version
    FROM public.vendors
   WHERE id = p_vendor_id;

  IF v_cipher IS NULL OR v_version IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public.decrypt_pii(v_cipher, v_version);
END;
$$;

-- Drop the column.
ALTER TABLE public.vendors DROP COLUMN IF EXISTS tax_id;

COMMENT ON FUNCTION public.vendor_get_tax_id(uuid) IS
  'Decrypt-only TIN reader. Plaintext fallback removed in 076. Returns NULL for vendors without an encrypted TIN.';

NOTIFY pgrst, 'reload schema';
