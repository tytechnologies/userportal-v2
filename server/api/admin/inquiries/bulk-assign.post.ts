// Bulk-assign inquiries to an agent.
//
// POST /api/admin/inquiries/bulk-assign
// Body:
//   { inquiry_ids: uuid[]    (1..200)
//     assigned_user_id: uuid | null }
//
// Auth: admin. Used by the Unassigned tab + the system-status card's
// "route these now" affordance (the deferred path that closes the
// orphan-created_by → unassigned-inquiry loop).
//
// Validation:
//   - If assigned_user_id is non-null, profile must exist (FK).
//     Otherwise the underlying UPDATE would 23503 mid-batch.
//   - inquiry_ids capped at 200/request — keeps the audit fan-out
//     bounded and the UPDATE plan inexpensive.
//
// Audit: one inquiry.updated row per inquiry, capturing
// assigned_user_id and the operator. Reuses the standard logActivity
// path so the per-listing change-history drawer surfaces these too.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

// Accept either uuid (newer schema) or numeric (legacy integer
// primary key). Schema-drift defense: some databases never had the
// uuid migration applied. The string is passed verbatim to the
// `inquiries.id IN (...)` query — PostgREST coerces against the
// underlying column type.
const inquiryIdSchema = z.string().regex(
  /^([0-9a-f-]{36}|[0-9]+)$/i,
  'Inquiry id must be a uuid or numeric string',
)

const bodySchema = z.object({
  inquiry_ids: z
    .array(inquiryIdSchema)
    .min(1)
    .max(200),
  assigned_user_id: z.string().uuid().nullable(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const supabase = await serverSupabaseClient(event)

    // Profile-existence preflight when assigning (not unassigning).
    // Same defense as the public-inquiries endpoint — a stale
    // operator-picked uuid shouldn't 23503 the whole batch.
    if (body.assigned_user_id) {
      const { data: exists, error: profileErr } = await (supabase as any)
        .from('profiles')
        .select('id')
        .eq('id', body.assigned_user_id)
        .maybeSingle()
      if (profileErr) {
        throw createError({ statusCode: 500, statusMessage: profileErr.message })
      }
      if (!exists) {
        throw createError({
          statusCode: 422,
          statusMessage: 'assigned_user_id does not match an existing profile',
        })
      }
    }

    const { data: updated, error } = await (supabase as any)
      .from('inquiries')
      .update({ assigned_user_id: body.assigned_user_id })
      .in('id', body.inquiry_ids)
      .select('id, listing_id, assigned_user_id')

    if (error) {
      logger.error(
        { err: error.message, op: 'admin.inquiries.bulk_assign' },
        'admin_inquiries_bulk_assign_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const rows = (updated ?? []) as Array<{
      id: string
      listing_id: number
      assigned_user_id: string | null
    }>

    // Audit fan-out — one row per inquiry. Sequential, not parallel:
    // log_activity is a single short RPC call, and ordering matters
    // for the timeline (events should land in apply-order, not
    // network-jitter order).
    for (const r of rows) {
      await logActivity({
        event,
        client: supabase,
        action: 'inquiry.updated',
        entity: 'inquiry',
        entityId: r.id,
        metadata: {
          op: 'bulk_assign',
          fields: ['assigned_user_id'],
          assigned_user_id: r.assigned_user_id,
          listing_id: r.listing_id ?? null,
        },
      })
    }

    return {
      requested: body.inquiry_ids.length,
      updated: rows.length,
      missing: body.inquiry_ids.length - rows.length,
      assigned_user_id: body.assigned_user_id,
    }
  },
})
