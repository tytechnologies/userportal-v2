// Read a single version (full snapshot data). Used by the diff
// viewer to load both sides at once.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id        = getRouterParam(event, 'id')
    const versionId = getRouterParam(event, 'versionId')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid draft id' })
    }
    if (!versionId || !/^[0-9a-f-]{36}$/i.test(versionId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid version id' })
    }
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_versions')
      .select('*')
      .eq('id', versionId)
      .eq('draft_id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Version not found' })
    }
    return data
  },
})
