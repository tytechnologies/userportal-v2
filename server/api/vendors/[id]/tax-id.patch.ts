// PATCH /api/vendors/:id/tax-id
// Body: { tax_id: string | null }
// Encrypts and persists the vendor TIN via vendor_set_tax_id().

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const bodySchema = z.object({
  tax_id: z.string().trim().max(40).nullable(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid vendor id' })
    }
    const client = await serverSupabaseClient(event)
    const { error } = await (client as any).rpc('vendor_set_tax_id', {
      p_vendor_id: id,
      p_plaintext: body.tax_id,
    })
    if (error) throw createError({ statusCode: 400, statusMessage: error.message })
    return { ok: true }
  },
})
