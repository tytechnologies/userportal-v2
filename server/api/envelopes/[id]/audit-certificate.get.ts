// GET /api/envelopes/:id/audit-certificate
// Returns a JSON certificate suitable for export/attachment to closing
// docs: envelope metadata + recipients + documents + chronological
// audit events with IPs and UAs.

import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope id' })
    }
    return await envelopesRepo.auditCertificate({ event, id })
  },
})
