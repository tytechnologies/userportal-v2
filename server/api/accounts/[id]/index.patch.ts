// PATCH /api/accounts/:id
import { z } from 'zod'
import { accountingRepo } from '~~/server/repositories/accounting.repo'

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    parent_account_id: z.string().uuid().nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    is_active: z.boolean().optional(),
    bir_classification: z
      .enum(['vatable', 'non_vatable', 'exempt', 'zero_rated'])
      .nullable()
      .optional(),
    tax_code: z.string().trim().max(40).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' })

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid account id' })
    }
    return await accountingRepo.patchAccount({ event, id, input: body })
  },
})
