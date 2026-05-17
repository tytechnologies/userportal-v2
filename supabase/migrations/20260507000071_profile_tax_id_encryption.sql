-- PII encryption pilot expansion — profiles.tax_id (BIR TIN).
--
-- Mirrors the vendor pilot from 20260507000067. Difference: profiles
-- has no legacy plaintext column, so this is pure new-column +
-- helpers; no backfill RPC needed (there's nothing to migrate).
--
-- Profiles' TIN is needed for BIR Form 2307 (withholding tax cert),
-- and for self-employed brokers receiving 1099-equivalent
-- payouts. Encrypted by default — only finance / compliance
-- operators decrypt.
--
-- ROLLBACK:
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS tax_id_encrypted;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS tax_id_key_version;
--   DROP FUNCTION IF EXISTS public.profile_set_tax_id(uuid, text);
--   DROP FUNCTION IF EXISTS public.profile_get_tax_id(uuid);
--   DELETE FROM public.permissions WHERE name = 'pii.profiles.tax_id.read';
--   DELETE FROM public.role_permissions WHERE permission = 'pii.profiles.tax_id.read';
--   DELETE FROM public.governance_schema_contracts
--     WHERE contract_name IN ('public.profile_set_tax_id', 'public.profile_get_tax_id');


-- =====================================================================
-- Schema additions (additive only)
-- =====================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tax_id_encrypted   bytea,
  ADD COLUMN IF NOT EXISTS tax_id_key_version integer;

COMMENT ON COLUMN public.profiles.tax_id_encrypted IS
  'Encrypted BIR TIN. Read via profile_get_tax_id; write via profile_set_tax_id.';
COMMENT ON COLUMN public.profiles.tax_id_key_version IS
  'Key version used to encrypt tax_id_encrypted.';


-- =====================================================================
-- Permission for decrypt access
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('pii.profiles.tax_id.read',
   'Decrypt and read encrypted profile TIN (BIR PII). Self-read is always allowed.',
   'pii')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'pii.profiles.tax_id.read')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- Write helper
-- =====================================================================
--
-- Self-write is permitted (the user can always update their own TIN
-- since it's their own PII). Cross-user writes require admin grant.

CREATE OR REPLACE FUNCTION public.profile_set_tax_id(
  p_user_id   uuid,
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
  v_caller  uuid;
BEGIN
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSE
    v_caller := auth.uid();
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'authentication required';
    END IF;
    -- Self-write OR admin / pii.profiles.tax_id.read.
    IF v_caller <> p_user_id AND NOT (
      public.has_permission('pii.profiles.tax_id.read')
      OR public.has_permission('admin.access')
    ) THEN
      RAISE EXCEPTION 'permission denied: only the user themselves or pii.profiles.tax_id.read can write';
    END IF;
  END IF;

  IF p_plaintext IS NULL OR length(trim(p_plaintext)) = 0 THEN
    UPDATE public.profiles
       SET tax_id_encrypted   = NULL,
           tax_id_key_version = NULL
     WHERE id = p_user_id;
    RETURN;
  END IF;

  v_version := public.pii_active_key_version();
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'pii encryption is not configured (set app.pii_encryption_active_version)';
  END IF;

  v_cipher := public.encrypt_pii(p_plaintext);

  UPDATE public.profiles
     SET tax_id_encrypted   = v_cipher,
         tax_id_key_version = v_version
   WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile % not found', p_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.profile_set_tax_id(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_set_tax_id(uuid, text)
  TO authenticated, service_role;


-- =====================================================================
-- Read helper
-- =====================================================================

CREATE OR REPLACE FUNCTION public.profile_get_tax_id(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cipher  bytea;
  v_version integer;
  v_caller  uuid;
BEGIN
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSE
    v_caller := auth.uid();
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'authentication required';
    END IF;
    IF v_caller <> p_user_id AND NOT (
      public.has_permission('pii.profiles.tax_id.read')
      OR public.has_permission('admin.access')
    ) THEN
      RAISE EXCEPTION 'permission denied: only the user themselves or pii.profiles.tax_id.read can read';
    END IF;
  END IF;

  SELECT tax_id_encrypted, tax_id_key_version
    INTO v_cipher, v_version
    FROM public.profiles
   WHERE id = p_user_id;

  IF v_cipher IS NULL OR v_version IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public.decrypt_pii(v_cipher, v_version);
END;
$$;

REVOKE ALL ON FUNCTION public.profile_get_tax_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_get_tax_id(uuid)
  TO authenticated, service_role;


COMMENT ON FUNCTION public.profile_set_tax_id(uuid, text) IS
  'Encrypted write helper for profiles.tax_id. Self-write OR pii.profiles.tax_id.read required.';
COMMENT ON FUNCTION public.profile_get_tax_id(uuid) IS
  'Decrypted read helper for profiles.tax_id. Self-read OR pii.profiles.tax_id.read required.';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.profile_set_tax_id', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Encrypted write helper for profiles.tax_id (BIR TIN PII).',
   false),
  ('public.profile_get_tax_id', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Decrypted read helper for profiles.tax_id; self-read or permission-gated.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
