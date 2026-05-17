// POST /api/journal-entries
//
// Body: { entry_date?, description, reference_kind?, reference_id?,
//         currency?, lines: [{ account_id, debit_minor?, credit_minor?, ... }] }
//
// Creates a draft entry + lines atomically. Use POST /:id/post to validate
// and finalise (debits=credits enforced at post time).

import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const lineSchema = z
  .object({
    account_id: z.string().uuid(),
    debit_minor: z.number().int().min(0).optional(),
    credit_minor: z.number().int().min(0).optional(),
    description: z.string().max(2000).nullable().optional(),
    dimension_unit_id: z.string().uuid().nullable().optional(),
    dimension_lease_id: z.string().uuid().nullable().optional(),
    dimension_owner_id: z.string().uuid().nullable().optional(),
  })
  .refine(
    (l) => (l.debit_minor ?? 0) > 0 || (l.credit_minor ?? 0) > 0,
    { message: 'Each line must have either debit_minor > 0 or credit_minor > 0' },
  )

const bodySchema = z.object({
  entry_date: z.string().date().optional(),
  description: z.string().trim().min(1).max(500),
  reference_kind: z.string().trim().max(40).optional(),
  reference_id: z.string().trim().max(120).nullable().optional(),
  currency: z.string().length(3).optional(),
  lines: z.array(lineSchema).min(2).max(200),
  metadata: z.record(z.unknown()).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await accountingRepo.createEntry({ event, input: body })
  },
})
