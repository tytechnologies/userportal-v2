// Resolve a moderation report.
//
// PATCH /api/admin/review-reports/:id
// Body: { status: 'reviewed' | 'dismissed', review_notes?: string }
// Auth: admin (reviews.moderate via RLS).
//
// status='reviewed' = "we looked at this and took action" (ideally
//   the admin also hid the underlying review via PATCH /api/reviews/:id).
// status='dismissed' = "this report is bogus / not actionable".
//
// Audit row goes into the existing activities timeline so moderation
// activity is visible alongside other operational events.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z.object({
  status: z.enum(['reviewed', 'dismissed']),
  review_notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid report id' })
    }

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const { data, error } = await (supabase as any)
      .from('review_reports')
      .update({
        status: body.status,
        review_notes: body.review_notes ?? null,
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, review_id, status')
      .maybeSingle()

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Report not found' })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'review.reported' as any,
      entity: 'review',
      entityId: data.review_id,
      metadata: {
        op: 'report_resolved',
        report_id: data.id,
        resolution: data.status,
      },
    })

    return data
  },
})
