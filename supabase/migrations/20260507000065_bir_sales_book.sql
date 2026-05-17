-- BIR (PH Bureau of Internal Revenue) Sales Book scaffold.
--
-- Phase E foundation. Generates the monthly Sales Book (RDO format,
-- columns roughly matching BIR Form 2550M / VAT relief schedules)
-- as a reportable view + a one-shot generation RPC that snapshots
-- the result into bir_report_runs for audit.
--
-- Source of truth: invoices issued + journal_entries posted in the
-- accounting ledger. We do NOT pull from raw payment_intents — only
-- what's been recognised in the books counts for tax reporting.
--
-- Caveats / not yet wired:
--   * VAT computation is a flat 12% inclusive split here. Some
--     transactions will be VAT-exempt or zero-rated; downstream
--     work will need an `is_vat_exempt` and `is_zero_rated` column
--     on invoices to differentiate.
--   * No e-Invoicing / EIS submission — that's a separate epic.
--   * No purchases book yet — same shape, separate migration.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.generate_bir_sales_book(date, date, uuid);
--   DROP TABLE IF EXISTS public.bir_report_runs;
--   DELETE FROM public.permissions WHERE name = 'bir_reports.manage';
--   DELETE FROM public.role_permissions WHERE permission = 'bir_reports.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.bir_report_runs';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.generate_bir_sales_book';

CREATE TABLE IF NOT EXISTS public.bir_report_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_kind         text NOT NULL CHECK (report_kind IN ('sales_book', 'purchases_book')),
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  -- The frozen rows the operator submitted. Re-running for the same
  -- period creates a NEW row; we never overwrite a prior submission.
  rows                jsonb NOT NULL,
  totals              jsonb NOT NULL,
  -- Operator who initiated the run.
  generated_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  notes               text,
  CONSTRAINT bir_report_runs_period_chk CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS bir_report_runs_period_idx
  ON public.bir_report_runs(report_kind, period_start, period_end);

ALTER TABLE public.bir_report_runs ENABLE ROW LEVEL SECURITY;

-- Append-only enforcement: nobody can update or delete a generated run.
DROP POLICY IF EXISTS bir_report_runs_select ON public.bir_report_runs;
CREATE POLICY bir_report_runs_select ON public.bir_report_runs FOR SELECT
  TO authenticated
  USING (
    public.has_permission('bir_reports.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS bir_report_runs_insert ON public.bir_report_runs;
CREATE POLICY bir_report_runs_insert ON public.bir_report_runs FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('bir_reports.manage')
    OR public.has_permission('admin.access')
  );

CREATE OR REPLACE FUNCTION public._bir_report_runs_block_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'bir_report_runs is append-only — generate a new run instead of editing %.', OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS bir_report_runs_no_update ON public.bir_report_runs;
CREATE TRIGGER bir_report_runs_no_update
  BEFORE UPDATE OR DELETE ON public.bir_report_runs
  FOR EACH ROW EXECUTE FUNCTION public._bir_report_runs_block_update();


-- =====================================================================
-- Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('bir_reports.manage',
   'Generate and view PH BIR sales / purchases books',
   'finance')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin', 'bir_reports.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- Generation RPC
-- =====================================================================
--
-- p_period_start / p_period_end are inclusive YYYY-MM-DD dates.
-- p_save = true to snapshot into bir_report_runs; false for preview.
-- Returns the bir_report_runs row that was created (or NULL on preview).

CREATE OR REPLACE FUNCTION public.generate_bir_sales_book(
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
  v_caller_role text;
  v_rows        jsonb;
  v_totals      jsonb;
  v_run_id      uuid;
  v_row         record;
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

  -- Build the row set. Each invoice is one entry. Customer name +
  -- TIN + address come from organizations (the billing party). The
  -- TIN/address live in the branding jsonb until a dedicated tax
  -- profile table lands.
  WITH src AS (
    SELECT
      i.id                                                   AS invoice_id,
      i.invoice_no,
      i.issued_at::date                                      AS issue_date,
      COALESCE(o.name, 'UNKNOWN')                            AS customer_name,
      COALESCE(o.branding->>'tin', '')                       AS customer_tin,
      COALESCE(o.branding->>'address', '')                   AS customer_address,
      i.currency,
      -- Treat total_minor as VAT-inclusive (12%). VAT-exempt / zero-rated
      -- handling deferred (see header).
      (i.total_minor / 100.0)                                AS gross,
      ROUND((i.total_minor / 100.0) / 1.12 * 0.12, 2)        AS vat,
      ROUND((i.total_minor / 100.0) / 1.12, 2)               AS net
    FROM public.invoices i
    LEFT JOIN public.organizations o ON o.id = i.organization_id
    WHERE i.status = 'paid'
      AND i.issued_at::date BETWEEN p_period_start AND p_period_end
    ORDER BY i.issued_at::date, i.invoice_no
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(src.*)), '[]'::jsonb),
    COALESCE(SUM(src.gross), 0),
    COALESCE(SUM(src.vat), 0),
    COALESCE(SUM(src.net), 0)
  INTO v_rows, v_total_gross, v_total_vat, v_total_net
  FROM src;

  v_totals := jsonb_build_object(
    'gross_sales', v_total_gross,
    'vat_output',  v_total_vat,
    'net_sales',   v_total_net,
    'row_count',   COALESCE(jsonb_array_length(v_rows), 0)
  );

  IF p_save THEN
    INSERT INTO public.bir_report_runs
      (report_kind, period_start, period_end, rows, totals, generated_by, notes)
    VALUES
      ('sales_book', p_period_start, p_period_end, v_rows, v_totals, auth.uid(), p_notes)
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

REVOKE ALL ON FUNCTION public.generate_bir_sales_book(date, date, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_bir_sales_book(date, date, boolean, text)
  TO authenticated, service_role;


COMMENT ON FUNCTION public.generate_bir_sales_book(date, date, boolean, text) IS
  'Generates a BIR Sales Book for the given period from paid invoices. p_save=true snapshots into bir_report_runs; false returns a preview. Skips invoices outside the date window or not in status=paid. VAT-inclusive 12% assumed.';

COMMENT ON TABLE public.bir_report_runs IS
  'Append-only snapshots of generated BIR reports. Re-running a period creates a NEW row.';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.bir_report_runs', 'table', 'userportal',
   ARRAY['userportal']::text[],
   'Append-only history of BIR sales / purchases book generations.',
   false),
  ('public.generate_bir_sales_book', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'Builds and (optionally) snapshots a PH BIR Sales Book for a given date range.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- Smoke test
-- =====================================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  -- Preview only (p_save = false). Past month.
  v_result := public.generate_bir_sales_book(
    (current_date - interval '30 days')::date,
    current_date,
    false,
    'smoke'
  );
  RAISE NOTICE 'BIR sales book preview: rows=%, gross=%',
    v_result->'totals'->>'row_count',
    v_result->'totals'->>'gross_sales';
END $$;


NOTIFY pgrst, 'reload schema';
