// GET /api/vendors/:id/tax-id
// Returns the decrypted vendor TIN. Permission gate inside the RPC
// (pii.vendors.tax_id.read or admin.access).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid vendor id' })
    }
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('vendor_get_tax_id', {
      p_vendor_id: id,
    })
    if (error) throw createError({ statusCode: 403, statusMessage: error.message })
    return { tax_id: data ?? null }
  },
})
