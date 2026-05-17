// Decide on an approval: approve, reject, or withdraw.
//
// State machine:
//   pending → approved   (only the reviewer)
//   pending → rejected   (only the reviewer)
//   pending → withdrawn  (only the requester)
//
// Already-decided rows are immutable. To re-request, create a new
// approval row.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z.object({
  status:  z.enum(['approved','rejected','withdrawn']),
  comment: z.string().trim().max(2000).optional(),
}).strict()

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id         = getRouterParam(event, 'id')
    const approvalId = getRouterParam(event, 'approvalId')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid draft id' })
    }
    if (!approvalId || !/^[0-9a-f-]{36}$/i.test(approvalId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid approval id' })
    }
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Pre-read so we can enforce the state machine + role check
    // before sending the UPDATE. RLS would otherwise allow a
    // reviewer to "withdraw" or a requester to "approve" — that's
    // a transition shape we want clearly rejected, not silently
    // passed through.
    const { data: existing, error: readErr } = await (supabase as any)
      .from('document_approvals')
      .select('id, draft_id, reviewer_user_id, requested_by, status')
      .eq('id', approvalId)
      .eq('draft_id', id)
      .maybeSingle()
    if (readErr) {
      throw createError({ statusCode: 500, statusMessage: readErr.message })
    }
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Approval not found' })
    }
    if (existing.status !== 'pending') {
      throw createError({
        statusCode: 422,
        statusMessage: `Approval is already ${existing.status}; create a new request to revisit.`,
      })
    }

    if (body.status === 'approved' || body.status === 'rejected') {
      if (existing.reviewer_user_id !== user.id) {
        throw createError({
          statusCode: 403,
          statusMessage: 'Only the assigned reviewer can approve or reject.',
        })
      }
    } else if (body.status === 'withdrawn') {
      if (existing.requested_by !== user.id) {
        throw createError({
          statusCode: 403,
          statusMessage: 'Only the requester can withdraw the approval request.',
        })
      }
    }

    const { data, error } = await (supabase as any)
      .from('document_approvals')
      .update({
        status:     body.status,
        comment:    body.comment ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq('id', approvalId)
      .select('*')
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'doc_approvals.decide' }, 'doc_approvals_decide_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: ('document_draft.approval_' + body.status) as any,
      entity: 'document',
      metadata: {
        draft_id: id,
        approval_id: approvalId,
        decided_by: user.id,
      },
    })

    return data
  },
})
