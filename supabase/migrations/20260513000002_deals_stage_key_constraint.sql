-- deals.stage_key — promote documented allowlist into a real constraint.
--
-- Background:
--   public.deals.stage_key was created as free-form text in mig
--   20260507000021 with the documented allowlist living only in the
--   migration's header comment. The canonical business spec requires
--   the pipeline stages to be a fixed set ("Prevent invalid
--   progression"). With no DB-level enforcement, a typo in any client
--   call — admin UI, RPC, partner integration — silently writes an
--   off-allowlist value and the kanban + reporting render it as an
--   orphan column.
--
--   Additionally, the closed_at / closed_won / stage_key trio is
--   semantically coupled (closed_won=true ↔ stage_key='closed_won')
--   but nothing in the schema enforces the coherence. A deal can
--   currently be in stage_key='negotiating' with closed_at NOT NULL —
--   meaningless state.
--
-- This migration adds two CHECK constraints with NOT VALID so they
-- apply to all FUTURE writes without scanning existing rows. If
-- existing rows happen to be clean (likely — the documented allowlist
-- has been respected by the only writer paths), the operator can
-- promote each constraint to VALIDATE in a follow-up:
--
--   ALTER TABLE public.deals VALIDATE CONSTRAINT deals_stage_key_allowlist;
--   ALTER TABLE public.deals VALIDATE CONSTRAINT deals_closed_state_coherence;
--
-- Both VALIDATE statements are cheap (one full-table scan, no lock
-- escalation past ShareUpdateExclusive). If either fails, the offending
-- rows surface in the error — operator decides whether to backfill
-- or extend the allowlist.
--
-- Strictly additive. No columns / FKs / triggers touched. Reference
-- schema untouched (deals isn't in db-main-reference — it's a NEW
-- post-MySQL table per the PK typing rule).
--
-- ROLLBACK:
--   ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_stage_key_allowlist;
--   ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_closed_state_coherence;
--   DELETE FROM public.governance_schema_contracts
--    WHERE contract_name IN (
--      'deals.stage_key.allowlist',
--      'deals.closed_state.coherence'
--    );
--
-- DEPENDS ON:
--   20260507000021_deals_pipeline.sql  (creates deals + stage_key column)


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='deals') THEN
    RAISE EXCEPTION
      'Migration 20260513000002 requires public.deals (mig 507000021)'
      USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='deals'
                    AND column_name='stage_key') THEN
    RAISE EXCEPTION
      'Migration 20260513000002 requires public.deals.stage_key'
      USING ERRCODE = '42703';
  END IF;
END $$;


-- =====================================================================
-- 1. Allowlist CHECK on stage_key
-- =====================================================================
-- Order matches the documented pipeline progression. An operator can
-- extend the list by amending this constraint:
--
--   ALTER TABLE public.deals DROP CONSTRAINT deals_stage_key_allowlist;
--   ALTER TABLE public.deals ADD CONSTRAINT deals_stage_key_allowlist
--     CHECK (stage_key IN (... + new_value ...)) NOT VALID;
--
-- That's intentionally a hard ceremony — accidental stage proliferation
-- erodes the kanban's signal value.

ALTER TABLE public.deals
  ADD CONSTRAINT deals_stage_key_allowlist
  CHECK (stage_key IN (
    'inquiry_received',
    'contacted',
    'viewing_scheduled',
    'viewing_completed',
    'negotiating',
    'reservation',
    'documentation',
    'financing',
    'closing',
    'closed_won',
    'closed_lost'
  ))
  NOT VALID;

COMMENT ON CONSTRAINT deals_stage_key_allowlist ON public.deals IS
  'Pipeline allowlist. NOT VALID at creation — applies to future writes only. Operator can run VALIDATE CONSTRAINT after backfilling any off-allowlist rows surfaced by the smoke probe in this migration''s footer.';


-- =====================================================================
-- 2. Closed-state coherence
-- =====================================================================
-- The three closed-state columns are coupled:
--   closed_at NULL ↔ closed_won NULL ↔ stage_key NOT IN ('closed_won','closed_lost')
--   closed_won=true ↔ stage_key='closed_won'
--   closed_won=false ↔ stage_key='closed_lost'
--
-- This CHECK encodes that coherence directly. Same NOT VALID strategy
-- as the allowlist — existing rows untouched; new writes enforced.

ALTER TABLE public.deals
  ADD CONSTRAINT deals_closed_state_coherence
  CHECK (
    (closed_at IS NULL AND closed_won IS NULL
     AND stage_key NOT IN ('closed_won', 'closed_lost'))
    OR
    (closed_at IS NOT NULL AND closed_won = true
     AND stage_key = 'closed_won')
    OR
    (closed_at IS NOT NULL AND closed_won = false
     AND stage_key = 'closed_lost')
  )
  NOT VALID;

COMMENT ON CONSTRAINT deals_closed_state_coherence ON public.deals IS
  'closed_at / closed_won / stage_key must agree. NOT VALID at creation; new writes enforced. VALIDATE only after auditing pre-existing closed rows.';


-- =====================================================================
-- 3. Governance contracts
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='governance_schema_contracts') THEN
    RETURN;
  END IF;

  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('deals.stage_key.allowlist', 'function', 'userportal', ARRAY['userportal'],
     'CHECK constraint on public.deals.stage_key enforcing the documented pipeline allowlist. NOT VALID — applies to new writes; existing rows untouched until operator runs VALIDATE.', false),
    ('deals.closed_state.coherence', 'function', 'userportal', ARRAY['userportal'],
     'CHECK constraint on public.deals enforcing closed_at / closed_won / stage_key coherence. NOT VALID — applies to new writes; existing rows untouched until operator runs VALIDATE.', false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
--
-- 1) Confirm both constraints exist + NOT VALID.
-- SELECT conname, convalidated
--   FROM pg_constraint
--  WHERE conrelid = 'public.deals'::regclass
--    AND conname IN ('deals_stage_key_allowlist', 'deals_closed_state_coherence');
--
-- 2) Surface any pre-existing off-allowlist stage_keys (operator audit).
-- SELECT stage_key, count(*) AS deals
--   FROM public.deals
--  WHERE stage_key NOT IN (
--    'inquiry_received','contacted','viewing_scheduled','viewing_completed',
--    'negotiating','reservation','documentation','financing','closing',
--    'closed_won','closed_lost'
--  )
--  GROUP BY stage_key
--  ORDER BY count(*) DESC;
--
-- 3) Surface any pre-existing closed-state incoherence.
-- SELECT id, stage_key, closed_at, closed_won
--   FROM public.deals
--  WHERE NOT (
--    (closed_at IS NULL AND closed_won IS NULL
--     AND stage_key NOT IN ('closed_won','closed_lost'))
--    OR
--    (closed_at IS NOT NULL AND closed_won = true  AND stage_key = 'closed_won')
--    OR
--    (closed_at IS NOT NULL AND closed_won = false AND stage_key = 'closed_lost')
--  )
--  ORDER BY updated_at DESC
--  LIMIT 50;
--
-- 4) If (2) and (3) return zero rows, promote both constraints to VALID:
-- ALTER TABLE public.deals VALIDATE CONSTRAINT deals_stage_key_allowlist;
-- ALTER TABLE public.deals VALIDATE CONSTRAINT deals_closed_state_coherence;
--
-- 5) Negative test — inserting a deal with an invalid stage_key now errors.
-- INSERT INTO public.deals (listing_id, stage_key)
-- VALUES ((SELECT id FROM public.listings ORDER BY id LIMIT 1), 'bogus_stage');
-- -- expect: 23514 — check violation: deals_stage_key_allowlist
