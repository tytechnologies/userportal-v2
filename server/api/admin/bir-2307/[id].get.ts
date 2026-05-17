// GET /api/admin/bir-2307/:id?format=json|csv
// Returns the saved 2307 run. CSV is the per-vendor cert summary
// suitable for printing.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  format: z.enum(['json', 'csv']).optional(),
})

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
    }
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('bir_report_runs')
      .select('id, period_start, period_end, rows, totals, generated_at, notes, report_kind')
      .eq('id', id)
      .eq('report_kind', 'form_2307')
      .maybeSingle()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Run not found' })

    if ((query.format ?? 'json') === 'json') return data

    // CSV
    const rows: any[] = Array.isArray(data.rows) ? data.rows : []
    const filename = `bir-2307_${data.period_start}_to_${data.period_end}.csv`
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)

    const header = [
      'vendor_name',
      'vendor_tin',
      'vendor_email',
      'atc_code',
      'rate_pct',
      'gross_income_paid',
      'tax_withheld',
    ].join(',')

    const body = rows
      .map((r) =>
        [
          csvEscape(r.vendor_name),
          csvEscape(r.vendor_tin),
          csvEscape(r.vendor_email),
          csvEscape(r.atc_code),
          csvEscape(r.rate_pct),
          csvEscape(r.gross_income_paid),
          csvEscape(r.tax_withheld),
        ].join(','),
      )
      .join('\n')

    return `${header}\n${body}`
  },
})
