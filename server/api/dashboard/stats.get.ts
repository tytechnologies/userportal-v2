// Dashboard KPI batch endpoint. Returns the four primary at-a-glance
// counts the new enterprise-style header reads:
//
//   - active_listings          — visible online, not soft-deleted
//   - new_inquiries_7d         — status='new' created in the last 7d
//   - open_tasks_mine          — tasks assigned to caller, not done
//   - pending_shares_incoming  — listing_shares waiting on the caller
//
// Plus a small inquiry funnel snapshot keyed by status so the funnel
// widget renders without a second round trip.
//
// Counts use `count: 'estimated'` (NOT 'exact') for the listings table —
// `exact` does a full sequential scan which times out at ~60s once the
// table grows past a few hundred thousand rows, surfacing in the browser
// as "Retrying fetch attempt N for /rest/v1/listings?…". `estimated` reads
// `pg_class.reltuples` (Postgres's row estimator), which is O(1) and
// updated by autovacuum. The trade-off is precision — it's accurate to
// within a few % for top-line dashboard KPIs, which is fine here.
//
// Smaller tables (inquiries, tasks, listing_shares) keep `count: 'exact'`
// because (a) they're small and the scan is cheap and (b) the dashboard
// would notice a drift on small numbers.
//
// RLS scopes what the caller can see; missing permission gracefully
// returns 0 (the auth check throws 401 from defineApiHandler before we
// get here).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

// Optional ISO timestamps. When absent we default to a 30-day window
// ending now — matches useDashboardFilter's '30d' preset default so an
// unauthenticated request looks like the dashboard's first paint.
const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to:   z.string().datetime({ offset: true }).optional(),
})

// Zero-state response — returned on catastrophic init failure (supabase
// client unavailable, etc.) so the dashboard renders empty KPIs instead
// of letting Cloudflare Tunnel turn an unhandled exception into a 502.
function degradedResponse(reason: string, periodFromIso: string, periodToIso: string) {
  return {
    kpi: {
      active_listings: 0,
      new_inquiries_7d: 0,
      open_tasks_mine: 0,
      pending_shares_incoming: 0,
    },
    inquiry_funnel: { new: 0, in_progress: 0, replied: 0, closed: 0 },
    pipeline: {
      open_deals_count: 0,
      open_deals_value: 0,
      won_period_count: 0,
      won_period_value: 0,
      lost_period_count: 0,
      win_rate_period: null,
      conversion_rate_period: null,
      period_from: periodFromIso,
      period_to: periodToIso,
      currency: 'PHP',
    },
    degraded: { reason },
  }
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query, user }) => {
    const q = query as z.infer<typeof querySchema>
    const now = Date.now()
    const sevenDaysAgoIso  = new Date(now -  7 * 24 * 60 * 60 * 1000).toISOString()

    // Window-based bounds. Reused for win/loss + conversion metrics.
    // The "new inquiries 7d" KPI keeps its hardcoded 7-day window —
    // it's a top-of-funnel velocity signal independent of the picker.
    const periodFromIso = q.from ?? new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const periodToIso   = q.to   ?? new Date(now).toISOString()

    let supabase: any
    try {
      supabase = await serverSupabaseClient(event)
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'dashboard.stats.client_init' },
        'dashboard_stats_client_init_failed',
      )
      return degradedResponse('client_init_failed', periodFromIso, periodToIso)
    }
    // user is provided by defineApiHandler. Defensive guard in case the
    // wrapper's auth resolution returned a partial shape — without it,
    // queries that key on user.id throw TypeError and Cloudflare Tunnel
    // converts that to 502.
    if (!user?.id) {
      logger.warn({ op: 'dashboard.stats.no_user_id' }, 'dashboard_stats_missing_user')
      return degradedResponse('missing_user_id', periodFromIso, periodToIso)
    }

    // Role-aware scoping (2026-05-14): brokers/agents see ONLY their
    // own inventory + leads + deals. Admins see platform-wide.
    //
    // Affects: active_listings, new_inquiries_7d, inquiry funnel splits,
    // open/won/lost deals counts, period inquiry/deal totals.
    // Already user-scoped (no change): open_tasks_mine, pending_shares.
    //
    // Resolved via has_permission('admin.access') — same RBAC signal
    // the rest of the codebase reads. Default to false on any error
    // (fail-safe — show the smaller scope rather than over-share).
    let isAdmin = false
    try {
      const { data, error } = await (supabase as any).rpc('has_permission', {
        permission_to_check: 'admin.access',
      })
      if (!error) isAdmin = data === true
    } catch {
      isAdmin = false
    }
    const myId = user.id

    function scopeListings(q: any) {
      return isAdmin ? q : q.eq('created_by', myId)
    }
    function scopeInquiries(q: any) {
      return isAdmin ? q : q.eq('assigned_user_id', myId)
    }
    function scopeDeals(q: any) {
      // deals.created_by is the natural ownership signal — matches the
      // RLS policy `USING (deals.write.team OR created_by = auth.uid())`
      // from mig 507000021.
      return isAdmin ? q : q.eq('created_by', myId)
    }

    async function countSafe(builderFactory: () => any): Promise<number> {
      try {
        const { count, error } = await builderFactory()
        if (error) {
          // PostgREST errors expose `code`, `details`, and `hint` in
          // addition to `message`. Some error rows have an empty
          // `.message` (e.g. RLS-policy denials), which used to log as
          // `err: ""` and made these failures impossible to triage.
          // Capture the full shape so the operator can identify which
          // table/condition is at fault.
          logger.warn(
            {
              err: error.message || '(no message)',
              code: error.code,
              details: error.details,
              hint: error.hint,
              op: 'dashboard.stats',
            },
            'dashboard_count_failed',
          )
          return 0
        }
        return count ?? 0
      } catch (err: any) {
        logger.warn({ err: err?.message, op: 'dashboard.stats' }, 'dashboard_count_threw')
        return 0
      }
    }

    // Helper: SUM(deal_value) over a filter. Returns 0 on error/empty.
    // We pull the rows and sum client-side because PostgREST doesn't
    // expose SUM() over a filtered set without a custom RPC. Counts
    // stay small enough (open deals + last-30d-closed deals) that the
    // bandwidth is acceptable.
    async function sumDealValue(filterFn: (q: any) => any): Promise<number> {
      try {
        const builder = (supabase as any)
          .from('deals')
          .select('deal_value')
        const { data, error } = await filterFn(builder)
        if (error) {
          logger.warn({ err: error.message, op: 'dashboard.stats.deal_sum' }, 'deal_sum_failed')
          return 0
        }
        return (data ?? []).reduce(
          (acc: number, r: any) => acc + Number(r?.deal_value ?? 0),
          0,
        )
      } catch (err: any) {
        logger.warn({ err: err?.message, op: 'dashboard.stats.deal_sum' }, 'deal_sum_threw')
        return 0
      }
    }

    const [
      activeListings,
      newInquiries7d,
      openTasksMine,
      pendingSharesIncoming,
      inquiriesNew,
      inquiriesInProgress,
      inquiriesReplied,
      inquiriesClosed,
      openDealsCount,
      openDealsValue,
      wonPeriodCount,
      wonPeriodValue,
      lostPeriodCount,
      inquiriesPeriodCount,
      dealsCreatedPeriodCount,
    ] = await Promise.all([
      countSafe(() =>
        scopeListings(
          (supabase as any)
            .from('listings')
            // For brokers/agents the count drops below the table-scan
            // threshold so 'estimated' becomes meaningless — switch to
            // 'exact'. Admins keep 'estimated' (49k+ listings; full
            // scan would time out).
            .select('id', { count: isAdmin ? 'estimated' : 'exact', head: true })
            .eq('is_online', true)
            .is('deleted_at', null),
        ),
      ),
      countSafe(() =>
        scopeInquiries(
          (supabase as any)
            .from('inquiries')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'new')
            .gte('created_at', sevenDaysAgoIso),
        ),
      ),
      countSafe(() =>
        (supabase as any)
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assignee_user_id', user!.id)
          .neq('status', 'completed')
          .neq('status', 'cancelled'),
      ),
      countSafe(() =>
        (supabase as any)
          .from('listing_shares')
          .select('id', { count: 'exact', head: true })
          .eq('shared_with_user_id', user!.id)
          .eq('status', 'pending'),
      ),
      // Funnel: status splits. Scoped to user's inquiries for
      // brokers/agents; platform-wide for admins.
      countSafe(() =>
        scopeInquiries((supabase as any).from('inquiries').select('id', { count: 'exact', head: true }).eq('status', 'new')),
      ),
      countSafe(() =>
        scopeInquiries((supabase as any).from('inquiries').select('id', { count: 'exact', head: true }).eq('status', 'in_progress')),
      ),
      countSafe(() =>
        scopeInquiries((supabase as any).from('inquiries').select('id', { count: 'exact', head: true }).eq('status', 'replied')),
      ),
      countSafe(() =>
        scopeInquiries((supabase as any).from('inquiries').select('id', { count: 'exact', head: true }).eq('status', 'closed')),
      ),
      // Open deals — closed_won IS NULL (still in pipeline). Scoped.
      countSafe(() =>
        scopeDeals((supabase as any).from('deals').select('id', { count: 'exact', head: true }).is('closed_won', null)),
      ),
      // Open deals total value (sum) — scoped.
      sumDealValue((q) => scopeDeals(q.is('closed_won', null))),
      // Won in window — scoped.
      countSafe(() =>
        scopeDeals(
          (supabase as any).from('deals')
            .select('id', { count: 'exact', head: true })
            .eq('closed_won', true)
            .gte('closed_at', periodFromIso)
            .lte('closed_at', periodToIso),
        ),
      ),
      sumDealValue((qb) =>
        scopeDeals(qb.eq('closed_won', true).gte('closed_at', periodFromIso).lte('closed_at', periodToIso)),
      ),
      // Lost in window (for win-rate denominator) — scoped.
      countSafe(() =>
        scopeDeals(
          (supabase as any).from('deals')
            .select('id', { count: 'exact', head: true })
            .eq('closed_won', false)
            .gte('closed_at', periodFromIso)
            .lte('closed_at', periodToIso),
        ),
      ),
      // Inquiries created in window (denominator for conversion) — scoped.
      countSafe(() =>
        scopeInquiries(
          (supabase as any).from('inquiries')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', periodFromIso)
            .lte('created_at', periodToIso),
        ),
      ),
      // Deals created in window (numerator for conversion) — scoped.
      countSafe(() =>
        scopeDeals(
          (supabase as any).from('deals')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', periodFromIso)
            .lte('created_at', periodToIso),
        ),
      ),
    ])

    // Derived rates. Guarded against /0 — return null when there's no
    // denominator so the UI can render "—" rather than "0%".
    const winDenomPeriod = wonPeriodCount + lostPeriodCount
    const winRatePeriod  = winDenomPeriod > 0 ? wonPeriodCount / winDenomPeriod : null
    const conversionRatePeriod =
      inquiriesPeriodCount > 0 ? dealsCreatedPeriodCount / inquiriesPeriodCount : null

    return {
      scope: isAdmin ? 'admin' : 'agent',
      kpi: {
        active_listings: activeListings,
        new_inquiries_7d: newInquiries7d,
        open_tasks_mine: openTasksMine,
        pending_shares_incoming: pendingSharesIncoming,
      },
      inquiry_funnel: {
        new: inquiriesNew,
        in_progress: inquiriesInProgress,
        replied: inquiriesReplied,
        closed: inquiriesClosed,
      },
      pipeline: {
        // Snapshot — ignores the date range (current state).
        open_deals_count:        openDealsCount,
        open_deals_value:        openDealsValue,            // numeric in PHP
        // Window — honors `from`/`to` (defaults to 30d).
        won_period_count:        wonPeriodCount,
        won_period_value:        wonPeriodValue,            // numeric in PHP
        lost_period_count:       lostPeriodCount,
        win_rate_period:         winRatePeriod,             // 0..1 or null
        conversion_rate_period:  conversionRatePeriod,      // 0..1 or null
        period_from:             periodFromIso,
        period_to:               periodToIso,
        currency: 'PHP',
      },
    }
  },
})
