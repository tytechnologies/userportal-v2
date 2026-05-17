-- First-sign-in product tour bookkeeping.
--
-- One additive column on `profiles` so we know whether a user has
-- finished (or skipped) the in-app onboarding walkthrough. A new
-- SECURITY DEFINER RPC marks it complete for the currently
-- authenticated user — keeps the write path immune to spoofing
-- (caller can't claim someone else's profile is "complete").
--
-- The tour itself lives client-side; this migration only persists the
-- "have they seen it" boolean so the next sign-in skips re-trigger.
--
-- Strictly additive. No reference table touched.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.complete_onboarding_tour(boolean);
--   ALTER TABLE public.profiles
--     DROP COLUMN IF EXISTS onboarding_skipped,
--     DROP COLUMN IF EXISTS onboarding_completed_at;


-- =====================================================================
-- 0. Preconditions
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='profiles') THEN
    RAISE EXCEPTION 'Migration 20260514000005 requires public.profiles'
      USING ERRCODE='42P01';
  END IF;
END $$;


-- =====================================================================
-- 1. Profile flags (additive)
-- =====================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS onboarding_skipped      boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.onboarding_completed_at IS
  'Timestamp the user finished (or dismissed) the first-sign-in product tour. NULL = tour has not been shown yet, so the layout auto-starts it on next load.';

COMMENT ON COLUMN public.profiles.onboarding_skipped IS
  'TRUE if the user hit "Skip" instead of clicking through every step. Used for telemetry; does not affect whether the tour re-fires (completed_at is the gate).';


-- =====================================================================
-- 2. complete_onboarding_tour RPC
-- =====================================================================
-- SECURITY DEFINER so the client can mark completion without needing
-- direct UPDATE grant on profiles. Pinned to auth.uid() — there is
-- NO way for a caller to mark someone else's profile complete.

CREATE OR REPLACE FUNCTION public.complete_onboarding_tour(p_skipped boolean DEFAULT false)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_row public.profiles%ROWTYPE;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE public.profiles
     SET onboarding_completed_at = now(),
         onboarding_skipped       = COALESCE(p_skipped, false)
   WHERE id = v_uid
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'profile not found for auth.uid()=%', v_uid
      USING ERRCODE = '42704';
  END IF;

  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.complete_onboarding_tour(boolean)
  TO authenticated, service_role;


-- =====================================================================
-- 3. Governance
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public'
                    AND table_name='governance_schema_contracts') THEN
    RETURN;
  END IF;
  INSERT INTO public.governance_schema_contracts
    (contract_name, contract_type, owner_repo, consumers, description, is_public)
  VALUES
    ('public.complete_onboarding_tour', 'function', 'userportal',
     ARRAY['userportal'],
     'Marks the calling user''s onboarding tour complete. SECURITY DEFINER, auth.uid()-gated.',
     false)
  ON CONFLICT (contract_name) DO NOTHING;
END $$;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
-- 1) Columns landed.
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='profiles'
--    AND column_name IN ('onboarding_completed_at','onboarding_skipped');
--
-- 2) Mark current logged-in user as complete (run from PostgREST as the
--    user — supabase.rpc('complete_onboarding_tour', { p_skipped: false })).
--
-- 3) Reset for re-testing:
-- UPDATE public.profiles SET onboarding_completed_at = NULL
--  WHERE id = auth.uid();
