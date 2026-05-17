// Listing-shares repository â€” system of record for the
// /api/listings/[id]/shares/* endpoints.
//
// Operations:
//   - create({ listingId, sharedWithUserId, permissions, message, expiresAt })
//   - listForListing({ listingId })
//   - update({ id, status?, permissions?, message?, expiresAt? })
//   - listForRecipient({ userId })  â€” the "shared with me" inbox
//
// Audit rules:
//   create   â†’ logActivity(listing.shared)   + notify(share_received) to recipient
//   accept   â†’ logActivity(listing.share_accepted) + notify(share_accepted) to source owner
//   revoke   â†’ logActivity(listing.share_revoked)  + notify(share_revoked) to recipient
//   expire   â†’ handled by a background sweep (NOT this repo); fires
//              listing.share_expired audit verb when status flips
//
// Notification kinds (additive â€” notifications.kind is free-form text):
//   listing.share_received   â†’ recipient gets bell + email
//   listing.share_accepted   â†’ source owner gets bell
//   listing.share_revoked    â†’ recipient gets bell

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'
import { sanitizeCapabilities, type ShareCapability } from '~~/server/utils/sharePermissions'

export type ShareCreateInput = {
  listingId: number
  sharedWithUserId: string
  permissions?: Record<string, unknown>
  shareRole?: 'co_broker' | 'viewer'  // legacy; only honored when permissions empty
  message?: string | null
  expiresAt?: string | null
}

export type ShareUpdateInput = {
  status?: 'accepted' | 'revoked'
  permissions?: Record<string, unknown>
  message?: string | null
  expiresAt?: string | null
}

export const sharesRepo = {
  async listForListing({ event, listingId }: { event: H3Event; listingId: number }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('listing_shares')
      .select(`
        id, listing_id, shared_with_user_id, shared_by_user_id,
        share_role, status, permissions, message, expires_at,
        created_at, updated_at,
        recipient:profiles!listing_shares_shared_with_user_id_fkey (id, full_name, email, avatar_url),
        sharer:profiles!listing_shares_shared_by_user_id_fkey (id, full_name, email, avatar_url)
      `)
      .eq('listing_id', listingId)
      .order('created_at', { ascending: false })
    if (error) {
      logger.error({ err: error.message, op: 'shares.list_for_listing', listingId }, 'shares_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data ?? []
  },

  async listForRecipient({ event, userId }: { event: H3Event; userId: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('listing_shares')
      .select(`
        id, listing_id, shared_by_user_id,
        share_role, status, permissions, message, expires_at, created_at,
        listing:listings!inner (id, title, sale_price, rent_price, for_sale, for_rent),
        sharer:profiles!listing_shares_shared_by_user_id_fkey (id, full_name, email, avatar_url)
      `)
      .eq('shared_with_user_id', userId)
      .order('created_at', { ascending: false })
    if (error) {
      logger.error({ err: error.message, op: 'shares.list_for_recipient' }, 'shares_inbox_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data ?? []
  },

  async create({ event, input }: { event: H3Event; input: ShareCreateInput }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const cleanPermissions = sanitizeCapabilities(input.permissions)
    const insertPayload: Record<string, unknown> = {
      listing_id: input.listingId,
      shared_with_user_id: input.sharedWithUserId,
      shared_by_user_id: user.id,
      share_role: input.shareRole ?? 'co_broker',
      permissions: cleanPermissions,
      message: input.message?.trim() || null,
      expires_at: input.expiresAt || null,
      status: 'pending',
    }

    // ON CONFLICT (listing_id, shared_with_user_id) DO UPDATE â€” re-share
    // updates the existing row (per the table's UNIQUE constraint).
    // upsert with onConflict so re-sharing a revoked share rehydrates it.
    const { data, error } = await (client as any)
      .from('listing_shares')
      .upsert(insertPayload, {
        onConflict: 'listing_id,shared_with_user_id',
      })
      .select(`
        id, listing_id, shared_with_user_id, shared_by_user_id,
        share_role, status, permissions, message, expires_at,
        created_at, updated_at
      `)
      .single()

    if (error) {
      logger.error({ err: error.message, op: 'shares.create' }, 'shares_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      client,
      action: 'listing.shared',
      entity: 'listing',
      metadata: {
        listing_id: input.listingId,
        share_id: data.id,
        recipient_user_id: input.sharedWithUserId,
        share_role: data.share_role,
        capability_count: Object.keys(cleanPermissions).length,
      },
    })

    // Fan out to the recipient. notify() is fire-and-forget (try/catch
    // inside the helper) so a failed bell delivery never breaks the
    // share creation.
    try {
      // Look up listing title for the notification body.
      const { data: listing } = await (client as any)
        .from('listings')
        .select('title')
        .eq('id', input.listingId)
        .maybeSingle()

      await notify({
        recipientUserId: input.sharedWithUserId,
        actorUserId: user.id,
        kind: 'listing.share_received',
        title: 'You have a new co-broker invite',
        body: listing?.title
          ? `Listing shared with you: ${listing.title}`
          : 'A listing has been shared with you',
        href: `/shares?id=${encodeURIComponent(data.id)}`,
        listingId: input.listingId,
        metadata: {
          share_id: data.id,
          share_role: data.share_role,
        },
      })
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'shares.create.notify' },
        'share_notify_failed',
      )
    }

    return data
  },

  async update({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: ShareUpdateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const update: Record<string, unknown> = {}
    if (input.status !== undefined) update.status = input.status
    if (input.permissions !== undefined) {
      update.permissions = sanitizeCapabilities(input.permissions)
    }
    if (input.message !== undefined) update.message = input.message?.trim() || null
    if (input.expiresAt !== undefined) update.expires_at = input.expiresAt || null

    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const { data, error } = await (client as any)
      .from('listing_shares')
      .update(update)
      .eq('id', id)
      .select(`
        id, listing_id, shared_with_user_id, shared_by_user_id,
        share_role, status, permissions, message, expires_at,
        created_at, updated_at
      `)
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'shares.update', id }, 'shares_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Share not found or not editable by caller',
      })
    }

    // Audit verb mirrors the lifecycle transition.
    let auditAction:
      | 'listing.share_accepted'
      | 'listing.share_revoked'
      | 'listing.share_updated' = 'listing.share_updated'
    if (input.status === 'accepted') auditAction = 'listing.share_accepted'
    else if (input.status === 'revoked') auditAction = 'listing.share_revoked'

    await logActivity({
      event,
      client,
      action: auditAction,
      entity: 'listing',
      metadata: {
        listing_id: data.listing_id,
        share_id: data.id,
        recipient_user_id: data.shared_with_user_id,
        new_status: data.status,
      },
    })

    // Notify the OTHER side of the lifecycle transition:
    //   accept â†’ tell the source owner
    //   revoke â†’ tell the recipient
    try {
      if (input.status === 'accepted' && data.shared_by_user_id) {
        await notify({
          recipientUserId: data.shared_by_user_id,
          actorUserId: user?.id ?? null,
          kind: 'listing.share_accepted',
          title: 'Co-broker invite accepted',
          body: 'Your listing share has been accepted.',
          href: `/listings/${data.listing_id}`,
          listingId: data.listing_id,
          metadata: { share_id: data.id },
        })
      } else if (input.status === 'revoked') {
        await notify({
          recipientUserId: data.shared_with_user_id,
          actorUserId: user?.id ?? null,
          kind: 'listing.share_revoked',
          title: 'Listing share revoked',
          body: 'Your access to a shared listing has been revoked.',
          href: '/shares',
          listingId: data.listing_id,
          metadata: { share_id: data.id },
        })
      }
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'shares.update.notify' },
        'share_lifecycle_notify_failed',
      )
    }

    return data
  },
}
