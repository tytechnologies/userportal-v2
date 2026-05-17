// POST /api/admin/bir-2306/generate
// Body: { period_start, period_end, save?: boolean, notes? }
// Calls public.generate_bir_form_2306. Permission enforced by RPC.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const bodySchema = z.object({
  period_start: z.string().date(),
  period_end: z.string().date(),
  save: z.boolean().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('generate_bir_form_2306', {
      p_period_start: body.period_start,
      p_period_end: body.period_end,
      p_save: body.save ?? false,
      p_notes: body.notes ?? null,
    })
    if (error) throw createError({ statusCode: 400, statusMessage: error.message })
    return data
  },
})
