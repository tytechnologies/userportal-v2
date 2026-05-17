import { listingsRepo } from '~~/server/repositories/listings.repo'
import { listingCreateSchema } from '~~/schemas/listing'

export default defineApiHandler({
  body: listingCreateSchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const newRecord = await listingsRepo.create({ event, input: body })
    setResponseStatus(event, 201)
    return newRecord
  },
})
