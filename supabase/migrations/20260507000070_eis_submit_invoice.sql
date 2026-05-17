-- EIS submission generator.
--
-- submit_invoice_to_eis(p_invoice_id) builds the canonical EIS
-- payload from an invoice and writes a queued eis_submissions row.
-- The submitter worker (api/internal/eis-submitter-tick) then POSTs
-- queued rows to BIR's EIS sandbox.
--
-- Idempotency:
--   * One queued submission per invoice. Re-submission requires
--     the prior row to have terminal status (rejected | cancelled),
--     OR the caller passes p_resubmit=true to override.
--   * Function will refuse to submit a draft / void invoice — only
--     'open' and 'paid' invoices are eligible.
--
-- Payload shape (frozen at submission-time; mirrored from BIR's
-- expected EIS document JSON):
--   {
--     document_kind: 'sales_invoice',
--     invoice: { id, invoice_no, currency, subtotal_minor,
--                tax_minor, total_minor, issued_at, period_start,
--                period_end, line_items },
--     supplier: { tin, name },        -- platform org's TIN
--     customer: { id, name, tin, address }
--   }
-- Subject to BIR schema updates; treat the payload as snapshot,
-- not contract.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.submit_invoice_to_eis(uuid, boolean);
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.submit_invoice_to_eis';

CREATE OR REPLACE FUNCTION public.submit_invoice_to_eis(
  p_invoice_id uuid,
  p_resubmit   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice    record;
  v_org        record;
  v_existing   record;
  v_payload    jsonb;
  v_id         uuid;
BEGIN
  -- Permission gate.
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSIF NOT (
    public.has_permission('bir_reports.manage')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: requires bir_reports.manage';
  END IF;

  -- Load the invoice + the customer organization.
  SELECT i.*, o.id AS org_id, o.name AS org_name, o.branding AS org_branding
    INTO v_invoice
    FROM public.invoices i
    LEFT JOIN public.organizations o ON o.id = i.organization_id
   WHERE i.id = p_invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice % not found', p_invoice_id;
  END IF;

  IF v_invoice.status NOT IN ('open', 'paid') THEN
    RAISE EXCEPTION 'invoice % is in status=%, only open/paid invoices can be submitted to EIS',
      p_invoice_id, v_invoice.status;
  END IF;

  -- Check for an existing non-terminal submission. Terminal =
  -- rejected | cancelled — those are safe to overwrite. A submission
  -- in queued / submitted / accepted blocks new submission unless
  -- the caller explicitly opts in.
  SELECT id, status
    INTO v_existing
    FROM public.eis_submissions
   WHERE reference_kind = 'invoice'
     AND reference_id   = p_invoice_id::text
     AND status NOT IN ('rejected', 'cancelled')
   ORDER BY created_at DESC
   LIMIT 1;

  IF FOUND AND NOT p_resubmit THEN
    RAISE EXCEPTION
      'invoice % already has a non-terminal eis_submissions row (id=%, status=%); pass p_resubmit=true to override',
      p_invoice_id, v_existing.id, v_existing.status;
  END IF;

  -- Build the canonical payload. Supplier (the platform issuing the
  -- invoice) data lives in operator-set GUCs so the same migration
  -- works across tenants.
  v_payload := jsonb_build_object(
    'document_kind', 'sales_invoice',
    'invoice', jsonb_build_object(
      'id',              v_invoice.id,
      'invoice_no',      v_invoice.invoice_no,
      'currency',        v_invoice.currency,
      'subtotal_minor',  v_invoice.subtotal_minor,
      'tax_minor',       v_invoice.tax_minor,
      'total_minor',     v_invoice.total_minor,
      'issued_at',       v_invoice.issued_at,
      'period_start',    v_invoice.period_start,
      'period_end',      v_invoice.period_end,
      'line_items',      v_invoice.line_items
    ),
    -- Supplier: GUC takes precedence (if set); otherwise read from
    -- platform_settings so the admin UI can manage it without
    -- needing a Postgres restart. Empty strings if neither configured.
    'supplier', (
      SELECT jsonb_build_object(
        'tin',
          COALESCE(
            current_setting('app.eis_supplier_tin', true),
            (SELECT value->>'tin'  FROM public.platform_settings WHERE key = 'eis_supplier'),
            ''
          ),
        'name',
          COALESCE(
            current_setting('app.eis_supplier_name', true),
            (SELECT value->>'name' FROM public.platform_settings WHERE key = 'eis_supplier'),
            ''
          ),
        'address',
          COALESCE(
            (SELECT value->>'address' FROM public.platform_settings WHERE key = 'eis_supplier'),
            ''
          )
      )
    ),
    'customer', jsonb_build_object(
      'id',       v_invoice.org_id,
      'name',     COALESCE(v_invoice.org_name, ''),
      'tin',      COALESCE(v_invoice.org_branding->>'tin', ''),
      'address',  COALESCE(v_invoice.org_branding->>'address', '')
    )
  );

  -- Insert queued submission row.
  INSERT INTO public.eis_submissions
    (document_kind, reference_kind, reference_id, payload,
     status, created_by)
  VALUES
    ('sales_invoice', 'invoice', p_invoice_id::text, v_payload,
     'queued', auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('submission_id', v_id, 'status', 'queued');
END;
$$;

REVOKE ALL ON FUNCTION public.submit_invoice_to_eis(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_invoice_to_eis(uuid, boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.submit_invoice_to_eis(uuid, boolean) IS
  'Builds canonical EIS payload from an invoice and queues an eis_submissions row. p_resubmit=true overrides a non-terminal prior submission.';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.submit_invoice_to_eis', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Generator for queued EIS sales-invoice submissions.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


NOTIFY pgrst, 'reload schema';
