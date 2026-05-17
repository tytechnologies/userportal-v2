// GET /api/envelopes/:id
// Returns: { envelope, recipients, documents }

import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    return await envelopesRepo.get({ event, id })
  },
})
