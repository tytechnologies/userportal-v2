// Lock + complete an inspection.
//
// POST /api/inspections/[id]/complete
//
// Wraps inspection_complete() RPC. Validates â‰¥1 finding (RPC enforces
// it; we just surface the error nicely). Stamps overall_condition +
// total_damage_estimate_minor.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'manager')

    const inspectionId = getRouterParam(event, 'id')
    if (!inspectionId || !/^[0-9a-f-]{36}$/i.test(inspectionId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid inspection id' })
    }

    const admin = getServerSupabaseAdmin()
    const { error } = await (admin as any).rpc('inspection_complete', {
      p_inspection_id: inspectionId,
    })

    if (error) {
      logger.error(
        { err: error.message, op: 'admin.inspections.complete', inspection_id: inspectionId },
        'inspection_complete_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: error.message })
      }
      if (code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: error.message })
      }
      // RAISE EXCEPTION without code (e.g., "requires at least one finding"
      // or "cannot complete from status X") â†’ 422 / 409.
      if (/at least one finding/i.test(error.message ?? '')) {
        throw createError({ statusCode: 422, statusMessage: error.message })
      }
      if (/cannot complete from status/i.test(error.message ?? '')) {
        throw createError({ statusCode: 409, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not complete inspection' })
    }

    await logActivity({
      event,
      action: 'inspection.completed',
      entity: 'inspection' as any,
      entityId: inspectionId,
      metadata: {},
    })

    return { inspection_id: inspectionId, completed: true }
  },
})
