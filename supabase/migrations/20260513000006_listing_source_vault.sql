-- Vault-store listing_sources.ingest_secret.
--
-- Mig 506000013 created public.listing_sources with a plaintext
-- `ingest_secret text` column. Any authenticated user with admin RLS
-- access (or anyone who can query the table at all under the existing
-- SELECT-to-authenticated policy) can read every partner's bearer
-- secret. The audit Phase 1 P1 #11 flagged this as the highest-leverage
-- security hardening before opening partner onboarding.
--
-- This migration moves secrets into Supabase Vault. Vault encrypts
-- secrets at rest with a per-project root key; the only way to read
-- them is via SECURITY DEFINER functions that pull from
-- vault.decrypted_secrets.
--
-- ADDITIVE on schema:
--   - listing_sources.ingest_secret_vault_id uuid  (new, nullable)
--   - listing_sources.ingest_secret stays in place during a transition
--     window. After all sources are migrated, ops drops the column
--     (separate migration, requires explicit operator sign-off).
--
-- ADDITIVE on RPCs:
--   - get_listing_source_secret(p_slug text)
--       Returns the decrypted secret for a source by slug. Reads
--       from vault when vault_id is set; falls back to the plaintext
--       column for un-migrated sources. service_role only.
--   - migrate_listing_source_to_vault(p_source_id bigint)
--       One-shot per source: takes the current plaintext secret,
--       creates a vault entry, sets ingest_secret_vault_id, NULLs
--       the plaintext column. Idempotent — already-migrated source
--       returns the vault id unchanged. admin only.
--   - rotate_listing_source_secret(p_id bigint)
--       REPLACES the existing rotate body from mig 506000014. Same
--       signature, same gating (has_permission('sources.manage'));
--       only the body changes — the new secret lands in vault and
--       the plaintext column is NULLed. Returns the new secret ONCE
--       for operator handoff; not recoverable later.
--
-- Why slug not id on the read RPC: the ingest endpoint receives the
-- source via body.source_slug; switching to id-keyed lookup would
-- require an extra round trip just to resolve the slug first.
--
-- Reference schema untouched (listing_sources is post-MySQL).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.rotate_listing_source_secret(bigint);
--   DROP FUNCTION IF EXISTS public.migrate_listing_source_to_vault(bigint);
--   DROP FUNCTION IF EXISTS public.get_listing_source_secret(text);
--   ALTER TABLE public.listing_sources DROP COLUMN IF EXISTS ingest_secret_vault_id;
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN (
--     'public.get_listing_source_secret',
--     'public.migrate_listing_source_to_vault',
--     'public.rotate_listing_source_secret'
--   );
--   -- Manually clean up vault entries if desired:
--   --   SELECT vault.delete_secret(id) FROM vault.secrets WHERE name LIKE 'listing_source_%';


-- =====================================================================
-- 0. Preconditions — Vault MUST be installed.
-- =====================================================================
-- Vault is bundled with Supabase Cloud + most self-hosted installs.
-- Soft-fail with a clear message if it's missing rather than half-
-- applying the migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
    RAISE EXCEPTION
      'Migration 20260513000006 requires the supabase_vault extension. Install: CREATE EXTENSION IF NOT EXISTS supabase_vault;'
      USING ERRCODE = '42704';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='listing_sources') THEN
    RAISE EXCEPTION
      'Migration 20260513000006 requires public.listing_sources (mig 506000013).'
      USING ERRCODE = '42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. listing_sources.ingest_secret_vault_id
-- =====================================================================
-- Nullable so existing rows are unaffected. Migration to vault is
-- per-source via migrate_listing_source_to_vault; column starts NULL.

ALTER TABLE public.listing_sources
  ADD COLUMN IF NOT EXISTS ingest_secret_vault_id uuid;

COMMENT ON COLUMN public.listing_sources.ingest_secret_vault_id IS
  'When NOT NULL, the bearer secret lives in vault.secrets keyed by this id. plaintext ingest_secret column is then ignored. Use migrate_listing_source_to_vault() to flip a source onto the vault path; use rotate_listing_source_secret() to roll the secret.';


-- =====================================================================
-- 2. get_listing_source_secret — resolver
-- =====================================================================
-- Returns the decrypted secret for a source identified by slug.
-- Read path:
--   - If ingest_secret_vault_id IS NOT NULL → vault.decrypted_secrets
--   - Else → ingest_secret plaintext (legacy path)
--   - Source not found / disabled / no secret set anywhere → NULL
--
-- service_role only. The ingest endpoint must call this via a
-- service-role-scoped Supabase client (see
-- server/api/admin/listings/ingest.post.ts).

CREATE OR REPLACE FUNCTION public.get_listing_source_secret(p_slug text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_source       record;
  v_vault_secret text;
BEGIN
  -- Caller gate. Cron isn't expected to call this directly; only the
  -- Nitro auth path. The escape for the SQL editor smoke test is
  -- preserved per feedback_security_definer_smoke_tests.
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: get_listing_source_secret is service-role / admin only'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, slug, enabled, ingest_secret, ingest_secret_vault_id
    INTO v_source
    FROM public.listing_sources
   WHERE slug = p_slug
   LIMIT 1;

  IF v_source IS NULL OR v_source.enabled = false THEN
    RETURN NULL;
  END IF;

  IF v_source.ingest_secret_vault_id IS NOT NULL THEN
    -- Vault path. NULL result means the vault entry was deleted but
    -- the reference wasn't cleaned up — surface as "secret not set"
    -- so the caller returns 401.
    SELECT decrypted_secret INTO v_vault_secret
      FROM vault.decrypted_secrets
     WHERE id = v_source.ingest_secret_vault_id
     LIMIT 1;
    RETURN v_vault_secret;
  END IF;

  -- Legacy path — plaintext column. Returns NULL if column is empty
  -- (operator should rotate before re-enabling the source).
  RETURN nullif(v_source.ingest_secret, '');
END;
$$;

REVOKE ALL ON FUNCTION public.get_listing_source_secret(text) FROM PUBLIC;
-- service_role only. authenticated users do NOT get execute — secrets
-- never leak through PostgREST. The Nitro server invokes via service-role.
GRANT EXECUTE ON FUNCTION public.get_listing_source_secret(text) TO service_role;

COMMENT ON FUNCTION public.get_listing_source_secret(text) IS
  'Secret resolver for partner ingest auth. Reads from vault when ingest_secret_vault_id is set; falls back to plaintext column. service_role only.';


-- =====================================================================
-- 3. migrate_listing_source_to_vault — one-shot per source
-- =====================================================================
-- Takes the source's current plaintext ingest_secret, stores it in
-- vault, sets ingest_secret_vault_id, NULLs the plaintext column.
-- Idempotent: if already migrated, returns the existing vault_id
-- without doing anything else. RAISES if no secret to migrate.

CREATE OR REPLACE FUNCTION public.migrate_listing_source_to_vault(p_source_id bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_source    record;
  v_vault_id  uuid;
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: migrate_listing_source_to_vault is admin only'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, slug, ingest_secret, ingest_secret_vault_id
    INTO v_source
    FROM public.listing_sources
   WHERE id = p_source_id
     FOR UPDATE;

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'listing source % not found', p_source_id USING ERRCODE = '42704';
  END IF;

  IF v_source.ingest_secret_vault_id IS NOT NULL THEN
    -- Already migrated. Return existing vault id.
    RETURN v_source.ingest_secret_vault_id;
  END IF;

  IF v_source.ingest_secret IS NULL OR v_source.ingest_secret = '' THEN
    RAISE EXCEPTION 'listing source % has no plaintext secret to migrate; use rotate_listing_source_secret instead', p_source_id
      USING ERRCODE = '22023';
  END IF;

  -- Store in vault under a deterministic name so operators can find
  -- the entry via vault.secrets if needed. Name uniqueness isn't
  -- required by vault, but using a stable convention helps audit.
  v_vault_id := vault.create_secret(
    v_source.ingest_secret,
    'listing_source_' || v_source.slug,
    'Bearer secret for /api/admin/listings/ingest. Source id=' || v_source.id
  );

  UPDATE public.listing_sources
     SET ingest_secret_vault_id = v_vault_id,
         ingest_secret          = NULL,            -- clear plaintext
         updated_at             = now()
   WHERE id = v_source.id;

  RETURN v_vault_id;
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_listing_source_to_vault(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_listing_source_to_vault(bigint)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.migrate_listing_source_to_vault(bigint) IS
  'Idempotent one-shot: moves a source''s plaintext ingest_secret into vault, sets ingest_secret_vault_id, NULLs the plaintext column. Admin-only.';


-- =====================================================================
-- 4. rotate_listing_source_secret — generate + store + return
-- =====================================================================
-- Atomic rotation. Generates a fresh 32-byte hex secret, stores it
-- in vault (creating a new vault entry; old one is deleted only by
-- explicit operator action), updates listing_sources.ingest_secret_vault_id.
-- Returns the new secret as a single value — the operator MUST capture
-- it on this call. Subsequent reads through get_listing_source_secret
-- will work, but the operator can never recover the plaintext through
-- this function again.

-- Parameter name MUST stay `p_id` to match mig 506000014's signature;
-- Postgres rejects renaming an input parameter via CREATE OR REPLACE
-- (42P13). Gating reuses 'sources.manage' for the same reason — all
-- existing callers expect that permission contract.
CREATE OR REPLACE FUNCTION public.rotate_listing_source_secret(p_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_source     record;
  v_new_secret text;
  v_new_vault_id uuid;
BEGIN
  IF NOT (
    session_user IN ('postgres', 'supabase_admin', 'service_role')
    OR public.has_permission('sources.manage')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions to rotate listing source secret'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, slug, ingest_secret_vault_id
    INTO v_source
    FROM public.listing_sources
   WHERE id = p_id
     FOR UPDATE;

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'listing_sources.id % not found', p_id USING ERRCODE = 'P0002';
  END IF;

  -- Generate a fresh secret. Same shape as the column default in mig
  -- 506000013: 32 bytes encoded hex → 64 char string.
  -- extensions.gen_random_bytes is the pgcrypto variant per
  -- feedback_supabase_pgcrypto_search_path.
  v_new_secret := encode(extensions.gen_random_bytes(32), 'hex');

  -- Create a NEW vault entry. Old one (if any) is left in place;
  -- ops can delete via vault.delete_secret() once the rotation is
  -- confirmed propagated.
  v_new_vault_id := vault.create_secret(
    v_new_secret,
    'listing_source_' || v_source.slug || '_' || to_char(now(), 'YYYYMMDD_HH24MISS'),
    'Rotated ' || now()::text || ' for source id=' || v_source.id
  );

  UPDATE public.listing_sources
     SET ingest_secret_vault_id = v_new_vault_id,
         ingest_secret          = NULL,         -- vault is canonical now
         updated_at             = now()
   WHERE id = v_source.id;

  RETURN v_new_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_listing_source_secret(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rotate_listing_source_secret(bigint)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.rotate_listing_source_secret(bigint) IS
  'Generates a fresh 32-byte hex bearer, stores in vault, swaps ingest_secret_vault_id. Returns the new secret ONCE — operator must capture. Gated by sources.manage (matches mig 506000014).';


-- =====================================================================
-- 5. Governance
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RETURN;
  END IF;
  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('public.get_listing_source_secret',  'function', 'userportal', ARRAY['userportal'],
     'Secret resolver for partner ingest auth. Reads from vault when ingest_secret_vault_id set; falls back to plaintext column. service_role only.', false),
    ('public.migrate_listing_source_to_vault', 'function', 'userportal', ARRAY['userportal'],
     'Idempotent one-shot migration of a source''s plaintext secret into vault. Admin-only.', false),
    ('public.rotate_listing_source_secret', 'function', 'userportal', ARRAY['userportal'],
     'Generates + vault-stores + returns a fresh bearer for a source. Admin-only; secret returned once.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
--
-- 1) Vault extension is alive.
-- SELECT extname, extversion FROM pg_extension WHERE extname = 'supabase_vault';
--
-- 2) Pick one source and migrate to vault.
-- SELECT public.migrate_listing_source_to_vault(
--   (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1)
-- ) AS new_vault_id;
--
-- 3) Confirm the column is set + plaintext cleared.
-- SELECT id, slug, ingest_secret IS NULL AS plaintext_cleared,
--        ingest_secret_vault_id IS NOT NULL AS vault_set
--   FROM public.listing_sources
--  ORDER BY id LIMIT 5;
--
-- 4) Read the secret via the resolver.
-- SELECT public.get_listing_source_secret(
--   (SELECT slug FROM public.listing_sources ORDER BY id LIMIT 1)
-- );
--
-- 5) Rotate that source's secret. CAPTURE THE RETURN VALUE — operator
--    must give this to the partner; it is not recoverable.
-- SELECT public.rotate_listing_source_secret(
--   (SELECT id FROM public.listing_sources ORDER BY id LIMIT 1)
-- ) AS new_bearer;
--
-- 6) Confirm the resolver returns the rotated value.
-- SELECT public.get_listing_source_secret(
--   (SELECT slug FROM public.listing_sources ORDER BY id LIMIT 1)
-- ) AS current_bearer;
