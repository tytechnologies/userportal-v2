// Operations Control Center — landing-page KPI aggregator.
//
// GET /api/admin/summary
// Auth: admin (requireRole gate; same surface as the rest of /admin).
//
// Returns five operational counts the admin landing surfaces above the
// secondary nav:
//   active_users           — non-deleted profiles in the last 30 days
//   pending_verifications  — listing_verifications.status = 'pending'
//   failed_imports         — listing_import_rows with outcome = 'failed*'
//   duplicate_candidates   — listing_duplicate_candidates.status='pending'
//   alerts                 — ops_alerts critical + warning (count combined)
//
// Single round trip, parallel queries. Per-KPI failure returns 0 — the
// landing always paints. Mirrors the resilience pattern of
// /api/dashboard/stats.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

async function countSafe(
  builderFactory: () => any,
  op: string,
): Promise<number> {
  try {
    const { count, error } = await builderFactory()
    if (error) {
      logger.warn({ err: error.message, op: `admin.summary.${op}` }, 'admin_summary_count_failed')
      return 0
    }
    return count ?? 0
  } catch (err: any) {
    logger.warn({ err: err?.message, op: `admin.summary.${op}` }, 'admin_summary_count_threw')
    return 0
  }
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const thirtyDaysAgoIso = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString()

    const [
      activeUsers,
      pendingVerifications,
      failedImports,
      duplicateCandidates,
      alertsCritical,
      alertsWarning,
    ] = await Promise.all([
      // Active users — profiles updated in the last 30 days. Activity is
      // a stronger signal than "exists in profiles" for an "active"
      // metric, but updated_at is the closest proxy without a real
      // last-seen-at column.
      countSafe(
        () =>
          (supabase as any)
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .gte('updated_at', thirtyDaysAgoIso),
        'active_users',
      ),
      countSafe(
        () =>
          (supabase as any)
            .from('listing_verifications')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending'),
        'pending_verifications',
      ),
      countSafe(
        () =>
          (supabase as any)
            .from('listing_import_rows')
            .select('id', { count: 'exact', head: true })
            .like('outcome', 'failed%'),
        'failed_imports',
      ),
      countSafe(
        () =>
          (supabase as any)
            .from('listing_duplicate_candidates')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending'),
        'duplicate_candidates',
      ),
      // Two-shot for alerts — `ops_alerts` is a view; we sum critical +
      // warning since the landing strip only needs "stuff that needs
      // attention" rather than per-severity granularity.
      countSafe(
        () =>
          (supabase as any)
            .from('ops_alerts')
            .select('key', { count: 'exact', head: true })
            .eq('severity', 'critical'),
        'alerts_critical',
      ),
      countSafe(
        () =>
          (supabase as any)
            .from('ops_alerts')
            .select('key', { count: 'exact', head: true })
            .eq('severity', 'warning'),
        'alerts_warning',
      ),
    ])

    return {
      kpi: {
        active_users: activeUsers,
        pending_verifications: pendingVerifications,
        failed_imports: failedImports,
        duplicate_candidates: duplicateCandidates,
        alerts: alertsCritical + alertsWarning,
        alerts_critical: alertsCritical,
        alerts_warning: alertsWarning,
      },
    }
  },
})
