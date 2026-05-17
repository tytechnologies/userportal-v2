-- BIR Form 2306 — Certificate of Final Tax Withheld at Source.
--
-- Sister to Form 2307. The difference: 2307 covers *creditable* tax
-- (the vendor uses it to offset their income tax due), 2306 covers
-- *final* tax (already settled — no further income tax on this).
-- Both are per-vendor × ATC × period aggregations.
--
-- Schema additions:
--   * vendors.final_withholding_rate_bps
--   * vendors.final_withholding_atc_code
--
-- bir_report_runs.report_kind extended to allow 'form_2306'.
--
-- ROLLBACK:
--   ALTER TABLE public.vendors DROP COLUMN IF EXISTS final_withholding_rate_bps;
--   ALTER TABLE public.vendors DROP COLUMN IF EXISTS final_withholding_atc_code;
--   DROP FUNCTION IF EXISTS public.generate_bir_form_2306(date, date, boolean, text);
--   DELETE FROM public.governance_schema_contracts WHERE contract_name = 'public.generate_bir_form_2306';

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS final_withholding_rate_bps integer
    CHECK (final_withholding_rate_bps IS NULL OR (final_withholding_rate_bps >= 0
                                                  AND final_withholding_rate_bps <= 5000)),
  ADD COLUMN IF NOT EXISTS final_withholding_atc_code text;

COMMENT ON COLUMN public.vendors.final_withholding_rate_bps IS
  'Final (vs creditable) withholding tax rate in basis points. NULL = no final withholding.';
COMMENT ON COLUMN public.vendors.final_withholding_atc_code IS
  'BIR ATC code for final withholding (e.g. WI100 for cash dividends).';


-- Extend report_kind CHECK to include form_2306.
DO $$
BEGIN
  ALTER TABLE public.bir_report_runs
    DROP CONSTRAINT IF EXISTS bir_report_runs_report_kind_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE public.bir_report_runs
  ADD CONSTRAINT bir_report_runs_report_kind_check
  CHECK (report_kind IN ('sales_book', 'purchases_book', 'form_2307', 'form_2306'));


-- =====================================================================
-- Form 2306 generator
-- =====================================================================

CREATE OR REPLACE FUNCTION public.generate_bir_form_2306(
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
  v_rows         jsonb;
  v_totals       jsonb;
  v_run_id       uuid;
  v_total_paid   numeric := 0;
  v_total_held   numeric := 0;
BEGIN
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

  -- Aggregate per (vendor × final ATC × period) for completed work
  -- orders. Vendors without a final withholding rate are excluded.
  WITH per_vendor_atc AS (
    SELECT
      v.id                                                  AS vendor_id,
      v.name                                                AS vendor_name,
      COALESCE(public.vendor_get_tax_id(v.id), '')          AS vendor_tin,
      COALESCE(v.email, '')                                 AS vendor_email,
      v.final_withholding_atc_code                          AS atc_code,
      v.final_withholding_rate_bps                          AS rate_bps,
      SUM((w.cost_actual_minor / 100.0) / 1.12)             AS gross_income_paid,
      SUM(
        ROUND(
          ((w.cost_actual_minor / 100.0) / 1.12)
            * (v.final_withholding_rate_bps / 10000.0),
          2
        )
      )                                                     AS tax_withheld
    FROM public.work_orders w
    JOIN public.vendors v ON v.id = w.vendor_id
    WHERE w.status = 'completed'
      AND w.cost_actual_minor IS NOT NULL
      AND w.completed_at::date BETWEEN p_period_start AND p_period_end
      AND v.final_withholding_rate_bps IS NOT NULL
      AND v.final_withholding_rate_bps > 0
    GROUP BY v.id, v.name, v.email,
             v.final_withholding_atc_code, v.final_withholding_rate_bps
  )
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'vendor_id',         vendor_id,
        'vendor_name',       vendor_name,
        'vendor_tin',        vendor_tin,
        'vendor_email',      vendor_email,
        'atc_code',          atc_code,
        'rate_pct',          (rate_bps / 100.0),
        'gross_income_paid', gross_income_paid,
        'tax_withheld',      tax_withheld
      )
      ORDER BY vendor_name
    ), '[]'::jsonb),
    COALESCE(SUM(gross_income_paid), 0),
    COALESCE(SUM(tax_withheld), 0)
  INTO v_rows, v_total_paid, v_total_held
  FROM per_vendor_atc;

  v_totals := jsonb_build_object(
    'gross_income_paid', v_total_paid,
    'final_tax_withheld', v_total_held,
    'row_count',         COALESCE(jsonb_array_length(v_rows), 0)
  );

  IF p_save THEN
    INSERT INTO public.bir_report_runs
      (report_kind, period_start, period_end, rows, totals, generated_by, notes)
    VALUES
      ('form_2306', p_period_start, p_period_end, v_rows, v_totals, auth.uid(), p_notes)
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

REVOKE ALL ON FUNCTION public.generate_bir_form_2306(date, date, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_bir_form_2306(date, date, boolean, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.generate_bir_form_2306(date, date, boolean, text) IS
  'BIR Form 2306 (final tax withheld at source) generator. Vendors without a final withholding rate are excluded.';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.generate_bir_form_2306', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'PH BIR Form 2306 (final tax withheld at source) generator.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- Smoke test
-- =====================================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.generate_bir_form_2306(
    (current_date - interval '30 days')::date,
    current_date,
    false,
    'smoke'
  );
  RAISE NOTICE 'BIR Form 2306 preview: rows=%, withheld=%',
    v_result->'totals'->>'row_count',
    v_result->'totals'->>'final_tax_withheld';
END $$;


NOTIFY pgrst, 'reload schema';
