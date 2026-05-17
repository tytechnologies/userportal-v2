// POST /api/admin/eis-submissions/:id/cancel
// Body: { reason?: string }
//
// Operator-driven cancel for stuck queued/submitted rows. The freeze
// trigger on eis_submissions allows status mutation; only payload +
// refs are immutable on submitted/accepted rows. Cancelling preserves
// the original payload + audit trail.
//
// Refuses to cancel:
//   * already terminal (rejected | cancelled): no-op, return 409
//   * accepted: BIR has acknowledged it; cancellation here would
//     desync our state from theirs. Operator must contact BIR.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../../utils/sbUser'

const bodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
    }
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data: existing, error: readErr } = await (client as any)
      .from('eis_submissions')
      .select('id, status, metadata, response_notes')
      .eq('id', id)
      .maybeSingle()
    if (readErr) throw createError({ statusCode: 500, statusMessage: readErr.message })
    if (!existing) throw createError({ statusCode: 404, statusMessage: 'Submission not found' })

    if (existing.status === 'cancelled' || existing.status === 'rejected') {
      throw createError({
        statusCode: 409,
        statusMessage: `Already terminal (status=${existing.status})`,
      })
    }
    if (existing.status === 'accepted') {
      throw createError({
        statusCode: 409,
        statusMessage:
          'Accepted submissions cannot be cancelled — BIR already acknowledged. Contact BIR to void.',
      })
    }

    const reasonText = (body.reason ?? '').trim() || 'cancelled by operator'
    const newMetadata = {
      ...(existing.metadata ?? {}),
      cancelled_by: user.id,
      cancelled_at: new Date().toISOString(),
    }

    const { data, error } = await (client as any)
      .from('eis_submissions')
      .update({
        status: 'cancelled',
        cancel_reason: reasonText,
        metadata: newMetadata,
      })
      .eq('id', id)
      .select('id, status, cancel_reason')
      .single()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return data
  },
})
