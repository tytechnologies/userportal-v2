import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedUrlForS3Key } from '~~/server/utils/s3-signed-url'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event, user }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing document id' })

    const supabase = await serverSupabaseClient(event)
    const { data: row, error } = await supabase
      .from('documents')
      .select('id, document_type, s3_key, file_name, file_format, metadata, created_at')
      .eq('id', id)
      .eq('created_by', user.id)
      .single()

    if (error || !row) {
      throw createError({ statusCode: 404, statusMessage: 'Document not found' })
    }

    return {
      ...row,
      documentUrl: row.s3_key ? await getSignedUrlForS3Key(row.s3_key) : '',
    }
  },
})
