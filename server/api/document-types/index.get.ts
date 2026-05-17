// List document types. Read-only; the registry is seeded by migration.
// Returns the same shape as app/utils/documentTypes.ts so the client
// can hydrate a composable on app boot.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_types')
      .select('*')
      .eq('is_active', true)
      .order('category')
    if (error) {
      logger.error({ err: error.message, op: 'document_types.list' }, 'doc_types_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { data: data ?? [] }
  },
})
