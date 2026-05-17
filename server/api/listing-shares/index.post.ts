// Share a listing with another user. RLS gates the INSERT to the
// listing's owner (or listings.write.all admins).
//
// shared_by_user_id is auto-set from auth.uid(); status starts at
// 'pending' so the recipient explicitly opts in via PATCH below.
//
// On UNIQUE conflict (listing_id, shared_with_user_id) we surface 409
// with the existing share id so the UI can show "already shared"
// instead of silently creating duplicates.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { notify } from '~~/server/utils/notifications'

const bodySchema = z.object({
  listing_id: z.number().int().positive(),
  shared_with_user_id: z.string().uuid(),
  share_role: z.enum(['co_broker', 'viewer']).optional(),
  message: z.string().max(2000).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    if (body.shared_with_user_id === user!.id) {
      throw createError({ statusCode: 400, statusMessage: 'Cannot share a listing with yourself.' })
    }

    const supabase = await serverSupabaseClient(event)

    const insert = {
      listing_id: body.listing_id,
      shared_with_user_id: body.shared_with_user_id,
      shared_by_user_id: user!.id,
      share_role: body.share_role ?? 'co_broker',
      status: 'pending' as const,
      message: body.message ?? null,
      expires_at: body.expires_at ?? null,
    }

    const { data, error } = await (supabase as any)
      .from('listing_shares')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      if ((error as any).code === '23505') {
        // Already shared → return the existing row's id so the UI can
        // open it directly instead of creating a duplicate.
        const { data: existing } = await (supabase as any)
          .from('listing_shares')
          .select('id, status')
          .eq('listing_id', body.listing_id)
          .eq('shared_with_user_id', body.shared_with_user_id)
          .maybeSingle()
        throw createError({
          statusCode: 409,
          statusMessage: 'This listing is already shared with that user.',
          data: { existing_id: existing?.id ?? null, status: existing?.status ?? null },
        })
      }
      logger.error({ err: error.message, op: 'listing_shares.create' }, 'listing_shares_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Fire-and-forget notification to the recipient. Failure here does
    // not roll back the share — the recipient can still see it under
    // /shares even without a notification.
    await notify({
      recipientUserId: body.shared_with_user_id,
      actorUserId: user!.id,
      kind: 'listing.shared',
      title: 'New listing shared with you',
      body: body.message?.trim() || `You've been invited to ${body.share_role ?? 'co_broker'} on a listing.`,
      href: '/shares',
      listingId: body.listing_id,
      metadata: { share_id: data.id, share_role: data.share_role },
    })

    setResponseStatus(event, 201)
    return data
  },
})
