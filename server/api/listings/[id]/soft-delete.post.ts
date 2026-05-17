import { listingsRepo } from '~~/server/repositories/listings.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }
    return listingsRepo.softDelete({ event, id })
  },
})
