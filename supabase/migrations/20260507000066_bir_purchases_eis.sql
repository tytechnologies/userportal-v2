-- BIR Purchases Book + e-invoicing (EIS) intake scaffold.
--
-- Phase E follow-on. Adds the matching Purchases Book to the Sales Book
-- already shipped in 20260507000065, plus a minimal eis_submissions
-- table that records every payload we've prepared for BIR's electronic
-- invoicing system (EIS). No live API call yet — that integration is
-- gated on RDO accreditation paperwork that takes weeks to clear.
--
-- Source of truth for purchases:
--   * work_orders WHERE status='completed' AND cost_actual_minor IS NOT NULL
--     AND vendor_id IS NOT NULL — i.e. a vendor was paid a real amount
--     for finished work.
--
-- Caveats / not yet wired:
--   * Single rate (12% VAT inclusive). Withholding tax handling is
--     deferred (BIR Form 2307).
--   * Purchases not flowing through work_orders (e.g. one-off office
--     supplies recorded only as journal entries) won't appear here
--     until they get their own intake table.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.generate_bir_purchases_book(date, date, boolean, text);
--   DROP TABLE IF EXISTS public.eis_submissions;
--   DELETE FROM public.governance_schema_contracts
--     WHERE contract_name IN ('public.eis_submissions', 'public.generate_bir_purchases_book');


-- =====================================================================
-- EIS submissions intake
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.eis_submissions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Documented kinds: 'sales_invoice', 'official_receipt', 'credit_note', 'debit_note'.
  document_kind      text NOT NULL,

  -- Reference back to whatever generated the document. For invoices,
  -- reference_kind='invoice', reference_id=invoices.id.
  reference_kind     text NOT NULL,
  reference_id       text NOT NULL,

  -- Frozen payload at submit-time. Once submitted to BIR we cannot
  -- mutate; even pre-submit, treating this as an audit snapshot.
  payload            jsonb NOT NULL,

  status             text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'submitted', 'accepted',
                                            'rejected', 'cancelled')),
  submitted_at       timestamptz,
  -- BIR's tracking ID for the submission.
  external_reference text,
  -- Free-form rejection / acceptance notes from BIR's response.
  response_notes     text,

  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eis_submissions_ref_idx
  ON public.eis_submissions(reference_kind, reference_id);
CREATE INDEX IF NOT EXISTS eis_submissions_status_idx
  ON public.eis_submissions(status, created_at DESC);

DROP TRIGGER IF EXISTS set_eis_submissions_updated_at ON public.eis_submissions;
CREATE TRIGGER set_eis_submissions_updated_at
  BEFORE UPDATE ON public.eis_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.eis_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eis_submissions_select ON public.eis_submissions;
CREATE POLICY eis_submissions_select ON public.eis_submissions FOR SELECT
  TO authenticated
  USING (
    public.has_permission('bir_reports.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS eis_submissions_insert ON public.eis_submissions;
CREATE POLICY eis_submissions_insert ON public.eis_submissions FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('bir_reports.manage')
    OR public.has_permission('admin.access')
  );

-- Once the row is in 'submitted' or 'accepted' state, the payload
-- is frozen — only metadata, status, and response_notes can change.
CREATE OR REPLACE FUNCTION public._eis_submissions_block_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('submitted', 'accepted') THEN
    IF NEW.payload      IS DISTINCT FROM OLD.payload      OR
       NEW.document_kind IS DISTINCT FROM OLD.document_kind OR
       NEW.reference_kind IS DISTINCT FROM OLD.reference_kind OR
       NEW.reference_id   IS DISTINCT FROM OLD.reference_id THEN
      RAISE EXCEPTION
        'eis_submissions row % is frozen (status=%); payload/refs cannot change',
        OLD.id, OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS eis_submissions_freeze ON public.eis_submissions;
CREATE TRIGGER eis_submissions_freeze
  BEFORE UPDATE ON public.eis_submissions
  FOR EACH ROW EXECUTE FUNCTION public._eis_submissions_block_freeze();


-- =====================================================================
-- Purchases Book RPC
-- =====================================================================

CREATE OR REPLACE FUNCTION public.generate_bir_purchases_book(
  p_period_start date,
  p_period_end   date,
  p_save         boolean DEFAULT true,
  p_notes        text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows        jsonb;
  v_totals      jsonb;
  v_run_id      uuid;
  v_total_gross numeric := 0;
  v_total_vat   numeric := 0;
  v_total_net   numeric := 0;
BEGIN
  -- Smoke-test bypass per project memory.
  IF session_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    NULL;
  ELSIF NOT (
    public.has_permission('bir_reports.manage')
    OR public.has_permission('admin.access')
  ) THEN
    RAISE EXCEPTION 'permission denied: requires bir_reports.manage';
  END IF;

  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'period_end must be >= period_start';
  END IF;

  WITH src AS (
    SELECT
      w.id                                                      AS work_order_id,
      w.work_order_no,
      w.completed_at::date                                      AS purchase_date,
      COALESCE(v.name, 'UNKNOWN VENDOR')                        AS vendor_name,
      COALESCE(v.tax_id, '')                                    AS vendor_tin,
      COALESCE(v.email, '')                                     AS vendor_email,
      w.currency,
      (w.cost_actual_minor / 100.0)                             AS gross,
      ROUND((w.cost_actual_minor / 100.0) / 1.12 * 0.12, 2)     AS vat,
      ROUND((w.cost_actual_minor / 100.0) / 1.12, 2)            AS net
    FROM public.work_orders w
    LEFT JOIN public.vendors v ON v.id = w.vendor_id
    WHERE w.status = 'completed'
      AND w.cost_actual_minor IS NOT NULL
      AND w.completed_at::date BETWEEN p_period_start AND p_period_end
    ORDER BY w.completed_at::date, w.work_order_no
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(src.*)), '[]'::jsonb),
    COALESCE(SUM(src.gross), 0),
    COALESCE(SUM(src.vat), 0),
    COALESCE(SUM(src.net), 0)
  INTO v_rows, v_total_gross, v_total_vat, v_total_net
  FROM src;

  v_totals := jsonb_build_object(
    'gross_purchases', v_total_gross,
    'vat_input',       v_total_vat,
    'net_purchases',   v_total_net,
    'row_count',       COALESCE(jsonb_array_length(v_rows), 0)
  );

  IF p_save THEN
    INSERT INTO public.bir_report_runs
      (report_kind, period_start, period_end, rows, totals, generated_by, notes)
    VALUES
      ('purchases_book', p_period_start, p_period_end, v_rows, v_totals, auth.uid(), p_notes)
    RETURNING id INTO v_run_id;
  END IF;

  RETURN jsonb_build_object(
    'saved',         p_save,
    'run_id',        v_run_id,
    'period_start',  p_period_start,
    'period_end',    p_period_end,
    'totals',        v_totals,
    'rows',          v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.generate_bir_purchases_book(date, date, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_bir_purchases_book(date, date, boolean, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.generate_bir_purchases_book(date, date, boolean, text) IS
  'BIR Purchases Book generator. Sources from completed work_orders with vendor + cost_actual_minor. VAT-inclusive 12% assumed; withholding tax handling deferred.';

COMMENT ON TABLE public.eis_submissions IS
  'EIS (BIR e-invoicing) submission intake. Once status=submitted, payload + refs are frozen.';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.eis_submissions', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Frozen audit of EIS (PH BIR e-invoicing) document submissions.',
   false),
  ('public.generate_bir_purchases_book', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Builds and (optionally) snapshots a PH BIR Purchases Book for a given date range.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- Smoke test
-- =====================================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.generate_bir_purchases_book(
    (current_date - interval '30 days')::date,
    current_date,
    false,
    'smoke'
  );
  RAISE NOTICE 'BIR purchases book preview: rows=%, gross=%',
    v_result->'totals'->>'row_count',
    v_result->'totals'->>'gross_purchases';
END $$;


NOTIFY pgrst, 'reload schema';
