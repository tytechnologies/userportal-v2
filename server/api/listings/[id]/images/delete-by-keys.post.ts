// Delete a specific set of S3 keys belonging to a single listing.
//
// Hardening (vs. the original which accepted any string):
//
//   1. Keys MUST match `properties/(original/)?property-<digits>/...`.
//      A key outside this prefix family is rejected — bucket-wide
//      deletion via this endpoint is no longer possible.
//
//   2. Every key's embedded listing-id MUST equal the route's `[id]`.
//      The route already pins the listing being mutated; this stops
//      a caller from passing keys for a different listing in the
//      payload.
//
//   3. RLS check via assertCanReadListing — caller has to be allowed
//      to see the listing (own / team / all per their permissions)
//      before any S3 mutation runs.

import { z } from 'zod'
import { deleteObjectsByKeys } from '~~/server/utils/s3'
import { assertCanReadListing } from '~~/server/utils/images-auth'

const schema = z.object({
  keys: z.array(z.string().min(1).max(1024)).min(1).max(500),
})

const KEY_RE = /^properties\/(original\/)?property-(\d+)\//

export default defineApiHandler({
  body: schema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = await assertCanReadListing(event, getRouterParam(event, 'id'))

    for (const key of body.keys) {
      const match = key.match(KEY_RE)
      if (!match) {
        throw createError({
          statusCode: 400,
          statusMessage: `Key not in the listings prefix family: ${key}`,
        })
      }
      const keyListingId = Number(match[2])
      if (keyListingId !== id) {
        throw createError({
          statusCode: 403,
          statusMessage: `Key targets listing ${keyListingId}, route is for listing ${id}`,
        })
      }
    }

    return deleteObjectsByKeys(body.keys)
  },
})
