import { listingsRepo } from '~~/server/repositories/listings.repo'
import { listingRemarksSchema } from '~~/schemas/listing'

export default defineApiHandler({
  body: listingRemarksSchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }
    return listingsRepo.updateRemarks({ event, id, remarks: body.remarks })
  },
})
