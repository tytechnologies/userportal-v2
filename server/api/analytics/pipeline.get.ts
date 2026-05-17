// Pipeline + document analytics summary for the /analytics page.
//
// GET /api/analytics/pipeline
//
// Two slices, both RLS-scoped:
//
//   1. Deals — counts per stage, won/lost/open totals, gross
//      closed-won value, and average days-to-close (closed_won only,
//      based on created_at → closed_at).
//
//   2. Document drafts — counts per status (draft / in_review /
//      signed / archived) so the docs throughput card on the analytics
//      page reflects pipeline-wide doc activity, not just the caller's
//      own drafts.
//
// Why a single endpoint: both slices come from the same caller and
// render side-by-side. Two paginated reads (.from('deals').select(...)
// and .from('document_drafts').select(...)) is simpler than a custom
// SQL view and lets RLS do the visibility work.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

type DealRow = {
  stage_key: string | null
  closed_won: boolean | null
  closed_at: string | null
  created_at: string | null
  deal_value: number | null
}
type DraftRow = {
  status: string | null
}

const KNOWN_STAGES = [
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
  'closed_lost',
] as const

const KNOWN_DRAFT_STATUSES = ['draft', 'in_review', 'signed', 'archived'] as const

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const supabase = await serverSupabaseClient(event)

    // Pull only the columns we aggregate over. Unbounded select is
    // safe here: deal counts on a single broker stay in the
    // low-thousands range; if it grows past ~50k we should switch to
    // a view. Same for drafts.
    const [dealsRes, draftsRes] = await Promise.all([
      (supabase as any)
        .from('deals')
        .select('stage_key, closed_won, closed_at, created_at, deal_value')
        .limit(10_000),
      (supabase as any).from('document_drafts').select('status').limit(10_000),
    ])

    if (dealsRes.error) {
      logger.error({ err: dealsRes.error.message, op: 'analytics.pipeline.deals' }, 'analytics_deals_failed')
      throw createError({ statusCode: 500, statusMessage: dealsRes.error.message })
    }
    if (draftsRes.error) {
      logger.error({ err: draftsRes.error.message, op: 'analytics.pipeline.drafts' }, 'analytics_drafts_failed')
      throw createError({ statusCode: 500, statusMessage: draftsRes.error.message })
    }

    const deals = (dealsRes.data ?? []) as DealRow[]
    const drafts = (draftsRes.data ?? []) as DraftRow[]

    // Deal aggregation. Bucket all known stages with a 0 baseline so
    // the chart axis is stable — empty stages still render as a 0
    // bar instead of dropping out.
    const byStage: Record<string, number> = {}
    for (const s of KNOWN_STAGES) byStage[s] = 0
    let open = 0
    let won = 0
    let lost = 0
    let grossWonValue = 0
    const closeDurationsDays: number[] = []

    for (const d of deals) {
      const key = d.stage_key ?? 'inquiry_received'
      byStage[key] = (byStage[key] ?? 0) + 1

      if (d.closed_won === true) {
        won += 1
        if (typeof d.deal_value === 'number') grossWonValue += d.deal_value
        if (d.created_at && d.closed_at) {
          const start = new Date(d.created_at).getTime()
          const end = new Date(d.closed_at).getTime()
          if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
            closeDurationsDays.push((end - start) / (24 * 60 * 60 * 1000))
          }
        }
      } else if (d.closed_won === false) {
        lost += 1
      } else {
        open += 1
      }
    }

    const avgDaysToClose = closeDurationsDays.length
      ? closeDurationsDays.reduce((a, b) => a + b, 0) / closeDurationsDays.length
      : 0

    // Win rate: won / (won + lost). Open deals don't count toward
    // either side — they haven't resolved yet. Returns 0 when no
    // closed deals exist (rather than NaN or "infinity").
    const winRate = won + lost > 0 ? won / (won + lost) : 0

    // Document aggregation.
    const byStatus: Record<string, number> = {}
    for (const s of KNOWN_DRAFT_STATUSES) byStatus[s] = 0
    let unknownDrafts = 0
    for (const r of drafts) {
      const k = r.status ?? 'draft'
      if (k in byStatus) byStatus[k] = (byStatus[k] ?? 0) + 1
      else unknownDrafts += 1
    }

    return {
      deals: {
        total: deals.length,
        open,
        won,
        lost,
        winRate,
        grossWonValue,
        avgDaysToClose,
        byStage,
      },
      drafts: {
        total: drafts.length,
        byStatus,
        unknown: unknownDrafts,
      },
    }
  },
})
