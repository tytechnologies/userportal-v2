import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getSignedUrlForS3Key } from '~~/server/utils/s3-signed-url'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  type: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/i, 'document_type must be a single token (letters, digits, underscore)')
    .optional(),
})

export default defineApiHandler({
  auth: 'required',
  query: querySchema,
  handler: async ({ query, user, event }) => {
    const documentType = query.type

    const supabase = await serverSupabaseClient(event)
    let q = supabase
      .from('documents')
      .select('id, document_type, s3_key, file_name, file_format, metadata, created_at')
      .eq('created_by', user.id)
      .order('created_at', { ascending: false })

    if (documentType) q = q.eq('document_type', documentType)

    const { data: rows, error } = await q
    if (error) {
      logger.error({ err: error.message, op: 'documents.list' }, 'documents_list_failed')
      throw createError({ statusCode: 500, statusMessage: 'Failed to list documents' })
    }

    return Promise.all(
      (rows ?? []).map(async (row: any) => {
        let documentUrl = ''
        if (row.s3_key) {
          try {
            documentUrl = await getSignedUrlForS3Key(row.s3_key)
          } catch (e) {
            logger.error({ err: (e as Error).message, id: row.id }, 'documents_sign_url_failed')
          }
        }
        return {
          id: row.id,
          document_type: row.document_type,
          documentName: row.file_name?.replace(/\.(pdf|docx)$/i, '') ?? '',
          documentUrl,
          file_name: row.file_name,
          file_format: row.file_format,
          metadata: row.metadata,
          created_at: row.created_at,
        }
      }),
    )
  },
})
