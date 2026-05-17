-- BIR generators read vendor TIN through vendor_get_tax_id().
--
-- Previously the purchases book and Form 2307 generator selected
-- `v.tax_id` directly — only correct for un-encrypted vendors.
-- Once vendor_tax_id_backfill() runs (encrypting the plaintext into
-- v.tax_id_encrypted), the plaintext column is nulled in the
-- follow-up sign-off migration; from that point, generators must
-- decrypt via the helper or the TIN column shows as empty in the
-- generated reports.
--
-- This migration replaces both functions to call vendor_get_tax_id().
-- The helper falls back to the plaintext column for un-backfilled
-- vendors, so both encrypted and legacy data work side by side
-- during the migration window.
--
-- ROLLBACK: re-run 20260507000066 (purchases book) and
-- 20260507000072 (form 2307) to restore the prior versions that
-- read v.tax_id directly.


-- =====================================================================
-- generate_bir_purchases_book — switch to vendor_get_tax_id
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
  v_rows           jsonb;
  v_totals         jsonb;
  v_run_id         uuid;
  v_total_gross    numeric := 0;
  v_total_vat      numeric := 0;
  v_total_net      numeric := 0;
  v_total_withheld numeric := 0;
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

  WITH src AS (
    SELECT
      w.id                                                    AS work_order_id,
      w.work_order_no,
      w.completed_at::date                                    AS purchase_date,
      COALESCE(v.name, 'UNKNOWN VENDOR')                      AS vendor_name,
      -- Decrypt-aware TIN read: falls back to plaintext for
      -- un-backfilled vendors. NULL → '' so the CSV stays clean.
      COALESCE(public.vendor_get_tax_id(v.id), '')            AS vendor_tin,
      COALESCE(v.email, '')                                   AS vendor_email,
      v.withholding_atc_code,
      COALESCE(v.withholding_rate_bps, 0)                     AS withholding_rate_bps,
      w.currency,
      (w.cost_actual_minor / 100.0)                           AS gross,
      ROUND((w.cost_actual_minor / 100.0) / 1.12 * 0.12, 2)   AS vat,
      ROUND((w.cost_actual_minor / 100.0) / 1.12, 2)          AS net,
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
-- generate_bir_form_2307 — switch to vendor_get_tax_id
-- =====================================================================

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

  WITH per_vendor_atc AS (
    SELECT
      v.id                                                  AS vendor_id,
      v.name                                                AS vendor_name,
      COALESCE(public.vendor_get_tax_id(v.id), '')          AS vendor_tin,
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
    GROUP BY v.id, v.name, v.email,
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


NOTIFY pgrst, 'reload schema';
