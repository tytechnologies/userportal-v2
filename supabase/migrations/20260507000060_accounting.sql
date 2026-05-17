-- Property Accounting — Chart of Accounts + Journal + Bank Reconciliation.
--
-- C6 of the post-audit roadmap. Adds double-entry bookkeeping over
-- the existing money-flow tables (invoices, commission_ledger,
-- property_charges, platform_fee_charges, owner/tenant statements,
-- work_orders).
--
-- Auto-posting is operator-triggered via RPCs, NOT via triggers on
-- the upstream tables. This preserves audit control: every journal
-- entry has an explicit author and review path.
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.bank_reconciliation_status;
--   DROP VIEW IF EXISTS public.trial_balance;
--   DROP VIEW IF EXISTS public.account_balances;
--   DROP TRIGGER IF EXISTS journal_lines_post_guard ON public.journal_lines;
--   DROP TRIGGER IF EXISTS journal_entries_post_guard ON public.journal_entries;
--   DROP FUNCTION IF EXISTS public.journal_lines_post_guard_fn();
--   DROP FUNCTION IF EXISTS public.journal_entries_post_guard_fn();
--   DROP FUNCTION IF EXISTS public.auto_post_platform_fee(uuid);
--   DROP FUNCTION IF EXISTS public.auto_post_property_charge(uuid);
--   DROP FUNCTION IF EXISTS public.journal_entry_reverse(uuid, date);
--   DROP FUNCTION IF EXISTS public.journal_entry_post(uuid);
--   DROP FUNCTION IF EXISTS public.next_journal_entry_no();
--   DROP TABLE IF EXISTS public.bir_export_runs;
--   DROP TABLE IF EXISTS public.bank_transactions;
--   DROP TABLE IF EXISTS public.bank_accounts;
--   DROP TABLE IF EXISTS public.journal_lines;
--   DROP TABLE IF EXISTS public.journal_entries;
--   DROP TABLE IF EXISTS public.accounts;
--   DROP SEQUENCE IF EXISTS public.journal_entry_seq;
--   DELETE FROM public.role_permissions WHERE permission = 'accounting.manage';
--   DELETE FROM public.permissions WHERE name = 'accounting.manage';
--   DELETE FROM public.governance_schema_contracts WHERE contract_name IN
--     ('public.accounts', 'public.journal_entries', 'public.journal_lines',
--      'public.bank_accounts', 'public.bank_transactions', 'public.bir_export_runs',
--      'public.account_balances', 'public.trial_balance',
--      'public.bank_reconciliation_status');


-- =====================================================================
-- 1. accounts — chart of accounts
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- e.g., '1001', '4001'. Hierarchical conventionally:
  -- 1xxx asset, 2xxx liability, 3xxx equity, 4xxx revenue, 5xxx COGS, 6xxx expense.
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,

  account_type        text NOT NULL CHECK (account_type IN
                           ('asset', 'liability', 'equity', 'revenue', 'expense')),

  parent_account_id   uuid REFERENCES public.accounts(id) ON DELETE SET NULL,

  currency            text NOT NULL DEFAULT 'PHP',
  description         text,
  is_active           boolean NOT NULL DEFAULT true,

  -- System accounts can't be deleted: cash, AR, AP, retained earnings, etc.
  is_system           boolean NOT NULL DEFAULT false,

  -- BIR classification for VAT computation.
  bir_classification  text CHECK (bir_classification IS NULL OR bir_classification IN
                           ('vatable', 'non_vatable', 'exempt', 'zero_rated')),
  -- BIR Alphanumeric Tax Code, when applicable (e.g., 'WC158').
  tax_code            text,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS accounts_type_idx
  ON public.accounts(account_type, code);
CREATE INDEX IF NOT EXISTS accounts_parent_idx
  ON public.accounts(parent_account_id) WHERE parent_account_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_accounts_updated_at ON public.accounts;
CREATE TRIGGER set_accounts_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 2. journal_entry sequence + helper
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS public.journal_entry_seq START 1000;

CREATE OR REPLACE FUNCTION public.next_journal_entry_no()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN format(
    'JE-%s-%s',
    to_char(now(), 'YYYY'),
    lpad(nextval('public.journal_entry_seq')::text, 6, '0')
  );
END;
$$;


-- =====================================================================
-- 3. journal_entries — transaction header
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.journal_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  entry_no            text NOT NULL UNIQUE
                           DEFAULT public.next_journal_entry_no(),

  entry_date          date NOT NULL DEFAULT current_date,
  description         text NOT NULL,

  -- Documented values: 'invoice', 'property_charge', 'platform_fee',
  -- 'commission_ledger', 'manual', 'reconciliation', 'opening_balance'.
  reference_kind      text NOT NULL DEFAULT 'manual',
  -- text not uuid: upstream keys vary (uuid, bigint).
  reference_id        text,

  -- Currency enforced equal across lines by trigger.
  currency            text NOT NULL DEFAULT 'PHP',

  status              text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'posted', 'void')),

  posted_at           timestamptz,
  posted_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  voided_at           timestamptz,
  voided_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  void_reason         text,

  -- For reversals.
  reverses_entry_id   uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,

  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS journal_entries_date_idx
  ON public.journal_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS journal_entries_status_idx
  ON public.journal_entries(status, entry_date DESC);
CREATE INDEX IF NOT EXISTS journal_entries_reference_idx
  ON public.journal_entries(reference_kind, reference_id)
  WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_entries_reverses_idx
  ON public.journal_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- Idempotency for auto-posting: one (kind, ref_id, status<>void) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_per_reference
  ON public.journal_entries(reference_kind, reference_id)
  WHERE reference_id IS NOT NULL
    AND reference_kind <> 'manual'
    AND status <> 'void';

DROP TRIGGER IF EXISTS set_journal_entries_updated_at ON public.journal_entries;
CREATE TRIGGER set_journal_entries_updated_at
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 4. journal_lines — debit/credit detail
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.journal_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id        uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,

  account_id              uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,

  debit_minor             bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor            bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  currency                text NOT NULL DEFAULT 'PHP',

  description             text,

  -- Cost-center dimensions (all optional). Useful for owner statements,
  -- per-unit profitability, lease-level reporting.
  dimension_unit_id       uuid REFERENCES public.units(id) ON DELETE SET NULL,
  dimension_lease_id      uuid REFERENCES public.leases(id) ON DELETE SET NULL,
  dimension_owner_id      uuid REFERENCES public.property_owners(id) ON DELETE SET NULL,

  line_no                 int NOT NULL DEFAULT 0,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at              timestamptz NOT NULL DEFAULT now(),

  CHECK ((debit_minor > 0 AND credit_minor = 0)
         OR (debit_minor = 0 AND credit_minor > 0))
);

CREATE INDEX IF NOT EXISTS journal_lines_entry_idx
  ON public.journal_lines(journal_entry_id, line_no);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx
  ON public.journal_lines(account_id);
CREATE INDEX IF NOT EXISTS journal_lines_unit_idx
  ON public.journal_lines(dimension_unit_id) WHERE dimension_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_lines_owner_idx
  ON public.journal_lines(dimension_owner_id) WHERE dimension_owner_id IS NOT NULL;


-- =====================================================================
-- 5. Post-guard triggers — append-only on posted entries
-- =====================================================================

CREATE OR REPLACE FUNCTION public.journal_entries_post_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Drafts: free-form.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Void: terminal.
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'journal_entries: void rows cannot be modified';
  END IF;

  -- Posted: only allow status -> void with reason.
  IF NEW.status = 'void' THEN
    IF NEW.voided_at IS NULL THEN NEW.voided_at := now(); END IF;
    IF coalesce(NEW.void_reason, '') = '' THEN
      RAISE EXCEPTION 'journal_entries: void requires void_reason';
    END IF;
    -- Lock all economic-relevant fields.
    NEW.entry_date     := OLD.entry_date;
    NEW.description    := OLD.description;
    NEW.currency       := OLD.currency;
    NEW.reference_kind := OLD.reference_kind;
    NEW.reference_id   := OLD.reference_id;
    NEW.posted_at      := OLD.posted_at;
    NEW.posted_by      := OLD.posted_by;
    RETURN NEW;
  END IF;

  -- Posted state, anything else → rejected. Allow only metadata-soft updates.
  IF NEW.entry_date    IS DISTINCT FROM OLD.entry_date
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.currency    IS DISTINCT FROM OLD.currency
     OR NEW.status      IS DISTINCT FROM OLD.status
     OR NEW.reference_kind IS DISTINCT FROM OLD.reference_kind
     OR NEW.reference_id   IS DISTINCT FROM OLD.reference_id
  THEN
    RAISE EXCEPTION 'journal_entries: posted rows are append-only. Use journal_entry_reverse instead.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_entries_post_guard ON public.journal_entries;
CREATE TRIGGER journal_entries_post_guard
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.journal_entries_post_guard_fn();


-- Lines guard: blocks any change once parent entry is posted.
CREATE OR REPLACE FUNCTION public.journal_lines_post_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM public.journal_entries
  WHERE id = coalesce(NEW.journal_entry_id, OLD.journal_entry_id);

  IF TG_OP IN ('UPDATE', 'DELETE') AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'journal_lines: parent entry is %, lines are immutable. Use journal_entry_reverse.', v_status;
  END IF;

  IF TG_OP = 'INSERT' AND v_status NOT IN ('draft', NULL) THEN
    -- Allow inserts during the SECURITY DEFINER reverse RPC by checking
    -- session_user. The RPC is the legitimate path for posting lines
    -- against a non-draft (the reversal entry is draft itself though).
    RAISE EXCEPTION 'journal_lines: cannot insert into a posted entry';
  END IF;

  RETURN coalesce(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_post_guard ON public.journal_lines;
CREATE TRIGGER journal_lines_post_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.journal_lines_post_guard_fn();


-- =====================================================================
-- 6. journal_entry_post — validation + status flip
-- =====================================================================

CREATE OR REPLACE FUNCTION public.journal_entry_post(p_entry_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status      text;
  v_currency    text;
  v_line_count  int;
  v_total_debit  bigint;
  v_total_credit bigint;
  v_currency_count int;
BEGIN
  IF NOT (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'journal_entry_post: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT status, currency INTO v_status, v_currency
  FROM public.journal_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal_entry_post: entry not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'journal_entry_post: entry must be draft (got %)', v_status;
  END IF;

  SELECT count(*), sum(debit_minor), sum(credit_minor),
         count(DISTINCT currency)
    INTO v_line_count, v_total_debit, v_total_credit, v_currency_count
  FROM public.journal_lines WHERE journal_entry_id = p_entry_id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'journal_entry_post: at least 2 lines required (got %)', v_line_count;
  END IF;
  IF v_currency_count > 1 THEN
    RAISE EXCEPTION 'journal_entry_post: all lines must share the same currency';
  END IF;
  IF v_total_debit IS NULL OR v_total_debit = 0 THEN
    RAISE EXCEPTION 'journal_entry_post: debits must be > 0';
  END IF;
  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'journal_entry_post: debits (%) <> credits (%)', v_total_debit, v_total_credit;
  END IF;

  UPDATE public.journal_entries
     SET status    = 'posted',
         posted_at = now(),
         posted_by = auth.uid()
   WHERE id = p_entry_id;

  RETURN p_entry_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.journal_entry_post(uuid) TO authenticated;


-- =====================================================================
-- 7. journal_entry_reverse — append-only correction
-- =====================================================================

CREATE OR REPLACE FUNCTION public.journal_entry_reverse(
  p_entry_id        uuid,
  p_reversal_date   date DEFAULT current_date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orig         record;
  v_new_id       uuid;
BEGIN
  IF NOT (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'journal_entry_reverse: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_orig FROM public.journal_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal_entry_reverse: entry not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_orig.status <> 'posted' THEN
    RAISE EXCEPTION 'journal_entry_reverse: entry must be posted (got %)', v_orig.status;
  END IF;

  INSERT INTO public.journal_entries
    (entry_date, description, reference_kind, reference_id, currency,
     status, reverses_entry_id, metadata, created_by)
  VALUES
    (p_reversal_date,
     'Reversal of ' || v_orig.entry_no || ': ' || v_orig.description,
     'manual',
     v_orig.entry_no,
     v_orig.currency,
     'draft',
     v_orig.id,
     v_orig.metadata,
     auth.uid())
  RETURNING id INTO v_new_id;

  -- Swap debits and credits per line.
  INSERT INTO public.journal_lines
    (journal_entry_id, account_id, debit_minor, credit_minor, currency,
     description, dimension_unit_id, dimension_lease_id, dimension_owner_id, line_no)
  SELECT
    v_new_id,
    account_id,
    credit_minor,  -- swap
    debit_minor,
    currency,
    'Reversal: ' || coalesce(description, ''),
    dimension_unit_id,
    dimension_lease_id,
    dimension_owner_id,
    line_no
  FROM public.journal_lines
  WHERE journal_entry_id = p_entry_id
  ORDER BY line_no, created_at;

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.journal_entry_reverse(uuid, date) TO authenticated;


-- =====================================================================
-- 8. auto_post_property_charge — operator-triggered
-- =====================================================================
--
-- Creates a draft journal_entry from a paid property_charge. Operator
-- reviews + posts manually. Idempotent on already-linked charges.
--
-- DR Cash (1002), CR Revenue account by kind:
--   rent  → 4001 Rent Revenue
--   dues  → 4010 Dues Revenue
--   late_fee → 4020 Late Fee Revenue
--   damage / security_deposit / adjustment / maintenance_pass_through:
--     deferred — operator posts manually with appropriate accounts.

CREATE OR REPLACE FUNCTION public.auto_post_property_charge(p_charge_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge       record;
  v_cash_id      uuid;
  v_rev_id       uuid;
  v_revenue_code text;
  v_entry_id     uuid;
BEGIN
  IF NOT (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'auto_post_property_charge: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT id, kind, status, total_minor, currency, lease_id, unit_id,
         charge_no
    INTO v_charge
  FROM public.property_charges
  WHERE id = p_charge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auto_post_property_charge: charge not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_charge.status <> 'paid' THEN
    RAISE EXCEPTION 'auto_post_property_charge: charge must be paid (got %)', v_charge.status;
  END IF;

  -- Idempotent: skip if a non-void entry already exists for this ref.
  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE reference_kind = 'property_charge'
      AND reference_id = p_charge_id::text
      AND status <> 'void'
  ) THEN
    SELECT id INTO v_entry_id FROM public.journal_entries
    WHERE reference_kind = 'property_charge'
      AND reference_id = p_charge_id::text
      AND status <> 'void'
    LIMIT 1;
    RETURN v_entry_id;
  END IF;

  v_revenue_code := CASE v_charge.kind
    WHEN 'rent'                     THEN '4001'
    WHEN 'dues'                     THEN '4010'
    WHEN 'late_fee'                 THEN '4020'
    WHEN 'maintenance_pass_through' THEN '4030'
    WHEN 'damage'                   THEN '4040'
    WHEN 'security_deposit'         THEN '2010' -- liability, not revenue
    ELSE NULL
  END;

  IF v_revenue_code IS NULL THEN
    RAISE EXCEPTION 'auto_post_property_charge: no auto-mapping for kind=%; create manually', v_charge.kind;
  END IF;

  SELECT id INTO v_cash_id FROM public.accounts WHERE code = '1002';
  SELECT id INTO v_rev_id  FROM public.accounts WHERE code = v_revenue_code;
  IF v_cash_id IS NULL OR v_rev_id IS NULL THEN
    RAISE EXCEPTION 'auto_post_property_charge: required accounts (1002, %) not found', v_revenue_code;
  END IF;

  INSERT INTO public.journal_entries
    (entry_date, description, reference_kind, reference_id,
     currency, status, created_by)
  VALUES
    (current_date,
     format('%s payment — %s', v_charge.kind, v_charge.charge_no),
     'property_charge',
     p_charge_id::text,
     v_charge.currency,
     'draft',
     auth.uid())
  RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_lines
    (journal_entry_id, account_id, debit_minor, credit_minor,
     currency, description, dimension_unit_id, dimension_lease_id, line_no)
  VALUES
    (v_entry_id, v_cash_id, v_charge.total_minor, 0,
     v_charge.currency, 'Cash receipt', v_charge.unit_id, v_charge.lease_id, 1),
    (v_entry_id, v_rev_id, 0, v_charge.total_minor,
     v_charge.currency, format('%s revenue', v_charge.kind),
     v_charge.unit_id, v_charge.lease_id, 2);

  RETURN v_entry_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_post_property_charge(uuid) TO authenticated;


-- =====================================================================
-- 9. auto_post_platform_fee
-- =====================================================================

CREATE OR REPLACE FUNCTION public.auto_post_platform_fee(p_charge_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_charge   record;
  v_cash_id  uuid;
  v_rev_id   uuid;
  v_entry_id uuid;
BEGIN
  IF NOT (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'auto_post_platform_fee: permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT id, status, amount_minor, currency, charge_no
    INTO v_charge
  FROM public.platform_fee_charges
  WHERE id = p_charge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auto_post_platform_fee: charge not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_charge.status <> 'paid' THEN
    RAISE EXCEPTION 'auto_post_platform_fee: charge must be paid (got %)', v_charge.status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE reference_kind = 'platform_fee'
      AND reference_id = p_charge_id::text
      AND status <> 'void'
  ) THEN
    SELECT id INTO v_entry_id FROM public.journal_entries
    WHERE reference_kind = 'platform_fee'
      AND reference_id = p_charge_id::text
      AND status <> 'void'
    LIMIT 1;
    RETURN v_entry_id;
  END IF;

  SELECT id INTO v_cash_id FROM public.accounts WHERE code = '1002';
  SELECT id INTO v_rev_id  FROM public.accounts WHERE code = '4100'; -- Platform Commission Revenue
  IF v_cash_id IS NULL OR v_rev_id IS NULL THEN
    RAISE EXCEPTION 'auto_post_platform_fee: required accounts (1002, 4100) not found';
  END IF;

  INSERT INTO public.journal_entries
    (entry_date, description, reference_kind, reference_id,
     currency, status, created_by)
  VALUES
    (current_date,
     format('Platform fee — %s', v_charge.charge_no),
     'platform_fee',
     p_charge_id::text,
     v_charge.currency,
     'draft',
     auth.uid())
  RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_lines
    (journal_entry_id, account_id, debit_minor, credit_minor,
     currency, description, line_no)
  VALUES
    (v_entry_id, v_cash_id, v_charge.amount_minor, 0,
     v_charge.currency, 'Platform fee receipt', 1),
    (v_entry_id, v_rev_id, 0, v_charge.amount_minor,
     v_charge.currency, 'Platform commission revenue', 2);

  RETURN v_entry_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_post_platform_fee(uuid) TO authenticated;


-- =====================================================================
-- 10. bank_accounts
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The GL cash account this bank account represents.
  account_id            uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,

  bank_name             text NOT NULL,
  account_number        text NOT NULL,
  account_name          text NOT NULL,
  branch                text,
  swift_code            text,

  currency              text NOT NULL DEFAULT 'PHP',
  account_type          text NOT NULL DEFAULT 'checking'
                             CHECK (account_type IN ('checking', 'savings', 'time_deposit')),

  status                text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'closed')),
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  opened_at             date NOT NULL DEFAULT current_date,
  closed_at             date,

  notes                 text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_accounts_status_idx
  ON public.bank_accounts(status);

DROP TRIGGER IF EXISTS set_bank_accounts_updated_at ON public.bank_accounts;
CREATE TRIGGER set_bank_accounts_updated_at
  BEFORE UPDATE ON public.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 11. bank_transactions — imported statement lines
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id             uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,

  posted_at                   date NOT NULL,
  description                 text,
  reference                   text,

  -- Signed: positive = credit/inflow, negative = debit/outflow.
  amount_minor                bigint NOT NULL,
  -- Running balance after this txn (per the bank's statement).
  balance_minor               bigint,

  -- Group import batches for reconciliation UX.
  import_batch_id             uuid,
  source                      text NOT NULL DEFAULT 'manual'
                                   CHECK (source IN ('manual', 'csv_import', 'api_import')),

  matched_journal_line_id     uuid REFERENCES public.journal_lines(id) ON DELETE SET NULL,
  matched_at                  timestamptz,
  matched_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  status                      text NOT NULL DEFAULT 'unmatched'
                                   CHECK (status IN
                                     ('unmatched', 'matched', 'manual', 'ignored')),

  notes                       text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_transactions_account_idx
  ON public.bank_transactions(bank_account_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS bank_transactions_status_idx
  ON public.bank_transactions(status, posted_at DESC);
CREATE INDEX IF NOT EXISTS bank_transactions_batch_idx
  ON public.bank_transactions(import_batch_id) WHERE import_batch_id IS NOT NULL;

-- One bank txn matches one journal line at most.
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_one_match_per_line
  ON public.bank_transactions(matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_bank_transactions_updated_at ON public.bank_transactions;
CREATE TRIGGER set_bank_transactions_updated_at
  BEFORE UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();

COMMENT ON COLUMN public.bank_transactions.amount_minor IS
  'Signed: positive = credit / inflow into the bank account; negative = debit / outflow.';


-- =====================================================================
-- 12. bir_export_runs — placeholder for compliance reports
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.bir_export_runs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Documented values: 'sales_book', 'purchases_book', '2307',
  -- 'vat_relief', 'monthly_remittance'.
  run_kind                    text NOT NULL,

  period_start                date NOT NULL,
  period_end                  date NOT NULL,

  status                      text NOT NULL DEFAULT 'draft'
                                   CHECK (status IN
                                     ('draft', 'generated', 'submitted', 'voided')),

  line_count                  int  NOT NULL DEFAULT 0,
  total_amount_minor          bigint NOT NULL DEFAULT 0,

  -- S3 key for the generated CSV/XLSX file.
  file_storage_key            text,

  generated_at                timestamptz,
  filed_at                    timestamptz,
  voided_at                   timestamptz,
  void_reason                 text,

  notes                       text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS bir_export_runs_period_idx
  ON public.bir_export_runs(period_end DESC);
CREATE INDEX IF NOT EXISTS bir_export_runs_kind_idx
  ON public.bir_export_runs(run_kind, period_end DESC);

DROP TRIGGER IF EXISTS set_bir_export_runs_updated_at ON public.bir_export_runs;
CREATE TRIGGER set_bir_export_runs_updated_at
  BEFORE UPDATE ON public.bir_export_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();


-- =====================================================================
-- 13. account_balances + trial_balance + bank_reconciliation_status views
-- =====================================================================

CREATE OR REPLACE VIEW public.account_balances AS
SELECT
  a.id                   AS account_id,
  a.code,
  a.name,
  a.account_type,
  a.currency,
  coalesce(sum(jl.debit_minor)  FILTER (WHERE je.status = 'posted'), 0) AS total_debit_minor,
  coalesce(sum(jl.credit_minor) FILTER (WHERE je.status = 'posted'), 0) AS total_credit_minor,
  coalesce(sum(jl.debit_minor)  FILTER (WHERE je.status = 'posted'), 0)
  - coalesce(sum(jl.credit_minor) FILTER (WHERE je.status = 'posted'), 0)
                                                                       AS net_balance_minor
FROM public.accounts a
LEFT JOIN public.journal_lines jl ON jl.account_id = a.id
LEFT JOIN public.journal_entries je ON je.id = jl.journal_entry_id
GROUP BY a.id, a.code, a.name, a.account_type, a.currency;

GRANT SELECT ON public.account_balances TO authenticated;


CREATE OR REPLACE VIEW public.trial_balance AS
SELECT
  a.code,
  a.name,
  a.account_type,
  a.currency,
  CASE
    WHEN a.account_type IN ('asset', 'expense')
      THEN coalesce(sum(jl.debit_minor) FILTER (WHERE je.status='posted'), 0)
         - coalesce(sum(jl.credit_minor) FILTER (WHERE je.status='posted'), 0)
    ELSE 0
  END                                                          AS debit_balance_minor,
  CASE
    WHEN a.account_type IN ('liability', 'equity', 'revenue')
      THEN coalesce(sum(jl.credit_minor) FILTER (WHERE je.status='posted'), 0)
         - coalesce(sum(jl.debit_minor) FILTER (WHERE je.status='posted'), 0)
    ELSE 0
  END                                                          AS credit_balance_minor
FROM public.accounts a
LEFT JOIN public.journal_lines jl ON jl.account_id = a.id
LEFT JOIN public.journal_entries je ON je.id = jl.journal_entry_id
WHERE a.is_active = true
GROUP BY a.code, a.name, a.account_type, a.currency
ORDER BY a.code;

GRANT SELECT ON public.trial_balance TO authenticated;


CREATE OR REPLACE VIEW public.bank_reconciliation_status AS
SELECT
  ba.id           AS bank_account_id,
  ba.bank_name,
  ba.account_number,
  count(bt.*)                                              AS total_txns,
  count(bt.*) FILTER (WHERE bt.status = 'matched')          AS matched_count,
  count(bt.*) FILTER (WHERE bt.status = 'unmatched')        AS unmatched_count,
  count(bt.*) FILTER (WHERE bt.status = 'manual')           AS manual_count,
  count(bt.*) FILTER (WHERE bt.status = 'ignored')          AS ignored_count,
  sum(bt.amount_minor) FILTER (WHERE bt.status = 'unmatched') AS unmatched_amount_minor,
  max(bt.posted_at)                                         AS most_recent_txn_at
FROM public.bank_accounts ba
LEFT JOIN public.bank_transactions bt ON bt.bank_account_id = ba.id
GROUP BY ba.id, ba.bank_name, ba.account_number;

GRANT SELECT ON public.bank_reconciliation_status TO authenticated;


-- =====================================================================
-- 14. Permissions
-- =====================================================================

INSERT INTO public.permissions (name, description, category) VALUES
  ('accounting.manage',
   'Manage chart of accounts, journal entries, bank reconciliation, BIR exports',
   'accounting')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('admin',   'accounting.manage'),
  ('manager', 'accounting.manage')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 15. RLS
-- =====================================================================

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounts_select ON public.accounts;
CREATE POLICY accounts_select ON public.accounts FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS accounts_insert ON public.accounts;
CREATE POLICY accounts_insert ON public.accounts FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS accounts_update ON public.accounts;
CREATE POLICY accounts_update ON public.accounts FOR UPDATE
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS accounts_delete ON public.accounts;
CREATE POLICY accounts_delete ON public.accounts FOR DELETE
  TO authenticated
  USING (
    (public.has_permission('accounting.manage') OR public.has_permission('admin.access'))
    AND is_system = false
  );


ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS journal_entries_select ON public.journal_entries;
CREATE POLICY journal_entries_select ON public.journal_entries FOR SELECT
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS journal_entries_modify ON public.journal_entries;
CREATE POLICY journal_entries_modify ON public.journal_entries FOR ALL
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS journal_lines_select ON public.journal_lines;
CREATE POLICY journal_lines_select ON public.journal_lines FOR SELECT
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS journal_lines_modify ON public.journal_lines;
CREATE POLICY journal_lines_modify ON public.journal_lines FOR ALL
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_accounts_select ON public.bank_accounts;
CREATE POLICY bank_accounts_select ON public.bank_accounts FOR SELECT
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS bank_accounts_modify ON public.bank_accounts;
CREATE POLICY bank_accounts_modify ON public.bank_accounts FOR ALL
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bank_transactions_select ON public.bank_transactions;
CREATE POLICY bank_transactions_select ON public.bank_transactions FOR SELECT
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS bank_transactions_modify ON public.bank_transactions;
CREATE POLICY bank_transactions_modify ON public.bank_transactions FOR ALL
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );


ALTER TABLE public.bir_export_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bir_export_runs_select ON public.bir_export_runs;
CREATE POLICY bir_export_runs_select ON public.bir_export_runs FOR SELECT
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );

DROP POLICY IF EXISTS bir_export_runs_modify ON public.bir_export_runs;
CREATE POLICY bir_export_runs_modify ON public.bir_export_runs FOR ALL
  TO authenticated
  USING (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  )
  WITH CHECK (
    public.has_permission('accounting.manage')
    OR public.has_permission('admin.access')
  );


-- =====================================================================
-- 16. Schema governance
-- =====================================================================

INSERT INTO public.governance_schema_contracts
  (contract_name, contract_type, owner_repo, consumers, description, is_public)
VALUES
  ('public.accounts',                    'table', 'userportal',
   ARRAY['userportal']::text[], 'Chart of accounts',                     false),
  ('public.journal_entries',             'table', 'userportal',
   ARRAY['userportal']::text[], 'Journal entry headers',                 false),
  ('public.journal_lines',               'table', 'userportal',
   ARRAY['userportal']::text[], 'Journal line debits/credits',           false),
  ('public.bank_accounts',               'table', 'userportal',
   ARRAY['userportal']::text[], 'Physical bank accounts',                false),
  ('public.bank_transactions',           'table', 'userportal',
   ARRAY['userportal']::text[], 'Imported bank statement lines',         false),
  ('public.bir_export_runs',             'table', 'userportal',
   ARRAY['userportal']::text[], 'Periodic BIR compliance export runs',   false),
  ('public.account_balances',            'view',  'userportal',
   ARRAY['userportal']::text[], 'Per-account running balance',           false),
  ('public.trial_balance',               'view',  'userportal',
   ARRAY['userportal']::text[], 'Trial balance at posted-entry state',  false),
  ('public.bank_reconciliation_status',  'view',  'userportal',
   ARRAY['userportal']::text[], 'Per-bank-account reconciliation rollup', false)
ON CONFLICT (contract_name) DO NOTHING;


-- =====================================================================
-- 17. Seed default chart of accounts (PH SMB conventions)
-- =====================================================================

INSERT INTO public.accounts (code, name, account_type, is_system, bir_classification, description) VALUES
  -- ASSETS
  ('1001', 'Cash on Hand',                     'asset',     true,  'non_vatable', 'Petty cash and till'),
  ('1002', 'Cash in Bank',                     'asset',     true,  'non_vatable', 'Primary operating bank account'),
  ('1100', 'Accounts Receivable',              'asset',     true,  'non_vatable', 'General trade receivables'),
  ('1110', 'Rent Receivable',                  'asset',     false, 'non_vatable', 'Tenant rent owed'),
  ('1120', 'Dues Receivable',                  'asset',     false, 'non_vatable', 'Owner dues owed'),
  ('1200', 'Prepaid Expenses',                 'asset',     false, 'non_vatable', NULL),
  ('1300', 'Property, Plant, and Equipment',   'asset',     false, 'non_vatable', NULL),

  -- LIABILITIES
  ('2001', 'Accounts Payable',                 'liability', true,  'non_vatable', 'Vendor amounts owed'),
  ('2010', 'Security Deposits Held',           'liability', true,  'non_vatable', 'Tenant security deposits (refundable)'),
  ('2020', 'Tenant Advance Payments',          'liability', false, 'non_vatable', NULL),
  ('2100', 'Output VAT Payable',               'liability', true,  'vatable',     'VAT on revenue, due to BIR'),
  ('2110', 'Input VAT',                        'asset',     true,  'vatable',     'VAT on purchases, claimable from BIR'),
  ('2200', 'Withholding Tax Payable',          'liability', true,  'non_vatable', 'BIR withholding remittances'),
  ('2300', 'Income Tax Payable',               'liability', true,  'non_vatable', NULL),

  -- EQUITY
  ('3001', 'Owner''s Equity',                  'equity',    true,  'non_vatable', NULL),
  ('3100', 'Retained Earnings',                'equity',    true,  'non_vatable', NULL),

  -- REVENUE
  ('4001', 'Rent Revenue',                     'revenue',   true,  'vatable',     'Recurring rent income'),
  ('4010', 'Dues Revenue',                     'revenue',   true,  'vatable',     'HOA / condo dues income'),
  ('4020', 'Late Fee Revenue',                 'revenue',   false, 'vatable',     NULL),
  ('4030', 'Maintenance Pass-Through',         'revenue',   false, 'non_vatable', 'Maintenance billed to tenants'),
  ('4040', 'Damage Recovery',                  'revenue',   false, 'non_vatable', NULL),
  ('4100', 'Platform Commission Revenue',      'revenue',   true,  'vatable',     'Platform take from broker commissions'),
  ('4200', 'Brokerage Commission Revenue',     'revenue',   false, 'vatable',     'Broker commission earned'),

  -- EXPENSES
  ('6001', 'Maintenance Expense',              'expense',   false, 'vatable',     NULL),
  ('6010', 'Utilities Expense',                'expense',   false, 'vatable',     NULL),
  ('6020', 'Property Tax Expense',             'expense',   false, 'non_vatable', 'Real property tax (LGU)'),
  ('6030', 'Insurance Expense',                'expense',   false, 'non_vatable', NULL),
  ('6040', 'Management Fee Expense',           'expense',   false, 'vatable',     NULL),
  ('6100', 'Bank Charges',                     'expense',   false, 'non_vatable', NULL),
  ('6110', 'Payment Gateway Fees',             'expense',   false, 'vatable',     NULL),
  ('6200', 'Office Expense',                   'expense',   false, 'vatable',     NULL),
  ('6300', 'Professional Fees',                'expense',   false, 'vatable',     NULL),
  ('6400', 'BIR Withholding (Paid)',           'expense',   false, 'non_vatable', NULL),
  ('6900', 'Misc Expense',                     'expense',   false, 'non_vatable', NULL)
ON CONFLICT (code) DO NOTHING;


NOTIFY pgrst, 'reload schema';
