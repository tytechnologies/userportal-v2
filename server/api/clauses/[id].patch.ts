// Update a clause. Used both for content edits and the
// draft → approved → deprecated state machine.
//
// Approving stamps approved_by + approved_at automatically. Once
// approved, the body field becomes read-only at the API surface to
// preserve the integrity of the approved text — to revise an
// approved clause, callers should POST a new version (incremented
// `version` field) instead.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  status:        z.enum(['draft','approved','deprecated']).optional(),
  doc_type_keys: z.array(z.string().min(1).max(80)).max(40).optional(),
  jurisdiction:  z.string().min(2).max(8).optional(),
  title:         z.string().trim().min(1).max(200).optional(),
  body:          z.string().trim().min(1).max(50_000).optional(),
  description:   z.string().trim().max(2000).nullable().optional(),
  placeholders:  z.array(z.string().min(1).max(80)).max(80).optional(),
}).strict()

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid clause id' })
    }
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    // Pre-read so we can enforce the "approved bodies are immutable"
    // invariant before sending the UPDATE.
    const { data: existing, error: readErr } = await (supabase as any)
      .from('clause_library')
      .select('id, status, body, title')
      .eq('id', id)
      .maybeSingle()
    if (readErr) {
      throw createError({ statusCode: 500, statusMessage: readErr.message })
    }
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Clause not found' })
    }
    if (
      existing.status === 'approved' &&
      body.body !== undefined &&
      body.body !== existing.body
    ) {
      throw createError({
        statusCode: 422,
        statusMessage:
          'Approved clauses are immutable. Create a new version instead of editing the body.',
      })
    }

    const update: Record<string, unknown> = {}
    if (body.status        !== undefined) update.status = body.status
    if (body.doc_type_keys !== undefined) update.doc_type_keys = body.doc_type_keys
    if (body.jurisdiction  !== undefined) update.jurisdiction = body.jurisdiction
    if (body.title         !== undefined) update.title = body.title
    if (body.body          !== undefined) update.body = body.body
    if (body.description   !== undefined) update.description = body.description
    if (body.placeholders  !== undefined) update.placeholders = body.placeholders
    if (body.status === 'approved') {
      update.approved_by = user?.id ?? null
      update.approved_at = new Date().toISOString()
    }

    const { data, error } = await (supabase as any)
      .from('clause_library')
      .update(update)
      .eq('id', id)
      .select('*')
      .single()
    if (error) {
      logger.error({ err: error.message, op: 'clauses.patch' }, 'clauses_patch_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },
})
