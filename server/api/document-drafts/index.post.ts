// Create a new document draft. Body accepts:
//   { template_id?: string, contact_id?: number|null, data?: object, title?: string }
//
// owner_user_id is auto-stamped by the column DEFAULT auth.uid() on the
// document_drafts table — clients never need to send it. RLS double-
// checks via has_permission().
//
// Emits a `document_draft.created` audit event so the unified timeline
// shows it on linked contact / listing pages.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

// Trim, drop empties, dedupe (preserve first-seen order). Tags are
// editor-input so any whitespace / case drift sneaks in otherwise and
// the filter chips multiply ("Q3" vs "q3 " vs "Q3 ").
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

const bodySchema = z.object({
  template_id: z.string().min(1).max(80).nullable().optional(),
  contact_id: z.number().int().positive().nullable().optional(),
  listing_id: z.number().int().positive().nullable().optional(),
  data: z.record(z.unknown()).optional(),
  title: z.string().max(200).optional(),
  tags: z.array(z.string().min(1).max(80)).max(40).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const supabase = await serverSupabaseClient(event)

    const insert: Record<string, unknown> = {
      template_id: body.template_id ?? null,
      contact_id: body.contact_id ?? null,
      listing_id: body.listing_id ?? null,
      data: body.data ?? {},
    }
    if (body.title) insert.title = body.title
    if (body.tags) insert.tags = normalizeTags(body.tags)

    const { data, error } = await (supabase as any)
      .from('document_drafts')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      logger.error({ err: error.message, op: 'document_drafts.create' }, 'document_draft_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Cross-entity audit. metadata.contact_id surfaces this on the
    // contact's unified timeline when the draft was linked at create.
    await logActivity({
      event,
      client: supabase,
      action: 'document_draft.created' as any,
      entity: 'document',
      metadata: {
        draft_id: data?.id,
        template_id: data?.template_id ?? null,
        title: data?.title ?? null,
        contact_id: data?.contact_id ?? null,
        listing_id: data?.listing_id ?? null,
      },
    })

    setResponseStatus(event, 201)
    return data
  },
})
