import { z } from 'zod'
import { cloneListingImages } from '~~/server/utils/s3'
import { assertCanWriteListing } from '~~/server/utils/images-auth'

const cloneSchema = z.object({
  targetListingId: z.union([z.number(), z.string()]),
})

export default defineApiHandler({
  body: cloneSchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    // Both listings must be writable by the caller — sourcing from a
    // listing the caller can't see leaks photos via the copy.
    const sourceId = await assertCanWriteListing(event, getRouterParam(event, 'id'))
    const targetId = await assertCanWriteListing(event, body.targetListingId)
    return cloneListingImages(sourceId, targetId)
  },
})
