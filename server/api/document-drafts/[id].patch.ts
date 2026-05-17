// Update a draft. Accepts a partial — only the fields present in the
// body are written. RLS rejects the update if the caller can't write
// to the row (own / team / all per documents.write.* permissions).
//
// Optimistic concurrency: when the editor sends `expected_updated_at`,
// the server compares it against the row's current updated_at and
// returns 409 with the current row if someone else saved in between.
// Auto-save in DocumentEditor uses this to detect concurrent edits
// and prompt the user to reload.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  contact_id: z.number().int().positive().nullable().optional(),
  listing_id: z.number().int().positive().nullable().optional(),
  data: z.record(z.unknown()).optional(),
  title: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().min(1).max(80)).max(40).optional(),
  expected_updated_at: z.string().optional(),
})

// Match index.post.ts's normalizeTags: trim, drop empties, dedupe.
function normalizeTags(input: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    const t = raw.trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing draft id' })

    const supabase = await serverSupabaseClient(event)

    const update: Record<string, unknown> = {}
    if (body.contact_id !== undefined) update.contact_id = body.contact_id
    if (body.listing_id !== undefined) update.listing_id = body.listing_id
    if (body.data !== undefined) update.data = body.data
    if (body.title !== undefined) update.title = body.title
    if (body.tags !== undefined) update.tags = normalizeTags(body.tags)

    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    // Optimistic-concurrency check. If the caller passed an expected
    // updated_at, fetch the current row and compare BEFORE writing.
    // We do this in a separate read instead of an UPDATE ... WHERE
    // updated_at = expected because PostgREST's update doesn't return
    // a clear "row not found vs not matched" signal — and we want to
    // surface the current row in the conflict response.
    if (body.expected_updated_at) {
      const { data: current, error: fetchError } = await (supabase as any)
        .from('document_drafts')
        .select('updated_at')
        .eq('id', id)
        .maybeSingle()
      if (fetchError) {
        logger.error(
          { err: fetchError.message, op: 'document_drafts.update.preflight', id },
          'document_draft_update_preflight_failed',
        )
        throw createError({ statusCode: 500, statusMessage: fetchError.message })
      }
      if (!current) {
        throw createError({ statusCode: 404, statusMessage: 'Draft not found or not editable' })
      }
      if (current.updated_at && current.updated_at !== body.expected_updated_at) {
        // Send the current row in the body so the client can surface
        // it ("loaded by Bob 12s ago — reload?").
        const { data: full } = await (supabase as any)
          .from('document_drafts')
          .select('*')
          .eq('id', id)
          .maybeSingle()
        throw createError({
          statusCode: 409,
          statusMessage: 'Conflict: this draft was edited elsewhere.',
          data: { current: full },
        })
      }
    }

    const { data, error } = await (supabase as any)
      .from('document_drafts')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'document_drafts.update', id }, 'document_draft_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      // RLS hid the row OR it doesn't exist. Don't differentiate.
      throw createError({ statusCode: 404, statusMessage: 'Draft not found or not editable' })
    }
    return data
  },
})
