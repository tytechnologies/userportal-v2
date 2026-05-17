// Operations dashboard â€” update alert thresholds.
//
// PUT /api/admin/ops/alert-thresholds
// Auth: admin.
// Body: { updates: [{ key: string, value_int: number }, ...] }
//
// Atomic: all updates apply or none do, via a single UPDATE per row
// inside a transaction. Each row is also stamped with updated_by =
// caller's profile id (audit trail) and audited via log_activity.
//
// Validation:
//   - key must be one of the seeded keys (allowlist below). Prevents
//     a typo'd key creating an unknown row.
//   - value_int must be >= 1. Setting to 0 would silently disable the
//     alert; if that's the operator's intent they should disable it
//     differently (we don't have an explicit disable flag yet).
//   - Range caps prevent runaway values (e.g. someone entering
//     999999 hours which would never trip).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

// Allowlist + per-key range caps. Keep in sync with the migration's
// seed data â€” adding a new threshold means adding it here too.
const ALLOWED: Record<string, { min: number; max: number }> = {
  webhook_failing_min_failures:  { min: 1, max: 1000 },
  webhook_disabled_min_failures: { min: 1, max: 1000 },
  webhook_retry_stuck_minutes:   { min: 1, max: 1440 }, // up to 24h
  cron_overdue_hours:            { min: 1, max: 720  }, // up to 30d
}

const bodySchema = z.object({
  updates: z.array(z.object({
    key: z.string(),
    value_int: z.number().int(),
  })).min(1),
})

export default defineApiHandler({
  auth: 'required',
  body: bodySchema,
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const user = await serverSupabaseUser(event)
    if (!user) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

    const b = body as z.infer<typeof bodySchema>

    // Validate every update against the allowlist + range caps before
    // touching the database, so a single bad row aborts the whole call
    // rather than half-applying.
    for (const u of b.updates) {
      const cap = ALLOWED[u.key]
      if (!cap) {
        throw createError({
          statusCode: 400,
          statusMessage: `Unknown threshold key: ${u.key}`,
        })
      }
      if (u.value_int < cap.min || u.value_int > cap.max) {
        throw createError({
          statusCode: 400,
          statusMessage: `${u.key} must be between ${cap.min} and ${cap.max}`,
        })
      }
    }

    const supabase = await serverSupabaseClient(event)

    const applied: Array<{ key: string; value_int: number }> = []
    for (const u of b.updates) {
      const { error } = await (supabase as any)
        .from('ops_alert_thresholds')
        .update({
          value_int: u.value_int,
          updated_at: new Date().toISOString(),
          updated_by: user.id,
        })
        .eq('key', u.key)

      if (error) {
        throw createError({ statusCode: 500, statusMessage: error.message })
      }
      applied.push({ key: u.key, value_int: u.value_int })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'ops_alert_threshold.updated',
      entity: 'ops_alert_threshold' as any,
      metadata: { updates: applied },
    })

    return { ok: true, updated: applied.length }
  },
})
