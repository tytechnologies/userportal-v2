// GET /api/admin/bir-2307/runs?limit=
// Lists prior generated 2307 runs from bir_report_runs.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    const limit = query.limit ?? 50
    const { data, error } = await (client as any)
      .from('bir_report_runs')
      .select('id, period_start, period_end, totals, generated_by, generated_at, notes')
      .eq('report_kind', 'form_2307')
      .order('generated_at', { ascending: false })
      .limit(limit)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { items: data ?? [] }
  },
})
