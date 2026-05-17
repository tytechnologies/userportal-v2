// Status-transition endpoint. Validates the requested transition and
// emits a `document_draft.<status>` audit event in addition to the
// row update — this gives a clean activity timeline for the draft.
//
// Allowed transitions (current → next):
//   draft     → in_review | archived
//   in_review → signed | draft | archived
//   signed    → archived
//   archived  → draft        (un-archive, lets you resume work)
//
// A transition to the same status is a no-op (returns 200, no audit).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  to: z.enum(['draft', 'in_review', 'signed', 'archived']),
})

const ALLOWED: Record<string, Set<string>> = {
  draft:     new Set(['in_review', 'archived']),
  in_review: new Set(['signed', 'draft', 'archived']),
  signed:    new Set(['archived']),
  archived:  new Set(['draft']),
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing draft id' })

    const supabase = await serverSupabaseClient(event)

    const { data: row, error: fetchError } = await (supabase as any)
      .from('document_drafts')
      .select('id, status, contact_id, template_id, title')
      .eq('id', id)
      .maybeSingle()
    if (fetchError) {
      throw createError({ statusCode: 500, statusMessage: fetchError.message })
    }
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Draft not found' })

    if (row.status === body.to) {
      return row
    }
    if (!ALLOWED[row.status]?.has(body.to)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Illegal transition: ${row.status} → ${body.to}`,
      })
    }

    const { data: updated, error: updateError } = await (supabase as any)
      .from('document_drafts')
      .update({ status: body.to })
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (updateError) {
      logger.error(
        { err: updateError.message, op: 'document_drafts.transition', id, from: row.status, to: body.to },
        'document_draft_transition_failed',
      )
      throw createError({ statusCode: 500, statusMessage: updateError.message })
    }
    if (!updated) {
      throw createError({ statusCode: 404, statusMessage: 'Draft not found or not editable' })
    }

    // Cross-entity audit. metadata.contact_id makes the event surface
    // on the contact's unified timeline; metadata.draft_id is the
    // self-reference for the draft's own activity panel.
    await logActivity({
      event,
      client: supabase,
      action: `document_draft.${body.to}` as any,
      entity: 'document',
      metadata: {
        draft_id: updated.id,
        from_status: row.status,
        to_status: body.to,
        contact_id: updated.contact_id ?? null,
        template_id: updated.template_id ?? null,
        title: updated.title ?? null,
      },
    })

    return updated
  },
})
