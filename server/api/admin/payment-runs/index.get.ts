// GET /api/admin/payment-runs?run_kind=rent
import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  run_kind: z.enum(['rent', 'dues', 'manual']).optional(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('payment_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(200)
    if (query.run_kind) q = q.eq('run_kind', query.run_kind)
    if (query.status) q = q.eq('status', query.status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
