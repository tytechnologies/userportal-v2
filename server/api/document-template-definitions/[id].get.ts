// Load one template definition. RLS gates whether drafts/archived are
// visible to the caller. Returns a signed URL for the background image
// alongside the row, since the browser can't fetch storage paths
// directly without going through S3 presigning.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedDownloadUrl } from '~~/server/utils/s3'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing template id' })

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('document_template_definitions')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'template_defs.get', id }, 'template_defs_get_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Template not found' })

    let backgroundUrl: string | null = null
    if (data.background_path) {
      try {
        // 1-hour window — designer/editor sessions typically last
        // longer than a couple of minutes, and re-fetching this row
        // is cheap if the URL expires mid-edit.
        backgroundUrl = await getSignedDownloadUrl(data.background_path, 3600)
      } catch (e) {
        logger.warn(
          { err: (e as Error).message, id, path: data.background_path },
          'template_defs_background_sign_failed',
        )
      }
    }

    return { ...data, background_url: backgroundUrl }
  },
})
