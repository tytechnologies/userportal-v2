// Remove an inspection finding.
//
// DELETE /api/inspections/[id]/findings/[fid]
//
// Only allowed while parent is scheduled/in_progress (RLS enforces).
// Refuses if the finding has a damage_charge_id â€” once a damage
// charge has been raised, the finding stays in the audit trail.
// Operator can void the charge separately via the existing
// property_charges flow.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'
import { deleteObjectsByKeys } from '~~/server/utils/s3'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'manager')

    const inspectionId = getRouterParam(event, 'id')
    const findingId = getRouterParam(event, 'fid')
    if (!inspectionId || !/^[0-9a-f-]{36}$/i.test(inspectionId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid inspection id' })
    }
    if (!findingId || !/^[0-9a-f-]{36}$/i.test(findingId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid finding id' })
    }

    const admin = getServerSupabaseAdmin()

    const { data: parent, error: parentErr } = await (admin as any)
      .from('inspections')
      .select('id, status')
      .eq('id', inspectionId)
      .maybeSingle()
    if (parentErr) {
      throw createError({ statusCode: 500, statusMessage: parentErr.message })
    }
    if (!parent) {
      throw createError({ statusCode: 404, statusMessage: 'Inspection not found' })
    }
    if (!['scheduled', 'in_progress'].includes(parent.status)) {
      throw createError({
        statusCode: 409,
        statusMessage: `Cannot delete findings on inspection in status=${parent.status}`,
      })
    }

    // Refuse delete on findings already turned into damage charges,
    // and pull the photos jsonb so we can cascade-delete S3 objects
    // after the row is gone.
    const { data: existing, error: existsErr } = await (admin as any)
      .from('inspection_findings')
      .select('id, damage_charge_id, photos')
      .eq('id', findingId)
      .eq('inspection_id', inspectionId)
      .maybeSingle()
    if (existsErr) {
      throw createError({ statusCode: 500, statusMessage: existsErr.message })
    }
    if (!existing) {
      throw createError({ statusCode: 404, statusMessage: 'Finding not found' })
    }
    if (existing.damage_charge_id) {
      throw createError({
        statusCode: 409,
        statusMessage:
          'Finding already has a damage_charge_id; void the charge first via property_charges, then delete.',
      })
    }

    const { error: delErr } = await (admin as any)
      .from('inspection_findings')
      .delete()
      .eq('id', findingId)
      .eq('inspection_id', inspectionId)
    if (delErr) {
      logger.error(
        { err: delErr.message, op: 'admin.inspection_findings.delete', finding_id: findingId },
        'inspection_finding_delete_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Could not delete finding' })
    }

    // Cascade-delete S3 objects for this finding's photos. Best-effort:
    // S3 failures don't undo the DB delete (the row is the source of
    // truth and the orphan keys would be cleaned by a future cron
    // anyway). Errors are logged but not surfaced as 5xx.
    let s3DeletedCount = 0
    try {
      const photos = Array.isArray(existing.photos) ? (existing.photos as Array<{ key?: string }>) : []
      const keys = photos.map((p) => p?.key).filter((k): k is string => !!k)
      if (keys.length > 0) {
        const result = await deleteObjectsByKeys(keys)
        s3DeletedCount = result.deleted
      }
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'admin.inspection_findings.delete.s3_cascade', finding_id: findingId },
        'inspection_finding_s3_cascade_failed',
      )
    }

    await logActivity({
      event,
      action: 'inspection_finding.deleted',
      entity: 'inspection' as any,
      entityId: inspectionId,
      metadata: { finding_id: findingId, s3_objects_deleted: s3DeletedCount },
    })

    return { finding_id: findingId, deleted: true, s3_objects_deleted: s3DeletedCount }
  },
})
