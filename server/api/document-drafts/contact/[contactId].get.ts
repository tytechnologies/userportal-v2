// Per-contact list — convenience wrapper over /document-drafts?contact_id=...
// Useful for the contact detail page to render "Documents (3)" without
// query-string parsing.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const raw = getRouterParam(event, 'contactId')
    const contactId = Number(raw)
    if (!Number.isFinite(contactId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid contact id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_drafts')
      .select('*')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(200)

    if (error) {
      logger.error(
        { err: error.message, op: 'document_drafts.byContact', contactId },
        'document_drafts_by_contact_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
