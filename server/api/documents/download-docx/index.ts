import { z } from 'zod'
import { getSignedDownloadUrl, listObjectsByPrefix } from '~~/server/utils/s3'

// IDOR fix 2026-05-08: previously took `user_id` from the query and
// used it as the S3 prefix directly, letting any authenticated caller
// download documents belonging to another user. Now ignores any
// query-supplied user_id and always scopes to the authenticated user's
// id from the session.
//
// `documentName` is also Zod-restricted to a single safe filename token
// (no slashes, dots, or whitespace) so path traversal can't extend the
// prefix.

const querySchema = z.object({
  documentName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/, 'documentName must be alphanumeric / underscore / hyphen only'),
})

export default defineApiHandler({
  auth: 'required',
  query: querySchema,
  handler: async ({ query, user }) => {
    const { documentName } = query

    // ALWAYS scope to the authenticated user. Any client-supplied user_id
    // is intentionally ignored.
    const objects = await listObjectsByPrefix(`documents/user-${user.id}/`)
    const matching = objects.find((obj) => obj.Key?.split('/').pop() === `${documentName}.docx`)

    if (!matching?.Key) {
      throw createError({ statusCode: 404, statusMessage: 'Document not found' })
    }

    return { documentUrl: await getSignedDownloadUrl(matching.Key) }
  },
})
