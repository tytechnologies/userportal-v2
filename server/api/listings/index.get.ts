import { listingsRepo } from '~~/server/repositories/listings.repo'
import { listingsQuerySchema } from '~~/schemas/listing'

export default defineApiHandler({
  query: listingsQuerySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const { page, pageSize, sortBy, sortOrder, ...filters } = query as any
    return listingsRepo.list({ event, page, pageSize, sortBy, sortOrder, filters })
  },
})
