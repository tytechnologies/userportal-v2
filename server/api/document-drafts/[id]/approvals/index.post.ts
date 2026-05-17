// Request approval from a reviewer.
//
// POST /api/document-drafts/:id/approvals
// Body: { reviewer_user_id: uuid, comment?: string, version_id?: uuid }
//
// `version_id` pins the approval to a specific snapshot. Strongly
// recommended — without it, "approved at the time" is ambiguous if
// the broker keeps editing. The UI auto-snapshots before sending if
// the caller didn't pre-snapshot.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z.object({
  reviewer_user_id: z.string().uuid(),
  comment:          z.string().trim().max(2000).optional(),
  version_id:       z.string().uuid().optional(),
}).strict()

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid draft id' })
    }
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (supabase as any)
      .from('document_approvals')
      .insert({
        draft_id:         id,
        reviewer_user_id: body.reviewer_user_id,
        requested_by:     user.id,
        status:           'pending',
        comment:          body.comment ?? null,
        version_id:       body.version_id ?? null,
      })
      .select('*')
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'doc_approvals.request' }, 'doc_approvals_request_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'document_draft.approval_requested' as any,
      entity: 'document',
      metadata: {
        draft_id: id,
        approval_id: data.id,
        reviewer_user_id: body.reviewer_user_id,
      },
    })

    setResponseStatus(event, 201)
    return data
  },
})
