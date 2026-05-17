// Turn is_damage findings into property_charges.
//
// POST /api/inspections/[id]/charge-damages
//
// Wraps inspection_charge_damages() RPC. Idempotent â€” findings with
// damage_charge_id already set are skipped.

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
    const { data, error } = await (admin as any).rpc('inspection_charge_damages', {
      p_inspection_id: inspectionId,
    })

    if (error) {
      logger.error(
        { err: error.message, op: 'admin.inspections.charge_damages', inspection_id: inspectionId },
        'inspection_charge_damages_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: error.message })
      }
      if (code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: error.message })
      }
      if (/must be completed or tenant_signed/i.test(error.message ?? '')) {
        throw createError({ statusCode: 409, statusMessage: error.message })
      }
      if (/no lease_id|no tenant party/i.test(error.message ?? '')) {
        throw createError({ statusCode: 422, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not charge damages' })
    }

    const result = data as {
      inspection_id: string
      charges_created: number
      total_amount_minor: number
    }

    await logActivity({
      event,
      action: 'inspection.damages_charged',
      entity: 'inspection' as any,
      entityId: inspectionId,
      metadata: result,
    })

    return result
  },
})
