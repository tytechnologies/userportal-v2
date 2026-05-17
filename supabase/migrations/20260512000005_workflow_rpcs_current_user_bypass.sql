-- Workflow RPCs: extend bypass check to current_user.
--
-- Caught by scripts/test-workflow-rpcs.mjs against a live DB. Under
-- PostgREST the connecting role is `authenticator` (=> session_user),
-- and the JWT role is activated via SET LOCAL ROLE — visible only as
-- current_user. For service-role calls (admin scripts, cron, the
-- workflow test suite) the existing
--   session_user IN ('postgres','supabase_admin','service_role')
-- check NEVER fires, falls through to deal_can_write(p_deal_id), and
-- denies because auth.uid() is NULL.
--
-- Fix: also allow current_user IN (...). Keeps authenticated user
-- calls working (they hit deal_can_write first); enables service-role
-- callers cleanly. Identical RPC bodies otherwise — only the bypass
-- predicate changes.
--
-- ROLLBACK: re-apply 20260512000004_deal_workflows_rpcs.sql.


-- =====================================================================
-- 1. deal_workflow_start
-- =====================================================================
CREATE OR REPLACE FUNCTION public.deal_workflow_start(
  p_deal_id      uuid,
  p_template_key text,
  p_title_branch text,
  p_started_via  text,
  p_envelope_id  uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template      record;
  v_workflow_id   uuid;
  v_first_step_id uuid;
  v_step_count    int;
BEGIN
  IF NOT (
    public.deal_can_write(p_deal_id)
    OR current_user IN ('postgres','supabase_admin','service_role')
    OR session_user IN ('postgres','supabase_admin','service_role')
  ) THEN
    RAISE EXCEPTION 'deal_workflow_start: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_started_via NOT IN ('envelope_auto','manual') THEN
    RAISE EXCEPTION 'deal_workflow_start: invalid started_via %', p_started_via;
  END IF;

  IF p_title_branch IS NOT NULL AND p_title_branch NOT IN ('condo','land') THEN
    RAISE EXCEPTION 'deal_workflow_start: invalid title_branch %', p_title_branch;
  END IF;

  IF EXISTS (SELECT 1 FROM public.deal_workflows WHERE deal_id = p_deal_id) THEN
    RAISE EXCEPTION 'deal_workflow_start: workflow already exists for this deal'
      USING ERRCODE = '23505';
  END IF;

  SELECT id, key, applies_to, active INTO v_template
    FROM public.workflow_templates WHERE key = p_template_key;
  IF NOT FOUND OR v_template.active = false THEN
    RAISE EXCEPTION 'deal_workflow_start: template % not found or not active', p_template_key
      USING ERRCODE = 'P0002';
  END IF;

  IF v_template.applies_to = 'sale' AND p_title_branch IS NULL THEN
    RAISE EXCEPTION 'deal_workflow_start: sale workflows require title_branch (condo|land)';
  END IF;
  IF v_template.applies_to = 'lease' AND p_title_branch IS NOT NULL THEN
    RAISE EXCEPTION 'deal_workflow_start: lease workflows do not take a title_branch';
  END IF;

  INSERT INTO public.deal_workflows
    (deal_id, template_id, template_key, title_branch, status,
     started_via, envelope_id, started_by, started_at)
  VALUES
    (p_deal_id, v_template.id, p_template_key, p_title_branch, 'active',
     p_started_via, p_envelope_id, auth.uid(), now())
  RETURNING id INTO v_workflow_id;

  INSERT INTO public.deal_workflow_steps
    (workflow_id, step_index, key, title, description, phase, attestation_text,
     status, skip_reason)
  SELECT
    v_workflow_id,
    ts.step_index,
    ts.key,
    ts.title,
    ts.description,
    ts.phase,
    ts.attestation_text,
    CASE
      WHEN ts.branch = 'always'                                        THEN 'locked'
      WHEN ts.branch = 'condo_only' AND p_title_branch = 'condo'       THEN 'locked'
      WHEN ts.branch = 'land_only'  AND p_title_branch = 'land'        THEN 'locked'
      ELSE 'skipped'
    END,
    CASE
      WHEN ts.branch = 'condo_only' AND p_title_branch <> 'condo'
        THEN 'title_branch=' || coalesce(p_title_branch,'NULL') || '; step requires condo'
      WHEN ts.branch = 'land_only'  AND p_title_branch <> 'land'
        THEN 'title_branch=' || coalesce(p_title_branch,'NULL') || '; step requires land'
      ELSE NULL
    END
  FROM public.workflow_template_steps ts
  WHERE ts.template_id = v_template.id
  ORDER BY ts.step_index;

  UPDATE public.deal_workflow_steps
     SET status = 'active'
   WHERE id = (
     SELECT id FROM public.deal_workflow_steps
      WHERE workflow_id = v_workflow_id
        AND status = 'locked'
      ORDER BY step_index ASC
      LIMIT 1
   )
  RETURNING id INTO v_first_step_id;

  IF v_first_step_id IS NULL THEN
    UPDATE public.deal_workflows
       SET status='completed', completed_at=now()
     WHERE id = v_workflow_id;
  ELSE
    UPDATE public.deal_workflows
       SET current_step_id = v_first_step_id
     WHERE id = v_workflow_id;
  END IF;

  SELECT count(*) INTO v_step_count
    FROM public.deal_workflow_steps WHERE workflow_id = v_workflow_id;

  PERFORM public.log_activity(
    'deal_workflow_started',
    'deal',
    p_deal_id,
    jsonb_build_object(
      'workflow_id',   v_workflow_id,
      'template_key',  p_template_key,
      'title_branch',  p_title_branch,
      'started_via',   p_started_via,
      'envelope_id',   p_envelope_id,
      'step_count',    v_step_count
    )
  );

  RETURN v_workflow_id;
END;
$$;


-- =====================================================================
-- 2. deal_workflow_advance
-- =====================================================================
CREATE OR REPLACE FUNCTION public.deal_workflow_advance(
  p_step_id               uuid,
  p_document_id           uuid,
  p_attestation_signature text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_step       record;
  v_workflow   record;
  v_next_id    uuid;
  v_completed_at timestamptz := now();
BEGIN
  SELECT s.*, w.deal_id AS w_deal_id, w.status AS w_status, w.id AS w_id
    INTO v_step
  FROM public.deal_workflow_steps s
  JOIN public.deal_workflows w ON w.id = s.workflow_id
  WHERE s.id = p_step_id
  FOR UPDATE OF w;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal_workflow_advance: step % not found', p_step_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.deal_can_write(v_step.w_deal_id)
    OR current_user IN ('postgres','supabase_admin','service_role')
    OR session_user IN ('postgres','supabase_admin','service_role')
  ) THEN
    RAISE EXCEPTION 'deal_workflow_advance: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF v_step.w_status <> 'active' THEN
    RAISE EXCEPTION 'deal_workflow_advance: workflow is %, cannot advance', v_step.w_status;
  END IF;

  IF v_step.status <> 'active' THEN
    RAISE EXCEPTION 'deal_workflow_advance: step is %, only active steps can advance', v_step.status;
  END IF;

  IF coalesce(p_attestation_signature,'') = '' THEN
    RAISE EXCEPTION 'deal_workflow_advance: attestation_signature is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.documents
     WHERE id = p_document_id AND deal_id = v_step.w_deal_id
  ) THEN
    RAISE EXCEPTION 'deal_workflow_advance: document does not belong to this deal';
  END IF;

  UPDATE public.deal_workflow_steps
     SET status                = 'completed',
         document_id           = p_document_id,
         attested_at           = v_completed_at,
         attested_by           = auth.uid(),
         attestation_signature = p_attestation_signature,
         completed_at          = v_completed_at
   WHERE id = p_step_id;

  SELECT id INTO v_next_id
  FROM public.deal_workflow_steps
  WHERE workflow_id = v_step.workflow_id
    AND status = 'locked'
    AND step_index > v_step.step_index
  ORDER BY step_index ASC
  LIMIT 1;

  IF v_next_id IS NULL THEN
    UPDATE public.deal_workflows
       SET status='completed',
           current_step_id=NULL,
           completed_at=v_completed_at
     WHERE id = v_step.workflow_id;

    PERFORM public.log_activity(
      'deal_workflow_completed',
      'deal',
      v_step.w_deal_id,
      jsonb_build_object(
        'workflow_id', v_step.workflow_id,
        'completed_at', v_completed_at,
        'final_step_key', v_step.key
      )
    );
    RETURN NULL;
  END IF;

  UPDATE public.deal_workflow_steps
     SET status = 'active'
   WHERE id = v_next_id;

  UPDATE public.deal_workflows
     SET current_step_id = v_next_id
   WHERE id = v_step.workflow_id;

  PERFORM public.log_activity(
    'deal_workflow_step_completed',
    'deal',
    v_step.w_deal_id,
    jsonb_build_object(
      'workflow_id',         v_step.workflow_id,
      'completed_step_key',  v_step.key,
      'next_step_id',        v_next_id,
      'step_index',          v_step.step_index
    )
  );

  RETURN v_next_id;
END;
$$;


-- =====================================================================
-- 3. deal_workflow_abandon
-- =====================================================================
CREATE OR REPLACE FUNCTION public.deal_workflow_abandon(
  p_workflow_id uuid,
  p_reason      text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workflow record;
  v_active_step record;
BEGIN
  SELECT * INTO v_workflow FROM public.deal_workflows WHERE id = p_workflow_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal_workflow_abandon: workflow % not found', p_workflow_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.deal_can_write(v_workflow.deal_id)
    OR public.has_permission('deal_workflows.abandon')
    OR current_user IN ('postgres','supabase_admin','service_role')
    OR session_user IN ('postgres','supabase_admin','service_role')
  ) THEN
    RAISE EXCEPTION 'deal_workflow_abandon: permission denied'
      USING ERRCODE = '42501';
  END IF;

  IF v_workflow.status IN ('completed','abandoned') THEN
    RAISE EXCEPTION 'deal_workflow_abandon: workflow is in terminal status %', v_workflow.status;
  END IF;

  IF coalesce(p_reason,'') = '' THEN
    RAISE EXCEPTION 'deal_workflow_abandon: reason is required';
  END IF;

  SELECT step_index, key INTO v_active_step
    FROM public.deal_workflow_steps
   WHERE id = v_workflow.current_step_id;

  UPDATE public.deal_workflows
     SET status='abandoned',
         abandoned_at=now(),
         abandon_reason=p_reason
   WHERE id = p_workflow_id;

  PERFORM public.log_activity(
    'deal_workflow_abandoned',
    'deal',
    v_workflow.deal_id,
    jsonb_build_object(
      'workflow_id', p_workflow_id,
      'reason', p_reason,
      'abandoned_at_step_index', v_active_step.step_index,
      'abandoned_at_step_key',   v_active_step.key
    )
  );

  RETURN p_workflow_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
