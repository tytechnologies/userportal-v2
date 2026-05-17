// GET /api/envelopes?status=sent&deal_id=...

import { z } from 'zod'
import { envelopesRepo } from '~~/server/repositories/envelopes.repo'

const querySchema = z.object({
  status: z
    .enum(['draft', 'sent', 'in_progress', 'completed', 'declined', 'voided', 'expired'])
    .optional(),
  deal_id: z.string().uuid().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    return await envelopesRepo.list({
      event,
      status: query.status,
      dealId: query.deal_id,
    })
  },
})
