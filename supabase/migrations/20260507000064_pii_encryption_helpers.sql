-- PII encryption helpers (foundation only).
--
-- Phase E foundation. Provides SECURITY DEFINER helpers for symmetric
-- encryption of sensitive columns at the application layer. NO existing
-- columns are migrated by this file — that requires per-column review,
-- backfill plan, and downstream consumer updates which would each be
-- their own migration.
--
-- Threat model addressed:
--   * DB-at-rest dump leakage: encrypted columns are unreadable without
--     the active key.
--   * Internal least-privilege: helpers are SECURITY DEFINER so callers
--     never see the raw key, even via session settings.
--
-- Threat model NOT addressed:
--   * Live SQL injection on a logged-in service-role session — that has
--     decrypt rights by design.
--   * App-server compromise — the key sits in Postgres GUC, accessible
--     to anyone who can run SQL as service_role.
--   * Key rotation — `pii_encryption_key_version` is recorded alongside
--     each encrypted value so future re-encryption knows which key was used.
--
-- Setup (run BEFORE encrypting any column):
--   ALTER DATABASE postgres SET app.pii_encryption_key_v1 = '<random 32+ char string>';
--   ALTER DATABASE postgres SET app.pii_encryption_active_version = '1';
--   -- then disconnect/reconnect service_role for it to load the GUC.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.encrypt_pii(text);
--   DROP FUNCTION IF EXISTS public.decrypt_pii(bytea, integer);
--   DROP FUNCTION IF EXISTS public.pii_active_key_version();
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.encrypt_pii';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.decrypt_pii';

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- Reads the configured active key version from GUC. Returns NULL if
-- not configured (so callers can fall back to plaintext during dev).
CREATE OR REPLACE FUNCTION public.pii_active_key_version()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw text;
BEGIN
  v_raw := current_setting('app.pii_encryption_active_version', true);
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_raw::integer;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.pii_active_key_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pii_active_key_version() TO authenticated, service_role;


-- Internal helper: load a specific key version from GUC.
CREATE OR REPLACE FUNCTION public._pii_key_for_version(p_version integer)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_setting text;
  v_key     text;
BEGIN
  IF p_version IS NULL THEN
    RAISE EXCEPTION 'pii key version is required';
  END IF;
  v_setting := format('app.pii_encryption_key_v%s', p_version);
  v_key := current_setting(v_setting, true);
  IF v_key IS NULL OR length(v_key) < 16 THEN
    RAISE EXCEPTION 'pii encryption key v% is not configured (need >= 16 chars)', p_version;
  END IF;
  RETURN v_key;
END;
$$;

REVOKE ALL ON FUNCTION public._pii_key_for_version(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._pii_key_for_version(integer) TO service_role;


-- Public encrypt helper. Uses the active key version. Returns bytea
-- payload that includes pgcrypto's own version + IV. Callers should
-- also store pii_active_key_version() alongside so they know which
-- key to use for decryption later.
CREATE OR REPLACE FUNCTION public.encrypt_pii(p_plaintext text)
RETURNS bytea
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version integer;
  v_key     text;
BEGIN
  IF p_plaintext IS NULL THEN
    RETURN NULL;
  END IF;
  v_version := public.pii_active_key_version();
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'pii encryption is not configured (set app.pii_encryption_active_version)';
  END IF;
  v_key := public._pii_key_for_version(v_version);
  RETURN pgp_sym_encrypt(p_plaintext, v_key);
END;
$$;

REVOKE ALL ON FUNCTION public.encrypt_pii(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.encrypt_pii(text) TO authenticated, service_role;


-- Public decrypt helper. Caller passes the encrypted blob and the
-- key version that was active when it was encrypted (read from the
-- companion *_key_version column).
CREATE OR REPLACE FUNCTION public.decrypt_pii(p_ciphertext bytea, p_version integer)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  IF p_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_version IS NULL THEN
    RAISE EXCEPTION 'decrypt_pii requires the key version the value was encrypted with';
  END IF;
  v_key := public._pii_key_for_version(p_version);
  RETURN pgp_sym_decrypt(p_ciphertext, v_key);
EXCEPTION WHEN others THEN
  -- Surface the failure but do not leak the key path / GUC name.
  RAISE EXCEPTION 'decrypt_pii failed for key version %: %', p_version, SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.decrypt_pii(bytea, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decrypt_pii(bytea, integer) TO authenticated, service_role;


COMMENT ON FUNCTION public.encrypt_pii(text) IS
  'Symmetric encrypt using the active PII key. Companion column should store pii_active_key_version() alongside.';
COMMENT ON FUNCTION public.decrypt_pii(bytea, integer) IS
  'Symmetric decrypt using the named PII key version. Caller must read the version from the companion column.';
COMMENT ON FUNCTION public.pii_active_key_version() IS
  'Returns the key version operators have marked active. NULL if encryption is not configured.';


-- =====================================================================
-- Schema governance — register the helper contracts so other repos
-- can find / depend on them.
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.encrypt_pii', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Symmetric PII encrypt. Returns bytea. Pair with pii_active_key_version().',
   false),
  ('public.decrypt_pii', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Symmetric PII decrypt. Caller must supply the key version the value was encrypted with.',
   false),
  ('public.pii_active_key_version', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Returns the active key version (integer) or NULL if encryption is not configured.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- Smoke test (idempotent — run from SQL editor)
-- =====================================================================
DO $$
DECLARE
  v_active integer;
BEGIN
  v_active := public.pii_active_key_version();
  IF v_active IS NULL THEN
    RAISE NOTICE 'PII encryption: not configured (helpers installed, key/version GUC missing). This is expected on first deploy.';
  ELSE
    RAISE NOTICE 'PII encryption: active key version %', v_active;
  END IF;
END $$;


NOTIFY pgrst, 'reload schema';
