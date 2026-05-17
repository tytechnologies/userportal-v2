// Update inspection metadata.
//
// PATCH /api/inspections/[id]
// Body: { scheduled_at?, summary_notes?, inspector_external_name? }
//
// Status-gated server-side: only metadata fields shown above can be
// patched, and only while parent is scheduled/in_progress (or by
// admin/manager always â€” RLS handles that). Status transitions go
// through the dedicated /complete, /cancel, and tenant_sign RPCs.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  scheduled_at: z.string().datetime().nullable().optional(),
  conducted_at: z.string().datetime().nullable().optional(),
  inspector_external_name: z.string().trim().min(1).max(200).nullable().optional(),
  summary_notes: z.string().trim().max(2000).nullable().optional(),
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

    // Verify it exists + status is editable. Managers can edit
    // completed/tenant_signed too (e.g., post-hoc note correction)
    // but we surface that explicitly via the status read.
    const { data: existing, error: existsErr } = await (admin as any)
      .from('inspections')
      .select('id, status')
      .eq('id', inspectionId)
      .maybeSingle()
    if (existsErr) {
      throw createError({ statusCode: 500, statusMessage: existsErr.message })
    }
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Inspection not found' })
    }

    // Build the patch with only the fields the caller actually sent.
    const patch: Record<string, unknown> = {}
    if (body.scheduled_at !== undefined) patch.scheduled_at = body.scheduled_at
    if (body.conducted_at !== undefined) patch.conducted_at = body.conducted_at
    if (body.inspector_external_name !== undefined)
      patch.inspector_external_name = body.inspector_external_name
    if (body.summary_notes !== undefined) patch.summary_notes = body.summary_notes

    if (Object.keys(patch).length === 0) {
      return { inspection_id: inspectionId, updated: false }
    }

    const { data: updated, error: updateErr } = await (admin as any)
      .from('inspections')
      .update(patch)
      .eq('id', inspectionId)
      .select('*')
      .single()
    if (updateErr) {
      logger.error(
        { err: updateErr.message, op: 'admin.inspections.patch', inspection_id: inspectionId },
        'inspection_patch_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Could not update inspection' })
    }

    await logActivity({
      event,
      action: 'inspection.updated',
      entity: 'inspection' as any,
      entityId: inspectionId,
      metadata: { changed_fields: Object.keys(patch) },
    })

    return { inspection: updated }
  },
})
