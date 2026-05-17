-- Withholding tax (Expanded Withholding Tax / BIR Form 2307).
--
-- Adds per-vendor withholding rate, extends the purchases book to
-- compute withholding amount + net-payable, and ships generate_bir_form_2307()
-- to produce the certificate summary the BIR requires when paying
-- specific classes of vendor (rent, professional fees, etc.).
--
-- Schema additions are additive only (per project rule):
--   * vendors.withholding_rate_bps (basis points, NULL = none)
--   * vendors.withholding_atc_code (BIR ATC code; e.g. 'WC158' for
--     gross rental, 'WI010' for professional fees)
--
-- Why basis points: lets us store 1.0%, 2.0%, 5.0%, 10.0%, 15.0%
-- without floats. 100 bps = 1.0%.
--
-- ROLLBACK:
--   ALTER TABLE public.vendors DROP COLUMN IF EXISTS withholding_rate_bps;
--   ALTER TABLE public.vendors DROP COLUMN IF EXISTS withholding_atc_code;
--   DROP FUNCTION IF EXISTS public.generate_bir_form_2307(date, date, boolean, text);
--   DELETE FROM public.governance_schema_contracts
--     WHERE contract_name = 'public.generate_bir_form_2307';


-- =====================================================================
-- Vendor schema additions
-- =====================================================================

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS withholding_rate_bps integer
    CHECK (withholding_rate_bps IS NULL OR (withholding_rate_bps >= 0
                                            AND withholding_rate_bps <= 5000)),
  ADD COLUMN IF NOT EXISTS withholding_atc_code text;

COMMENT ON COLUMN public.vendors.withholding_rate_bps IS
  'Withholding tax rate in basis points (100 bps = 1.0%). NULL = no withholding. Cap 50% (5000 bps).';
COMMENT ON COLUMN public.vendors.withholding_atc_code IS
  'BIR Alphanumeric Tax Code: WC158 (gross rental), WI010 (professional fees), WC100 (gross sales of goods), etc.';


-- =====================================================================
-- Extend the purchases book to include withholding
-- =====================================================================
--
-- Replaces 20260507000066's generate_bir_purchases_book with one that
-- adds withholding columns. Same signature; rollback returns to the
-- prior shape.

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
  v_rows           jsonb;
  v_totals         jsonb;
  v_run_id         uuid;
  v_total_gross    numeric := 0;
  v_total_vat      numeric := 0;
  v_total_net      numeric := 0;
  v_total_withheld numeric := 0;
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
      w.id                                                    AS work_order_id,
      w.work_order_no,
      w.completed_at::date                                    AS purchase_date,
      COALESCE(v.name, 'UNKNOWN VENDOR')                      AS vendor_name,
      COALESCE(v.tax_id, '')                                  AS vendor_tin,
      COALESCE(v.email, '')                                   AS vendor_email,
      v.withholding_atc_code,
      COALESCE(v.withholding_rate_bps, 0)                     AS withholding_rate_bps,
      w.currency,
      (w.cost_actual_minor / 100.0)                           AS gross,
      ROUND((w.cost_actual_minor / 100.0) / 1.12 * 0.12, 2)   AS vat,
      ROUND((w.cost_actual_minor / 100.0) / 1.12, 2)          AS net,
      -- Withholding is computed on the net (VAT-exclusive) amount.
      ROUND(
        ((w.cost_actual_minor / 100.0) / 1.12)
          * (COALESCE(v.withholding_rate_bps, 0) / 10000.0),
        2
      )                                                       AS withheld
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
    COALESCE(SUM(src.net), 0),
    COALESCE(SUM(src.withheld), 0)
  INTO v_rows, v_total_gross, v_total_vat, v_total_net, v_total_withheld
  FROM src;

  v_totals := jsonb_build_object(
    'gross_purchases', v_total_gross,
    'vat_input',       v_total_vat,
    'net_purchases',   v_total_net,
    'tax_withheld',    v_total_withheld,
    'net_payable',     v_total_gross - v_total_withheld,
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


-- =====================================================================
-- BIR Form 2307 — Certificate of Creditable Tax Withheld at Source
-- =====================================================================
--
-- One row per (vendor × ATC code × period). Each row is what the
-- 2307 certificate would say: gross income paid, ATC, rate, tax
-- withheld. The vendor uses this against their own tax liability.
--
-- Same append-only snapshot pattern as the sales/purchases books.
-- Saved as report_kind='form_2307' inside bir_report_runs.

-- First, allow form_2307 in the bir_report_runs CHECK constraint.
DO $$
BEGIN
  ALTER TABLE public.bir_report_runs
    DROP CONSTRAINT IF EXISTS bir_report_runs_report_kind_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE public.bir_report_runs
  ADD CONSTRAINT bir_report_runs_report_kind_check
  CHECK (report_kind IN ('sales_book', 'purchases_book', 'form_2307'));


CREATE OR REPLACE FUNCTION public.generate_bir_form_2307(
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

  -- Aggregate per vendor × ATC across all completed work_orders in
  -- the period. Vendors with no withholding rate are excluded —
  -- there's nothing to certify.
  WITH per_vendor_atc AS (
    SELECT
      v.id                                                  AS vendor_id,
      v.name                                                AS vendor_name,
      COALESCE(v.tax_id, '')                                AS vendor_tin,
      COALESCE(v.email, '')                                 AS vendor_email,
      v.withholding_atc_code                                AS atc_code,
      v.withholding_rate_bps                                AS rate_bps,
      SUM((w.cost_actual_minor / 100.0) / 1.12)             AS gross_income_paid,
      SUM(
        ROUND(
          ((w.cost_actual_minor / 100.0) / 1.12)
            * (v.withholding_rate_bps / 10000.0),
          2
        )
      )                                                     AS tax_withheld
    FROM public.work_orders w
    JOIN public.vendors v ON v.id = w.vendor_id
    WHERE w.status = 'completed'
      AND w.cost_actual_minor IS NOT NULL
      AND w.completed_at::date BETWEEN p_period_start AND p_period_end
      AND v.withholding_rate_bps IS NOT NULL
      AND v.withholding_rate_bps > 0
    GROUP BY v.id, v.name, v.tax_id, v.email,
             v.withholding_atc_code, v.withholding_rate_bps
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
    'tax_withheld',      v_total_held,
    'row_count',         COALESCE(jsonb_array_length(v_rows), 0)
  );

  IF p_save THEN
    INSERT INTO public.bir_report_runs
      (report_kind, period_start, period_end, rows, totals, generated_by, notes)
    VALUES
      ('form_2307', p_period_start, p_period_end, v_rows, v_totals, auth.uid(), p_notes)
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

REVOKE ALL ON FUNCTION public.generate_bir_form_2307(date, date, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_bir_form_2307(date, date, boolean, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.generate_bir_form_2307(date, date, boolean, text) IS
  'BIR Form 2307 certificate generator. One row per vendor × ATC × period; vendors without a withholding rate are excluded.';


-- =====================================================================
-- Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.generate_bir_form_2307', 'function', 'userportal',
   ARRAY['userportal']::text[],
   'PH BIR Form 2307 (creditable tax withheld at source) generator.',
   false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- Smoke test
-- =====================================================================
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.generate_bir_form_2307(
    (current_date - interval '30 days')::date,
    current_date,
    false,
    'smoke'
  );
  RAISE NOTICE 'BIR Form 2307 preview: rows=%, withheld=%',
    v_result->'totals'->>'row_count',
    v_result->'totals'->>'tax_withheld';
END $$;


NOTIFY pgrst, 'reload schema';
