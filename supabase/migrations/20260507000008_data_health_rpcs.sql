-- Data-health surface for the admin system-status card.
--
-- WHY:
-- Two categories of "orphan" data routinely cause production bugs:
--
--   1. listings.created_by holds UUIDs whose profiles row was deleted
--      or never existed (legacy data, ingested feeds). Hit on
--      2026-05-07 — caused inquiries.assigned_user_id FK violations
--      → 500 → website mailto fallback. The endpoint now preflights
--      and falls back to NULL, but operators need to see the backlog
--      so they can drive it down.
--
--   2. inquiries.assigned_user_id IS NULL — either a bot submission
--      against an unowned listing, or the orphan-created_by fallback
--      kicked in. These need a manager to manually route.
--
-- This migration adds two cheap admin-only RPCs that the system-status
-- endpoint can call. NOT EXISTS anti-joins planned as merge/hash
-- depending on cardinality; both are O(rows) with PK index support.
--
-- Permission gate uses the same ops-bypass pattern as the legacy
-- reconcile RPCs (see memory: feedback_security_definer_smoke_tests):
-- has_permission OR session_user IN (postgres, supabase_admin,
-- service_role).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.count_orphan_listings_created_by();
--   DROP FUNCTION IF EXISTS public.count_unassigned_inquiries();

CREATE OR REPLACE FUNCTION public.count_orphan_listings_created_by()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orphan_count int;
  v_total_with_creator int;
BEGIN
  IF NOT (
    public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: admin.access required'
      USING ERRCODE = '42501';
  END IF;

  -- Anti-join: listings whose created_by points at a non-existent
  -- profile. NOT EXISTS plays well with Postgres planner — the
  -- profiles(id) PK index gives us O(N) on listings count.
  SELECT count(*)
    INTO v_orphan_count
    FROM public.listings l
   WHERE l.created_by IS NOT NULL
     AND l.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.id = l.created_by
     );

  -- Denominator for "X% of active listings are orphan"-style framing
  -- in the UI. Cheap second count under the same predicate.
  SELECT count(*)
    INTO v_total_with_creator
    FROM public.listings l
   WHERE l.created_by IS NOT NULL
     AND l.deleted_at IS NULL;

  RETURN jsonb_build_object(
    'orphan_count',         v_orphan_count,
    'total_with_creator',   v_total_with_creator
  );
END;
$$;

REVOKE ALL ON FUNCTION public.count_orphan_listings_created_by() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.count_orphan_listings_created_by() TO authenticated;

COMMENT ON FUNCTION public.count_orphan_listings_created_by() IS
  'Admin-only RPC. Counts listings whose created_by UUID has no matching profiles row — these need reconciliation or the inquiries assignment falls back to NULL. Cheap anti-join on profiles(id) PK.';


CREATE OR REPLACE FUNCTION public.count_unassigned_inquiries()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unassigned_total int;
  v_unassigned_recent int;
  v_total int;
BEGIN
  IF NOT (
    public.has_permission('admin.access')
    OR session_user IN ('postgres', 'supabase_admin', 'service_role')
  ) THEN
    RAISE EXCEPTION 'permission denied: admin.access required'
      USING ERRCODE = '42501';
  END IF;

  -- Two splits: total unassigned + recent (last 7d). Recent is the
  -- actionable bucket; older unassigned rows are likely already cold.
  SELECT count(*)
    INTO v_unassigned_total
    FROM public.inquiries
   WHERE assigned_user_id IS NULL;

  SELECT count(*)
    INTO v_unassigned_recent
    FROM public.inquiries
   WHERE assigned_user_id IS NULL
     AND created_at >= now() - interval '7 days';

  SELECT count(*)
    INTO v_total
    FROM public.inquiries;

  RETURN jsonb_build_object(
    'unassigned_total',  v_unassigned_total,
    'unassigned_recent', v_unassigned_recent,
    'total',             v_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.count_unassigned_inquiries() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.count_unassigned_inquiries() TO authenticated;

COMMENT ON FUNCTION public.count_unassigned_inquiries() IS
  'Admin-only RPC. Counts inquiries with NULL assigned_user_id — bot submissions against unowned listings + orphan-created_by fallback rows. Recent (7d) split is the actionable bucket.';


NOTIFY pgrst, 'reload schema';
