// Terminal-cancel an inspection.
//
// POST /api/inspections/[id]/cancel
// Body: { reason: string }
//
// Allowed from any non-terminal status. Reason is required for audit.
// Findings are kept (read-only) â€” useful when an inspection was
// scheduled but never conducted, or interrupted mid-walk-through.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const inspectionId = getRouterParam(event, 'id')
    if (!inspectionId || !/^[0-9a-f-]{36}$/i.test(inspectionId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid inspection id' })
    }

    const admin = getServerSupabaseAdmin()

    const { data: existing, error: existsErr } = await (admin as any)
      .from('inspections')
      .select('id, status, metadata')
      .eq('id', inspectionId)
      .maybeSingle()
    if (existsErr) {
      throw createError({ statusCode: 500, statusMessage: existsErr.message })
    }
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Inspection not found' })
    }
    if (existing.status === 'cancelled') {
      // Idempotent.
      return { inspection_id: inspectionId, cancelled: true, idempotent: true }
    }
    if (existing.status === 'tenant_signed') {
      throw createError({
        statusCode: 409,
        statusMessage:
          'Cannot cancel a tenant-signed inspection. To withdraw it, void any damage charges raised from it instead.',
      })
    }

    const { error: updateErr } = await (admin as any)
      .from('inspections')
      .update({
        status: 'cancelled',
        metadata: {
          ...(existing.metadata ?? {}),
          cancel_reason: body.reason,
          cancelled_at: new Date().toISOString(),
        },
      })
      .eq('id', inspectionId)
    if (updateErr) {
      logger.error(
        { err: updateErr.message, op: 'admin.inspections.cancel', inspection_id: inspectionId },
        'inspection_cancel_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Could not cancel inspection' })
    }

    await logActivity({
      event,
      action: 'inspection.cancelled',
      entity: 'inspection' as any,
      entityId: inspectionId,
      metadata: { reason: body.reason },
    })

    return { inspection_id: inspectionId, cancelled: true }
  },
})
