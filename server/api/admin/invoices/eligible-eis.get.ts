// GET /api/admin/invoices/eligible-eis?limit=
//
// Lists invoices eligible for EIS submission (status='open' or 'paid').
// For each invoice, attaches the latest eis_submission row (if any)
// so the UI can show "submit" vs "resubmit" inline.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    const limit = query.limit ?? 100

    const { data: invoices, error } = await (client as any)
      .from('invoices')
      .select(
        'id, invoice_no, organization_id, currency, total_minor, ' +
          'status, issued_at, paid_at',
      )
      .in('status', ['open', 'paid'])
      .order('issued_at', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    const ids = (invoices ?? []).map((i: any) => i.id)
    const submissionsByInvoice: Record<string, any> = {}
    if (ids.length > 0) {
      const { data: subs } = await (client as any)
        .from('eis_submissions')
        .select('id, reference_id, status, submitted_at, response_notes, external_reference, created_at')
        .eq('reference_kind', 'invoice')
        .in('reference_id', ids)
        .order('created_at', { ascending: false })
      // Keep the latest submission per invoice (data is sorted desc).
      for (const s of subs ?? []) {
        if (!submissionsByInvoice[s.reference_id]) {
          submissionsByInvoice[s.reference_id] = s
        }
      }
    }

    return {
      items: (invoices ?? []).map((i: any) => ({
        ...i,
        latest_submission: submissionsByInvoice[i.id] ?? null,
      })),
    }
  },
})
