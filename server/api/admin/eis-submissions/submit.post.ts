// POST /api/admin/eis-submissions/submit
// Body: { invoice_id: uuid, resubmit?: boolean }
//
// Calls public.submit_invoice_to_eis(invoice_id, resubmit). Permission
// is enforced inside the RPC (bir_reports.manage / admin.access);
// this endpoint is just a convenience wrapper so the UI doesn't
// have to spell out the RPC call.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const bodySchema = z.object({
  invoice_id: z.string().uuid(),
  resubmit: z.boolean().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('submit_invoice_to_eis', {
      p_invoice_id: body.invoice_id,
      p_resubmit: body.resubmit ?? false,
    })
    if (error) {
      throw createError({ statusCode: 400, statusMessage: error.message })
    }
    return data ?? { ok: true }
  },
})
