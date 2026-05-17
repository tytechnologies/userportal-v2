// GET /api/admin/outbound-emails?status=pending&template_kind=envelope.invitation

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  status: z
    .enum(['pending', 'attempting', 'sent', 'failed', 'skipped', 'cancelled'])
    .optional(),
  template_kind: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('outbound_emails')
      .select(
        'id, to_email, to_name, recipient_user_id, template_kind, subject, ' +
          'status, attempts, max_attempts, scheduled_at, attempted_at, ' +
          'sent_at, failed_at, failure_reason, reference_kind, reference_id, ' +
          'dedupe_key, created_at, updated_at',
      )
      .order('created_at', { ascending: false })
      .limit(query.limit ?? 100)
    if (query.status) q = q.eq('status', query.status)
    if (query.template_kind) q = q.eq('template_kind', query.template_kind)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
