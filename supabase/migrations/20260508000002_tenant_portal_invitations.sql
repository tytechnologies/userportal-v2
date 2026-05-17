-- Tenant Portal Invitations.
--
-- Invitation pipeline that lets a property manager bind a
-- lease_parties row (role='tenant') to a real Supabase auth user via
-- a single-use, expiring, hash-stored token. The cleartext token is
-- emailed to the tenant; the website's /portal/accept-invite page
-- POSTs it back to accept_tenant_portal_invitation(token), which
-- (atomically, SECURITY DEFINER) sets lease_parties.user_id =
-- auth.uid() and stamps the invitation row.
--
-- Once bound, the tenant's existing RLS surfaces "just work":
--   - tenant_statements_select  -> EXISTS lease_parties WHERE user_id = auth.uid()
--   - property_charges_select   -> tenant branch on lease_parties + billing_target
--   - maintenance_requests      -> reported_by_user_id OR lease_parties match
--   - leases.lease_can_read     -> lease_parties.user_id = auth.uid()
--
-- Existing surfaces preserved:
--   - lease_parties, leases, profiles                  -- unchanged
--   - has_permission, governance_schema_contracts      -- unchanged
--   - audit / notify                                   -- unchanged
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.revoke_tenant_portal_invitation(uuid, text);
--   DROP FUNCTION IF EXISTS public.accept_tenant_portal_invitation(text);
--   DROP FUNCTION IF EXISTS public.issue_tenant_portal_invitation(uuid, text, text, int);
--   DROP FUNCTION IF EXISTS public.hash_portal_token(text);
--   DROP TABLE IF EXISTS public.tenant_portal_invitations;
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.tenant_portal_invitations',
--      'public.accept_tenant_portal_invitation',
--      'public.issue_tenant_portal_invitation');


-- =====================================================================
-- 0. Extension dependency
-- =====================================================================
-- pgcrypto provides digest() for sha256 hashing. On Supabase pgcrypto
-- installs into the `extensions` schema (not `public`), so functions
-- below that SET search_path must include it AND we schema-qualify
-- digest() defensively. The IF NOT EXISTS is a no-op on Supabase
-- projects where the extension is already enabled.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


-- =====================================================================
-- 1. tenant_portal_invitations — invite tokens (hashed)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.tenant_portal_invitations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  lease_party_id           uuid NOT NULL
                                REFERENCES public.lease_parties(id) ON DELETE CASCADE,

  -- sha256(token) base64. Cleartext is emailed to the tenant once and
  -- never stored anywhere persistent.
  token_hash               text NOT NULL UNIQUE,

  -- The address we mailed the invite to (may differ from the
  -- lease_parties.external_email we'd previously recorded — the operator
  -- can override at issue time).
  invite_email             text NOT NULL,

  expires_at               timestamptz NOT NULL DEFAULT (now() + interval '14 days'),

  accepted_at              timestamptz,
  accepted_by_user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  revoked_at               timestamptz,
  revoked_reason           text,

  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),

  -- Acceptance is paired: either both null or both set.
  CHECK (
    (accepted_at IS NULL AND accepted_by_user_id IS NULL)
    OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
  ),

  -- A row cannot be simultaneously accepted and revoked.
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS tenant_portal_invitations_party_idx
  ON public.tenant_portal_invitations(lease_party_id, created_at DESC);

-- One *active* invitation per lease party — protects against a flood
-- of duplicate emails and ambiguous accept-time resolution.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_portal_invitations_one_active_per_party
  ON public.tenant_portal_invitations(lease_party_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS tenant_portal_invitations_accepted_idx
  ON public.tenant_portal_invitations(accepted_by_user_id)
  WHERE accepted_by_user_id IS NOT NULL;

COMMENT ON TABLE public.tenant_portal_invitations IS
  'Token-bearing invitations that bind a lease_parties row (role=tenant) to a Supabase auth user. Cleartext token is emailed once, only the sha256 hash is stored. Single-use, expiring, revocable.';


-- =====================================================================
-- 2. hash_portal_token — deterministic token -> hash
-- =====================================================================

CREATE OR REPLACE FUNCTION public.hash_portal_token(p_token text)
RETURNS text
LANGUAGE sql
IMMUTABLE
-- extensions schema needed for pgcrypto digest() on Supabase. Also
-- schema-qualify the call below so this works even if a different
-- search_path is in effect at call time.
SET search_path = public, extensions
AS $$
  SELECT encode(extensions.digest(p_token::bytea, 'sha256'::text), 'base64');
$$;

COMMENT ON FUNCTION public.hash_portal_token(text) IS
  'sha256(p_token) base64. Used to look up tenant_portal_invitations by cleartext.';


-- =====================================================================
-- 3. issue_tenant_portal_invitation — admin/manager issues an invite
-- =====================================================================
--
-- Idempotent on the active-invite slot: if there's already an active
-- (non-accepted, non-revoked) invitation for this lease party, the
-- caller must revoke it first or pass p_replace=true to auto-revoke.
--
-- The cleartext token comes in as p_token so the caller (Nitro endpoint)
-- can return it to the operator UI for delivery. We hash + store; we
-- never log the cleartext.

CREATE OR REPLACE FUNCTION public.issue_tenant_portal_invitation(
  p_lease_party_id  uuid,
  p_invite_email    text,
  p_token           text,
  p_expires_in_days int DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_party       record;
  v_invitation_id uuid;
  v_token_hash  text;
BEGIN
  IF NOT (
    public.has_permission('leases.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'issue_tenant_portal_invitation: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF coalesce(trim(p_invite_email), '') = '' THEN
    RAISE EXCEPTION 'issue_tenant_portal_invitation: invite_email is required';
  END IF;
  IF coalesce(trim(p_token), '') = '' OR length(p_token) < 32 THEN
    RAISE EXCEPTION 'issue_tenant_portal_invitation: token must be >=32 chars';
  END IF;
  IF p_expires_in_days IS NULL OR p_expires_in_days < 1 OR p_expires_in_days > 90 THEN
    RAISE EXCEPTION 'issue_tenant_portal_invitation: expires_in_days must be 1..90';
  END IF;

  SELECT id, lease_id, role, user_id INTO v_party
    FROM public.lease_parties WHERE id = p_lease_party_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue_tenant_portal_invitation: lease party not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_party.role <> 'tenant' THEN
    RAISE EXCEPTION 'issue_tenant_portal_invitation: only tenant parties can be invited (got %)',
      v_party.role;
  END IF;
  IF v_party.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'issue_tenant_portal_invitation: party is already bound to a user';
  END IF;

  v_token_hash := public.hash_portal_token(p_token);

  -- Auto-revoke any active invitation for this party (one-active-per-party
  -- partial UNIQUE would otherwise reject the insert).
  UPDATE public.tenant_portal_invitations
     SET revoked_at = now(),
         revoked_reason = 'replaced_by_new_invitation'
   WHERE lease_party_id = p_lease_party_id
     AND accepted_at IS NULL
     AND revoked_at IS NULL;

  INSERT INTO public.tenant_portal_invitations
    (lease_party_id, token_hash, invite_email, expires_at, created_by)
  VALUES
    (p_lease_party_id,
     v_token_hash,
     lower(trim(p_invite_email)),
     now() + make_interval(days => p_expires_in_days),
     auth.uid())
  RETURNING id INTO v_invitation_id;

  RETURN jsonb_build_object(
    'invitation_id', v_invitation_id,
    'lease_party_id', p_lease_party_id,
    'expires_at', now() + make_interval(days => p_expires_in_days),
    'invite_email', lower(trim(p_invite_email))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.issue_tenant_portal_invitation(uuid, text, text, int)
  TO authenticated;


-- =====================================================================
-- 4. accept_tenant_portal_invitation — public RPC, called from website
-- =====================================================================
--
-- Called by the website's /portal/accept-invite page after the tenant
-- has signed in (or signed up + email-confirmed) via Supabase auth.
-- Atomically:
--   - validates token (hash match, not expired, not accepted, not revoked)
--   - validates lease_parties.user_id is unbound (or matches caller already)
--   - sets lease_parties.user_id := auth.uid()
--   - stamps tenant_portal_invitations.accepted_at + accepted_by_user_id
--
-- Returns the lease_id so the page can redirect to the dashboard.

CREATE OR REPLACE FUNCTION public.accept_tenant_portal_invitation(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation record;
  v_party      record;
  v_token_hash text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'accept_tenant_portal_invitation: not authenticated'
      USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(p_token), '') = '' THEN
    RAISE EXCEPTION 'accept_tenant_portal_invitation: token required';
  END IF;

  v_token_hash := public.hash_portal_token(p_token);

  SELECT * INTO v_invitation
    FROM public.tenant_portal_invitations
   WHERE token_hash = v_token_hash;
  IF NOT FOUND THEN
    -- Generic message — never echo whether the token shape is valid.
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.expires_at < now() THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.accepted_at IS NOT NULL THEN
    -- Idempotency: if the same user already accepted, return success;
    -- if a different user, refuse.
    IF v_invitation.accepted_by_user_id = auth.uid() THEN
      SELECT id, lease_id, role
        INTO v_party
        FROM public.lease_parties
       WHERE id = v_invitation.lease_party_id;
      RETURN jsonb_build_object(
        'lease_id', v_party.lease_id,
        'lease_party_id', v_party.id,
        'role', v_party.role,
        'already_accepted', true
      );
    ELSE
      RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  SELECT id, lease_id, role, user_id
    INTO v_party
    FROM public.lease_parties
   WHERE id = v_invitation.lease_party_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;
  IF v_party.user_id IS NOT NULL AND v_party.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;

  -- Bind the auth user to the lease party (no-op if already matching).
  UPDATE public.lease_parties
     SET user_id = auth.uid()
   WHERE id = v_invitation.lease_party_id
     AND (user_id IS NULL OR user_id = auth.uid());

  -- Stamp the invitation row.
  UPDATE public.tenant_portal_invitations
     SET accepted_at = now(),
         accepted_by_user_id = auth.uid()
   WHERE id = v_invitation.id;

  RETURN jsonb_build_object(
    'lease_id', v_party.lease_id,
    'lease_party_id', v_party.id,
    'role', v_party.role,
    'already_accepted', false
  );
END;
$$;

-- The website's anon Supabase client calls this RPC with the user's JWT
-- attached. SECURITY DEFINER + auth.uid() check inside is the boundary.
GRANT EXECUTE ON FUNCTION public.accept_tenant_portal_invitation(text)
  TO authenticated;


-- =====================================================================
-- 5. revoke_tenant_portal_invitation — admin/manager
-- =====================================================================

CREATE OR REPLACE FUNCTION public.revoke_tenant_portal_invitation(
  p_invitation_id uuid,
  p_reason        text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing record;
BEGIN
  IF NOT (
    public.has_permission('leases.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'revoke_tenant_portal_invitation: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'revoke_tenant_portal_invitation: reason required';
  END IF;

  SELECT id, accepted_at, revoked_at INTO v_existing
    FROM public.tenant_portal_invitations
   WHERE id = p_invitation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revoke_tenant_portal_invitation: not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_existing.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'revoke_tenant_portal_invitation: already accepted (cannot revoke)';
  END IF;
  IF v_existing.revoked_at IS NOT NULL THEN
    -- Idempotent.
    RETURN p_invitation_id;
  END IF;

  UPDATE public.tenant_portal_invitations
     SET revoked_at = now(),
         revoked_reason = p_reason
   WHERE id = p_invitation_id;

  RETURN p_invitation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_tenant_portal_invitation(uuid, text)
  TO authenticated;


-- =====================================================================
-- 6. RLS
-- =====================================================================

ALTER TABLE public.tenant_portal_invitations ENABLE ROW LEVEL SECURITY;

-- SELECT: admin/manager all; tenants see only invitations they accepted
-- (so they can show "you accepted this on X" in their portal). The
-- token_hash is intentionally exposed only to admins; tenants never see it.
DROP POLICY IF EXISTS tenant_portal_invitations_select ON public.tenant_portal_invitations;
CREATE POLICY tenant_portal_invitations_select
  ON public.tenant_portal_invitations FOR SELECT
  TO authenticated
  USING (
    public.has_permission('leases.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR accepted_by_user_id = auth.uid()
  );

-- INSERT / UPDATE / DELETE: only admin/manager via the RPCs. Direct
-- writes are blocked.
DROP POLICY IF EXISTS tenant_portal_invitations_modify ON public.tenant_portal_invitations;
CREATE POLICY tenant_portal_invitations_modify
  ON public.tenant_portal_invitations FOR ALL
  TO authenticated
  USING (
    public.has_permission('leases.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('leases.manage')
    OR public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 7. Schema governance — register cross-repo contracts
-- =====================================================================
--
-- The website (`websiteo/`) is a NEW consumer of the
-- accept_tenant_portal_invitation RPC and indirectly of lease_parties /
-- tenant_statements / property_charges / maintenance_requests via the
-- tenant's auth session. We register the table + the two RPCs that are
-- part of the public contract.
--
-- contract_type='function' for RPCs is supported by the registry
-- (the contract validator only enforces column shape on tables/views;
-- function rows track ownership + consumers without column checks).

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.tenant_portal_invitations', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Token-bearing invitations binding lease_parties.tenant to auth users',
   false),
  ('public.accept_tenant_portal_invitation', 'function', 'userportal',
   ARRAY['userportal', 'website']::text[],
   'RPC: tenant exchanges cleartext invite token for lease_parties.user_id binding',
   false),
  ('public.issue_tenant_portal_invitation', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'RPC: admin/manager issues a new tenant portal invitation',
   false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
