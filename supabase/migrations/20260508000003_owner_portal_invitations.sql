-- Owner Portal Invitations.
--
-- Mirror of 20260508000002 (tenant portal invitations) but binds the
-- auth user to property_owners(id) instead of lease_parties(id).
--
-- Once bound (property_owners.user_id = auth.uid()), the owner's
-- existing RLS surfaces "just work":
--   - property_owners_select   -> user_id = auth.uid()
--   - unit_owners_select       -> via property_owners
--   - owner_statements_select  -> via property_owners
--   - dues_schedules_select    -> via unit_owners → property_owners chain
--   - property_charges_select  -> billing_target='owner' branch via unit_owners
--
-- Existing surfaces preserved:
--   - property_owners, unit_owners, owner_statements    -- unchanged
--   - has_permission, governance_schema_contracts        -- unchanged
--   - hash_portal_token (from 20260508000002)            -- reused
--   - audit / notify                                     -- unchanged
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.revoke_owner_portal_invitation(uuid, text);
--   DROP FUNCTION IF EXISTS public.accept_owner_portal_invitation(text);
--   DROP FUNCTION IF EXISTS public.issue_owner_portal_invitation(uuid, text, text, int);
--   DROP TABLE IF EXISTS public.owner_portal_invitations;
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.owner_portal_invitations',
--      'public.accept_owner_portal_invitation',
--      'public.issue_owner_portal_invitation');


-- =====================================================================
-- 1. owner_portal_invitations — invite tokens (hashed)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.owner_portal_invitations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  property_owner_id        uuid NOT NULL
                                REFERENCES public.property_owners(id) ON DELETE CASCADE,

  -- sha256(token) base64, computed via the shared hash_portal_token().
  -- Cleartext is emailed to the owner once, never stored.
  token_hash               text NOT NULL UNIQUE,

  invite_email             text NOT NULL,

  expires_at               timestamptz NOT NULL DEFAULT (now() + interval '14 days'),

  accepted_at              timestamptz,
  accepted_by_user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  revoked_at               timestamptz,
  revoked_reason           text,

  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),

  CHECK (
    (accepted_at IS NULL AND accepted_by_user_id IS NULL)
    OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
  ),

  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS owner_portal_invitations_owner_idx
  ON public.owner_portal_invitations(property_owner_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS owner_portal_invitations_one_active_per_owner
  ON public.owner_portal_invitations(property_owner_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS owner_portal_invitations_accepted_idx
  ON public.owner_portal_invitations(accepted_by_user_id)
  WHERE accepted_by_user_id IS NOT NULL;

COMMENT ON TABLE public.owner_portal_invitations IS
  'Token-bearing invitations binding a property_owners row to a Supabase auth user. sha256-hashed tokens; single-use, expiring, revocable. Mirrors tenant_portal_invitations.';


-- =====================================================================
-- 2. issue_owner_portal_invitation — admin/manager issues an invite
-- =====================================================================

CREATE OR REPLACE FUNCTION public.issue_owner_portal_invitation(
  p_property_owner_id uuid,
  p_invite_email      text,
  p_token             text,
  p_expires_in_days   int DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_owner       record;
  v_invitation_id uuid;
  v_token_hash  text;
BEGIN
  IF NOT (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'issue_owner_portal_invitation: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF coalesce(trim(p_invite_email), '') = '' THEN
    RAISE EXCEPTION 'issue_owner_portal_invitation: invite_email is required';
  END IF;
  IF coalesce(trim(p_token), '') = '' OR length(p_token) < 32 THEN
    RAISE EXCEPTION 'issue_owner_portal_invitation: token must be >=32 chars';
  END IF;
  IF p_expires_in_days IS NULL OR p_expires_in_days < 1 OR p_expires_in_days > 90 THEN
    RAISE EXCEPTION 'issue_owner_portal_invitation: expires_in_days must be 1..90';
  END IF;

  SELECT id, user_id, external_email INTO v_owner
    FROM public.property_owners WHERE id = p_property_owner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue_owner_portal_invitation: property owner not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_owner.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'issue_owner_portal_invitation: owner is already bound to a user';
  END IF;

  v_token_hash := public.hash_portal_token(p_token);

  -- Auto-revoke any active invitation for this owner (one-active-per-owner
  -- partial UNIQUE would otherwise reject the insert).
  UPDATE public.owner_portal_invitations
     SET revoked_at = now(),
         revoked_reason = 'replaced_by_new_invitation'
   WHERE property_owner_id = p_property_owner_id
     AND accepted_at IS NULL
     AND revoked_at IS NULL;

  INSERT INTO public.owner_portal_invitations
    (property_owner_id, token_hash, invite_email, expires_at, created_by)
  VALUES
    (p_property_owner_id,
     v_token_hash,
     lower(trim(p_invite_email)),
     now() + make_interval(days => p_expires_in_days),
     auth.uid())
  RETURNING id INTO v_invitation_id;

  RETURN jsonb_build_object(
    'invitation_id', v_invitation_id,
    'property_owner_id', p_property_owner_id,
    'expires_at', now() + make_interval(days => p_expires_in_days),
    'invite_email', lower(trim(p_invite_email))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.issue_owner_portal_invitation(uuid, text, text, int)
  TO authenticated;


-- =====================================================================
-- 3. accept_owner_portal_invitation — public RPC, called from website
-- =====================================================================

CREATE OR REPLACE FUNCTION public.accept_owner_portal_invitation(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_invitation record;
  v_owner      record;
  v_token_hash text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'accept_owner_portal_invitation: not authenticated'
      USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(p_token), '') = '' THEN
    RAISE EXCEPTION 'accept_owner_portal_invitation: token required';
  END IF;

  v_token_hash := public.hash_portal_token(p_token);

  SELECT * INTO v_invitation
    FROM public.owner_portal_invitations
   WHERE token_hash = v_token_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.expires_at < now() THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.accepted_at IS NOT NULL THEN
    -- Idempotency: same user reapplying is a no-op success. Different
    -- user trying to claim an accepted invite gets the opaque error.
    IF v_invitation.accepted_by_user_id = auth.uid() THEN
      SELECT id INTO v_owner FROM public.property_owners
       WHERE id = v_invitation.property_owner_id;
      RETURN jsonb_build_object(
        'property_owner_id', v_owner.id,
        'already_accepted', true
      );
    ELSE
      RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  SELECT id, user_id INTO v_owner
    FROM public.property_owners
   WHERE id = v_invitation.property_owner_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;
  IF v_owner.user_id IS NOT NULL AND v_owner.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE = 'P0002';
  END IF;

  -- Bind. property_owners has a partial UNIQUE on user_id WHERE NOT NULL,
  -- so binding the same auth user twice would violate it; the
  -- (user_id IS NULL OR user_id = auth.uid()) guard prevents that path.
  UPDATE public.property_owners
     SET user_id = auth.uid()
   WHERE id = v_invitation.property_owner_id
     AND (user_id IS NULL OR user_id = auth.uid());

  UPDATE public.owner_portal_invitations
     SET accepted_at = now(),
         accepted_by_user_id = auth.uid()
   WHERE id = v_invitation.id;

  RETURN jsonb_build_object(
    'property_owner_id', v_owner.id,
    'already_accepted', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_owner_portal_invitation(text)
  TO authenticated;


-- =====================================================================
-- 4. revoke_owner_portal_invitation — admin/manager
-- =====================================================================

CREATE OR REPLACE FUNCTION public.revoke_owner_portal_invitation(
  p_invitation_id uuid,
  p_reason        text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_existing record;
BEGIN
  IF NOT (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'revoke_owner_portal_invitation: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'revoke_owner_portal_invitation: reason required';
  END IF;

  SELECT id, accepted_at, revoked_at INTO v_existing
    FROM public.owner_portal_invitations
   WHERE id = p_invitation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revoke_owner_portal_invitation: not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_existing.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'revoke_owner_portal_invitation: already accepted (cannot revoke)';
  END IF;
  IF v_existing.revoked_at IS NOT NULL THEN
    RETURN p_invitation_id;
  END IF;

  UPDATE public.owner_portal_invitations
     SET revoked_at = now(),
         revoked_reason = p_reason
   WHERE id = p_invitation_id;

  RETURN p_invitation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_owner_portal_invitation(uuid, text)
  TO authenticated;


-- =====================================================================
-- 5. RLS
-- =====================================================================

ALTER TABLE public.owner_portal_invitations ENABLE ROW LEVEL SECURITY;

-- Tenants of property_owners terminology = the bound user. They see
-- only invitations they accepted.
DROP POLICY IF EXISTS owner_portal_invitations_select ON public.owner_portal_invitations;
CREATE POLICY owner_portal_invitations_select
  ON public.owner_portal_invitations FOR SELECT
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
    OR accepted_by_user_id = auth.uid()
  );

DROP POLICY IF EXISTS owner_portal_invitations_modify ON public.owner_portal_invitations;
CREATE POLICY owner_portal_invitations_modify
  ON public.owner_portal_invitations FOR ALL
  TO authenticated
  USING (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('property.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 6. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.owner_portal_invitations', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Token-bearing invitations binding property_owners to auth users',
   false),
  ('public.accept_owner_portal_invitation', 'function', 'userportal',
   ARRAY['userportal', 'website']::text[],
   'RPC: owner exchanges cleartext invite token for property_owners.user_id binding',
   false),
  ('public.issue_owner_portal_invitation', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'RPC: admin/manager issues a new owner portal invitation',
   false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
