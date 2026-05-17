// Admin — execute a duplicate merge.
//
// POST /api/admin/duplicates/:id/merge
// Body: { canonical_listing_id: number, notes?: string }
//
// Calls merge_listing_duplicate RPC. Audit-logged via log_activity
// regardless of whether this was a fresh merge or idempotent
// no-op (re-clicking).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const UUID_RE = /^[0-9a-f-]{36}$/i

const bodySchema = z.object({
  canonical_listing_id: z.coerce.number().int().positive(),
  notes:                z.string().trim().max(2000).optional().nullable(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid candidate id' })
    }
    const b = body as z.infer<typeof bodySchema>

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('merge_listing_duplicate', {
      p_candidate_id:         id,
      p_canonical_listing_id: b.canonical_listing_id,
    })
    if (error) {
      // RPC raises with specific SQLSTATE codes:
      //   42501 → permission denied
      //   42704 → candidate or listing not found
      //   22023 → invalid pair / status / chain
      const status =
        error.code === '42501' ? 403 :
        error.code === '42704' ? 404 :
        error.code === '22023' ? 409 :
        500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    await (supabase as any).rpc('log_activity', {
      p_action:   'duplicate.merged',
      p_metadata: {
        candidate_id:         id,
        canonical_listing_id: data?.canonical_listing_id,
        merged_listing_id:    data?.merged_listing_id,
        already_merged:       data?.already_merged,
        notes:                b.notes ?? null,
      },
    }).catch((err: any) =>
      console.warn('[admin/duplicates/:id/merge] log_activity failed', err),
    )

    return { ok: true, ...data }
  },
})
