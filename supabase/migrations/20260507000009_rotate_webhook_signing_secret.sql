-- Rotate the signing_secret of a webhook subscription.
--
-- WHY:
-- Partners occasionally need a fresh secret — leak suspicion, key
-- rotation policy, partner-end key compromise. The migration that
-- created webhook_subscriptions (20260507000002) used
-- `gen_random_bytes(32)` as the column DEFAULT. This RPC reuses the
-- same primitive so rotated secrets share entropy / format with the
-- originals.
--
-- The RPC returns the new secret in its response body. This is the
-- one and only time the value comes back to the application — the
-- list endpoint deliberately excludes signing_secret from its column
-- allowlist, so admins must capture it during the rotation flow.
--
-- Permission gate uses the same ops-bypass pattern as the legacy
-- reconcile + data-health RPCs (memory: feedback_security_definer_smoke_tests).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.rotate_webhook_signing_secret(uuid);

CREATE OR REPLACE FUNCTION public.rotate_webhook_signing_secret(
  p_subscription_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_secret text;
  v_display_name text;
  v_url_host text;
BEGIN
  IF NOT (
    public.has_permission('webhooks.manage')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: webhooks.manage required'
      USING ERRCODE = '42501';
  END IF;

  -- 32 random bytes → 64 hex chars. Matches the column DEFAULT.
  v_new_secret := encode(gen_random_bytes(32), 'hex');

  UPDATE public.webhook_subscriptions
     SET signing_secret = v_new_secret,
         -- Reset failure counter — partner is about to start
         -- verifying against a different key. Keeping the old
         -- counter would auto-disable a healthy partner mid-rotation.
         consecutive_failures = 0,
         updated_at = now()
   WHERE id = p_subscription_id
   RETURNING display_name, url
   INTO v_display_name, v_url_host;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription not found: %', p_subscription_id
      USING ERRCODE = 'P0002';
  END IF;

  -- log_activity records the rotation. Don't include the secret in
  -- metadata — it'd land in the activities table and we don't want
  -- a second copy of a sensitive value sitting in the audit log.
  PERFORM public.log_activity(
    p_action    := 'webhook.subscribed',
    p_entity    := 'webhook',
    p_entity_id := p_subscription_id,
    p_metadata  := jsonb_build_object(
      'op', 'rotated_secret',
      'display_name', v_display_name,
      'url_host', split_part(replace(replace(v_url_host, 'https://', ''), 'http://', ''), '/', 1)
    )
  );

  RETURN jsonb_build_object(
    'subscription_id', p_subscription_id,
    'signing_secret',  v_new_secret,
    'rotated_at',      now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_webhook_signing_secret(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rotate_webhook_signing_secret(uuid) TO authenticated;

COMMENT ON FUNCTION public.rotate_webhook_signing_secret(uuid) IS
  'Admin-only RPC. Regenerates a webhook subscription signing secret using gen_random_bytes(32) (same primitive as the column DEFAULT), resets consecutive_failures to 0, audits via log_activity. Returns the new secret ONCE — list endpoint never echoes it again.';


NOTIFY pgrst, 'reload schema';
