-- RPC powering the dashboard trend chart. Returns daily buckets for
-- the last N days (default 30) of three signals:
--
--   - inquiries created
--   - listings created
--   - tasks completed
--
-- Single round trip; PostgREST exposes it as a stored procedure that
-- the client calls via supabase.rpc(). RLS is honored — function is
-- SECURITY INVOKER so each table's RLS scopes what the caller sees
-- (agents see own, managers see team, admins see all).
--
-- Returned shape (one row per day, oldest first, holes filled with 0):
--   day            date
--   inquiries      bigint
--   listings       bigint
--   tasks_done     bigint
--
-- DEPENDS ON:
--   public.inquiries (20260502000006), public.listings, public.tasks
--   (20260501000009)

CREATE OR REPLACE FUNCTION public.dashboard_trend_daily(days_back int DEFAULT 30)
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
    -- Generate the day spine first so days with zero rows still appear.
    SELECT (current_date - (s || ' days')::interval)::date AS day
    FROM generate_series(0, GREATEST(days_back, 1) - 1) AS s
  ),
  inq AS (
    SELECT created_at::date AS day, count(*)::bigint AS n
    FROM public.inquiries
    WHERE created_at >= current_date - (GREATEST(days_back, 1) || ' days')::interval
    GROUP BY 1
  ),
  lst AS (
    SELECT created_at::date AS day, count(*)::bigint AS n
    FROM public.listings
    WHERE created_at >= current_date - (GREATEST(days_back, 1) || ' days')::interval
      AND deleted_at IS NULL
    GROUP BY 1
  ),
  tsk AS (
    SELECT completed_at::date AS day, count(*)::bigint AS n
    FROM public.tasks
    WHERE completed_at IS NOT NULL
      AND completed_at >= current_date - (GREATEST(days_back, 1) || ' days')::interval
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

COMMENT ON FUNCTION public.dashboard_trend_daily(int) IS
  'Daily buckets for the dashboard trend chart. SECURITY INVOKER so per-table RLS scopes the result. Days with zero rows return as 0; spine generated from generate_series so the chart never has gaps.';

GRANT EXECUTE ON FUNCTION public.dashboard_trend_daily(int) TO authenticated;

NOTIFY pgrst, 'reload schema';
