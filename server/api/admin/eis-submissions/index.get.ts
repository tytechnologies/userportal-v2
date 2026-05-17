// GET /api/admin/eis-submissions?status=&since=&limit=
//
// Lists EIS submissions for the admin dashboard. Joined with the
// invoice + organization for display.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  status: z
    .enum(['queued', 'submitted', 'accepted', 'rejected', 'cancelled', 'all'])
    .optional(),
  since: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  // Free-text search across cancel_reason / response_notes /
  // external_reference. Matches any of the three.
  q: z.string().trim().min(1).max(200).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    const limit = query.limit ?? 100

    let q = (client as any)
      .from('eis_submissions')
      .select(
        'id, document_kind, reference_kind, reference_id, status, ' +
          'submitted_at, external_reference, response_notes, cancel_reason, ' +
          'created_by, created_at, metadata',
      )
      .order('created_at', { ascending: false })
      .limit(limit)

    if (query.status && query.status !== 'all') q = q.eq('status', query.status)
    if (query.since) q = q.gte('created_at', `${query.since}T00:00:00Z`)
    if (query.q) {
      // PostgREST's `or` filter: matches any of the three text columns.
      // ILIKE for case-insensitive substring match. Escape % and _ so
      // the operator can't unintentionally use Postgres wildcards.
      const safe = query.q.replace(/[%_]/g, '\\$&')
      q = q.or(
        [
          `cancel_reason.ilike.%${safe}%`,
          `response_notes.ilike.%${safe}%`,
          `external_reference.ilike.%${safe}%`,
        ].join(','),
      )
    }

    const { data, error } = await q
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    // Hydrate the invoice header so the UI doesn't need a second fetch.
    const invoiceIds = Array.from(
      new Set(
        (data ?? [])
          .filter((r: any) => r.reference_kind === 'invoice')
          .map((r: any) => r.reference_id),
      ),
    )
    const invoices: Record<string, any> = {}
    if (invoiceIds.length > 0) {
      const { data: invs } = await (client as any)
        .from('invoices')
        .select('id, invoice_no, total_minor, currency, status, organization_id')
        .in('id', invoiceIds)
      for (const inv of invs ?? []) invoices[inv.id] = inv
    }

    return {
      items: (data ?? []).map((r: any) => ({
        ...r,
        invoice: r.reference_kind === 'invoice' ? invoices[r.reference_id] ?? null : null,
      })),
    }
  },
})
