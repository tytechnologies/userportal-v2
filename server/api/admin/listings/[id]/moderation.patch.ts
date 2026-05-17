// Admin — listing moderation verdict.
//
// PATCH /api/admin/listings/:id/moderation
// Body: { action: 'approve' | 'reject' | 'hold', notes? }
//
// Actions:
//   approve → flips is_online=true (publishes the listing).
//             Requires current state: is_online=false, deleted_at=null.
//   reject  → soft-delete (deleted_at=now()). One-way; the listing
//             can still be restored via the existing soft-delete
//             reversal path if it exists.
//   hold    → no DB mutation; logs activity for audit.
//
// All actions audit-logged via log_activity. Verdict is admin-only;
// RLS gates the underlying UPDATE.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'

const ID_RE = /^([0-9a-f-]{36}|[0-9]+)$/i

const bodySchema = z.object({
  action: z.enum(['approve', 'reject', 'hold']),
  notes:  z.string().trim().max(2000).optional().nullable(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id') || ''
    if (!ID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }

    const b = body as z.infer<typeof bodySchema>
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Pre-check current state.
    const { data: current, error: readErr } = await (supabase as any)
      .from('listings')
      .select('id, is_online, deleted_at, title, created_by, source_id')
      .eq('id', id)
      .maybeSingle()
    if (readErr) throw createError({ statusCode: 500, statusMessage: readErr.message })
    if (!current) throw createError({ statusCode: 404, statusMessage: 'Listing not found' })

    let updatePayload: Record<string, unknown> | null = null
    let verb = ''

    if (b.action === 'approve') {
      if (current.is_online) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Listing is already published',
        })
      }
      if (current.deleted_at) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Listing is soft-deleted; restore it first',
        })
      }
      updatePayload = { is_online: true, updated_at: new Date().toISOString() }
      verb = 'listing.moderation_approved'
    } else if (b.action === 'reject') {
      if (current.deleted_at) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Listing is already soft-deleted',
        })
      }
      updatePayload = {
        deleted_at: new Date().toISOString(),
        is_online:  false,
        updated_at: new Date().toISOString(),
      }
      verb = 'listing.moderation_rejected'
    } else {
      // hold
      verb = 'listing.moderation_held'
    }

    if (updatePayload) {
      const { error: updErr } = await (supabase as any)
        .from('listings')
        .update(updatePayload)
        .eq('id', id)
      if (updErr) throw createError({ statusCode: 500, statusMessage: updErr.message })
    }

    await (supabase as any).rpc('log_activity', {
      p_action: verb,
      p_metadata: {
        listing_id: id,
        title:      current.title,
        broker_id:  current.created_by,
        source_id:  current.source_id,
        notes:      b.notes ?? null,
      },
    }).catch((err: any) =>
      console.warn('[admin/listings.moderation.patch] log_activity failed', err),
    )

    return { ok: true, action: b.action, listing_id: id }
  },
})
