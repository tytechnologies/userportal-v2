// Apply a single legacy → profile match.
//
// POST /api/admin/legacy-reconcile/apply
// Body: { listing_id: number, target_column: 'created_by' | 'updated_by'
//         | 'deleted_by', profile_id: uuid }
// Auth: admin (legacy.reconcile permission gates the underlying RPC).
//
// Wraps `legacy_creators_apply(bigint, text, uuid)`. The RPC handles
// audit logging + atomicity; we just shape the response.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const bodySchema = z.object({
  listing_id: z.number().int().positive(),
  target_column: z.enum(['created_by', 'updated_by', 'deleted_by']),
  profile_id: z.string().uuid(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any).rpc(
      'legacy_creators_apply',
      {
        p_listing_id: body.listing_id,
        p_target_column: body.target_column,
        p_profile_id: body.profile_id,
      },
    )

    if (error) {
      const status =
        error.code === '42501' ? 403 :
        error.code === 'P0002' ? 404 :
        error.code === '22023' ? 400 :
        500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    // RPC returns { applied: false, reason: 'already_reconciled_or_missing' }
    // when the row is already cleaned or doesn't exist. Surface as 409
    // so the UI can show a precise toast.
    if (data && data.applied === false) {
      throw createError({
        statusCode: 409,
        statusMessage:
          'This row was already reconciled by someone else or no longer has a legacy value.',
      })
    }

    return data
  },
})
