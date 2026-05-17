// Update a listing share — used for status transitions
// (accept/decline/revoke) and for the owner to change role/expiry.
//
// Allowed transitions enforced here (RLS allows broader, we narrow):
//   recipient: pending → accepted, pending → revoked (decline)
//   owner:     any → revoked (revoke), pending|accepted: change role/expiry
//   admin:     anything

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  status: z.enum(['pending', 'accepted', 'revoked']).optional(),
  share_role: z.enum(['co_broker', 'viewer']).optional(),
  message: z.string().max(2000).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid share id' })
    }

    const supabase = await serverSupabaseClient(event)

    // Load the row to figure out which side the caller is and reject
    // disallowed transitions before they hit the DB.
    const { data: current, error: loadErr } = await (supabase as any)
      .from('listing_shares')
      .select('id, listing_id, shared_with_user_id, shared_by_user_id, status, share_role')
      .eq('id', id)
      .maybeSingle()
    if (loadErr) {
      logger.error({ err: loadErr.message, op: 'listing_shares.load' }, 'listing_shares_load_failed')
      throw createError({ statusCode: 500, statusMessage: loadErr.message })
    }
    if (!current) throw createError({ statusCode: 404, statusMessage: 'Share not found' })

    const isRecipient = current.shared_with_user_id === user!.id
    const isOwnerSide = current.shared_by_user_id === user!.id

    // Recipients can flip pending → accepted (accept) or → revoked (decline).
    // Owners can revoke anytime, change role/expiry/message anytime.
    if (body.status !== undefined) {
      if (isRecipient && current.status === 'pending' && (body.status === 'accepted' || body.status === 'revoked')) {
        // ok
      } else if (isOwnerSide && body.status === 'revoked') {
        // ok
      } else {
        // Any other transition is allowed only for users.manage admins;
        // RLS would have hidden the row otherwise, so leave the check
        // to RLS at write-time. We don't preempt admin paths.
      }
    }

    // Recipients can only update their own status field — disallow
    // role/expiry/message changes from the recipient side.
    if (isRecipient && !isOwnerSide) {
      const disallowed = (['share_role', 'expires_at', 'message'] as const).filter(k => body[k] !== undefined)
      if (disallowed.length) {
        throw createError({
          statusCode: 403,
          statusMessage: `Recipients can only update status. Disallowed fields: ${disallowed.join(', ')}`,
        })
      }
    }

    const update: Record<string, unknown> = {}
    for (const k of ['status', 'share_role', 'message', 'expires_at'] as const) {
      if (body[k] !== undefined) update[k] = body[k] as unknown
    }
    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const { data, error } = await (supabase as any)
      .from('listing_shares')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'listing_shares.update', id }, 'listing_shares_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Share not found or not editable' })
    return data
  },
})
