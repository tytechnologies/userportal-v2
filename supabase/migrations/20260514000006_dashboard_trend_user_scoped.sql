-- User-scoped variants of the dashboard trend + funnel RPCs.
--
-- Originals (20260502000009 / 20260502000010) are SECURITY INVOKER
-- and assumed RLS would scope the underlying tables. listings RLS
-- is permissive for the MLS cross-broker visibility feature, so
-- brokers/agents were seeing platform-wide aggregates in their trend
-- charts.
--
-- This migration adds three new RPCs that take an explicit p_user_id
-- and scope the aggregates accordingly. Originals are left in place
-- (admins still call them for platform-wide rollups).
--
-- - dashboard_trend_daily_for_user(days_back, p_user_id)
-- - dashboard_trend_daily_range_for_user(from_date, to_date, p_user_id)
-- - dashboard_inquiry_funnel_range_for_user(from_date, to_date, p_user_id)
--
-- Each scopes to:
--   listings:  created_by = p_user_id
--   inquiries: assigned_user_id = p_user_id
--   tasks:     assignee_user_id = p_user_id
-- per [[assignee-column-names]].
--
-- Strictly additive. Originals untouched.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.dashboard_trend_daily_for_user(int, uuid);
--   DROP FUNCTION IF EXISTS public.dashboard_trend_daily_range_for_user(date, date, uuid);
--   DROP FUNCTION IF EXISTS public.dashboard_inquiry_funnel_range_for_user(date, date, uuid);


CREATE OR REPLACE FUNCTION public.dashboard_trend_daily_for_user(
  days_back int DEFAULT 30,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  day        date,
  inquiries  bigint,
  listings   bigint,
  tasks_done bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH spine AS (
    SELECT (current_date - (s || ' days')::interval)::date AS day
    FROM generate_series(0, GREATEST(days_back, 1) - 1) AS s
  ),
  inq AS (
    SELECT created_at::date AS day, count(*)::bigint AS n
    FROM public.inquiries
    WHERE created_at >= current_date - (GREATEST(days_back, 1) || ' days')::interval
      AND (p_user_id IS NULL OR assigned_user_id = p_user_id)
    GROUP BY 1
  ),
  lst AS (
    SELECT created_at::date AS day, count(*)::bigint AS n
    FROM public.listings
    WHERE created_at >= current_date - (GREATEST(days_back, 1) || ' days')::interval
      AND deleted_at IS NULL
      AND (p_user_id IS NULL OR created_by = p_user_id)
    GROUP BY 1
  ),
  tsk AS (
    SELECT completed_at::date AS day, count(*)::bigint AS n
    FROM public.tasks
    WHERE completed_at IS NOT NULL
      AND completed_at >= current_date - (GREATEST(days_back, 1) || ' days')::interval
      AND (p_user_id IS NULL OR assignee_user_id = p_user_id)
    GROUP BY 1
  )
  SELECT
    spine.day,
    COALESCE(inq.n, 0)::bigint AS inquiries,
    COALESCE(lst.n, 0)::bigint AS listings,
    COALESCE(tsk.n, 0)::bigint AS tasks_done
  FROM spine
  LEFT JOIN inq ON inq.day = spine.day
  LEFT JOIN lst ON lst.day = spine.day
  LEFT JOIN tsk ON tsk.day = spine.day
  ORDER BY spine.day ASC;
$$;

COMMENT ON FUNCTION public.dashboard_trend_daily_for_user(int, uuid) IS
  'Same as dashboard_trend_daily(days_back) but scoped to a single user when p_user_id is non-null. Pass NULL for platform-wide (matches the original RPC behavior).';

GRANT EXECUTE ON FUNCTION public.dashboard_trend_daily_for_user(int, uuid)
  TO authenticated;


CREATE OR REPLACE FUNCTION public.dashboard_trend_daily_range_for_user(
  from_date date,
  to_date   date,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  day        date,
  inquiries  bigint,
  listings   bigint,
  tasks_done bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT LEAST(from_date, to_date) AS lo, GREATEST(from_date, to_date) AS hi
  ),
  spine AS (
    SELECT (lo + (s || ' days')::interval)::date AS day
    FROM bounds, generate_series(0, LEAST((hi - lo)::int, 365)) AS s
  ),
  inq AS (
    SELECT created_at::date AS day, count(*)::bigint AS n
    FROM public.inquiries, bounds
    WHERE created_at::date BETWEEN bounds.lo AND bounds.hi
      AND (p_user_id IS NULL OR assigned_user_id = p_user_id)
    GROUP BY 1
  ),
  lst AS (
    SELECT created_at::date AS day, count(*)::bigint AS n
    FROM public.listings, bounds
    WHERE created_at::date BETWEEN bounds.lo AND bounds.hi
      AND deleted_at IS NULL
      AND (p_user_id IS NULL OR created_by = p_user_id)
    GROUP BY 1
  ),
  tsk AS (
    SELECT completed_at::date AS day, count(*)::bigint AS n
    FROM public.tasks, bounds
    WHERE completed_at IS NOT NULL
      AND completed_at::date BETWEEN bounds.lo AND bounds.hi
      AND (p_user_id IS NULL OR assignee_user_id = p_user_id)
    GROUP BY 1
  )
  SELECT
    spine.day,
    COALESCE(inq.n, 0)::bigint AS inquiries,
    COALESCE(lst.n, 0)::bigint AS listings,
    COALESCE(tsk.n, 0)::bigint AS tasks_done
  FROM spine
  LEFT JOIN inq ON inq.day = spine.day
  LEFT JOIN lst ON lst.day = spine.day
  LEFT JOIN tsk ON tsk.day = spine.day
  ORDER BY spine.day ASC;
$$;

COMMENT ON FUNCTION public.dashboard_trend_daily_range_for_user(date, date, uuid) IS
  'Date-bounded version of dashboard_trend_daily_for_user. Pass NULL p_user_id for platform-wide aggregates.';

GRANT EXECUTE ON FUNCTION public.dashboard_trend_daily_range_for_user(date, date, uuid)
  TO authenticated;


CREATE OR REPLACE FUNCTION public.dashboard_inquiry_funnel_range_for_user(
  from_date date,
  to_date   date,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  status text,
  count  bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT LEAST(from_date, to_date) AS lo, GREATEST(from_date, to_date) AS hi
  )
  SELECT i.status::text, count(*)::bigint
  FROM public.inquiries i, bounds
  WHERE i.created_at::date BETWEEN bounds.lo AND bounds.hi
    AND (p_user_id IS NULL OR i.assigned_user_id = p_user_id)
  GROUP BY i.status;
$$;

COMMENT ON FUNCTION public.dashboard_inquiry_funnel_range_for_user(date, date, uuid) IS
  'Date-bounded inquiry funnel scoped to a user when p_user_id is non-null. Pass NULL for platform-wide.';

GRANT EXECUTE ON FUNCTION public.dashboard_inquiry_funnel_range_for_user(date, date, uuid)
  TO authenticated;


NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- SMOKE
-- =====================================================================
-- 1) Functions exist + grants
-- SELECT routine_name, security_type FROM information_schema.routines
--  WHERE routine_schema='public'
--    AND routine_name IN (
--      'dashboard_trend_daily_for_user',
--      'dashboard_trend_daily_range_for_user',
--      'dashboard_inquiry_funnel_range_for_user'
--    );
--
-- 2) Platform-wide call (NULL user)
-- SELECT * FROM public.dashboard_trend_daily_for_user(7, NULL);
--
-- 3) Per-user call (replace with your uid)
-- SELECT * FROM public.dashboard_trend_daily_for_user(30, '<your-uid>'::uuid);
