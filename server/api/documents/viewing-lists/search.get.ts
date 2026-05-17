import { z } from 'zod'
import { searchViewingListsByName } from '~~/server/utils/s3'

// Note: viewing-lists are intentionally shared across the org (team
// library), not per-user scoped. Auth-gated to prevent anon listing,
// but any authenticated caller can search the shared corpus. If this
// changes (per-broker private), prefix the search with a user_id
// segment in S3 and pass user.id here.

const querySchema = z.object({
  q: z
    .string()
    .trim()
    .max(128)
    .optional()
    .default(''),
})

export default defineApiHandler({
  auth: 'required',
  query: querySchema,
  handler: async ({ query }) => {
    return searchViewingListsByName(query.q ?? '')
  },
})
