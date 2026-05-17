-- Date-bounded variant of dashboard_trend_daily. The original
-- (20260502000009) anchors at current_date which works for "last N
-- days" presets but produces wrong buckets for arbitrary custom
-- ranges (e.g. Mar 1–Mar 15 should not include yesterday).
--
-- Both functions coexist — callers using the legacy days-back form
-- keep working; new code passes from_date/to_date directly.
--
-- DEPENDS ON:
--   20260502000009 (original RPC)

CREATE OR REPLACE FUNCTION public.dashboard_trend_daily_range(
  from_date date,
  to_date   date
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
    -- Clamp to a sane upper limit (~1 year) so a malformed call can't
    -- generate a million-row spine.
    SELECT
      LEAST(from_date, to_date) AS lo,
      GREATEST(from_date, to_date) AS hi
  ),
  spine AS (
    SELECT (lo + (s || ' days')::interval)::date AS day
    FROM bounds, generate_series(0, LEAST((hi - lo)::int, 365)) AS s
  ),
  inq AS (
    SELECT created_at::date AS day, count(*)::bigint AS n
    FROM public.inquiries, bounds
    WHERE created_at::date BETWEEN bounds.lo AND bounds.hi
    GROUP BY 1
  ),
  lst AS (
    SELECT created_at::date AS day, count(*)::bigint AS n
    FROM public.listings, bounds
    WHERE created_at::date BETWEEN bounds.lo AND bounds.hi
      AND deleted_at IS NULL
    GROUP BY 1
  ),
  tsk AS (
    SELECT completed_at::date AS day, count(*)::bigint AS n
    FROM public.tasks, bounds
    WHERE completed_at IS NOT NULL
      AND completed_at::date BETWEEN bounds.lo AND bounds.hi
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

COMMENT ON FUNCTION public.dashboard_trend_daily_range(date, date) IS
  'Date-bounded daily buckets for the dashboard trend chart. Same shape as dashboard_trend_daily but anchored to an explicit (from_date, to_date) window so custom ranges produce correct results. Spine generated via generate_series; spans clamped to 365 days.';

GRANT EXECUTE ON FUNCTION public.dashboard_trend_daily_range(date, date) TO authenticated;

-- ===================================================================
-- Inquiry funnel splits in a date-bounded window. The dashboard's
-- InquiryFunnel widget needs counts of inquiries CREATED in the window
-- (not "current state across all time"). One function returns four
-- counts in a single round trip.
-- ===================================================================

CREATE OR REPLACE FUNCTION public.dashboard_inquiry_funnel_range(
  from_date date,
  to_date   date
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
  GROUP BY i.status;
$$;

COMMENT ON FUNCTION public.dashboard_inquiry_funnel_range(date, date) IS
  'Inquiry funnel splits by status for inquiries created within the window. Used by the dashboard InquiryFunnel widget when the date range filter is active.';

GRANT EXECUTE ON FUNCTION public.dashboard_inquiry_funnel_range(date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
