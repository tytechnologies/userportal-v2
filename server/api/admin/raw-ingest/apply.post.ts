// Admin — manually drain listings_normalized → listings (B-3.1 apply).
//
// POST /api/admin/raw-ingest/apply
// Body: { max?: number }   default 200, max 2000
//
// Companion to /api/internal/apply-normalized-batch — same RPC, but
// gated on admin auth rather than the internal cron secret. Useful
// during the dual-write parity-verification window.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const bodySchema = z.object({
  max: z.coerce.number().int().min(1).max(2000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const b = body as z.infer<typeof bodySchema>
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any).rpc(
      'apply_listings_normalized_batch',
      { p_max: b.max ?? 200 },
    )
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { ok: true, result: data?.[0] ?? data ?? null }
  },
})
