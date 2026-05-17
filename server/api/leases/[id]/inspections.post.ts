// Schedule a new inspection on a lease.
//
// POST /api/leases/[id]/inspections
// Body: {
//   inspection_kind: 'move_in'|'move_out'|'mid_tenancy'|'maintenance'|'annual',
//   scheduled_at: 'YYYY-MM-DDTHH:MM:SSZ',
//   inspector_user_id?: uuid,        â€” defaults to caller
//   inspector_external_name?: string,
//   summary_notes?: string
// }
//
// Initial status='scheduled'. Findings can be added afterwards via
// POST /api/inspections/[id]/findings; lock + transition via
// POST /api/inspections/[id]/complete.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'
import { serverSupabaseUser } from '../../../utils/sbUser'

const bodySchema = z
  .object({
    inspection_kind: z.enum([
      'move_in',
      'move_out',
      'mid_tenancy',
      'maintenance',
      'annual',
    ]),
    scheduled_at: z.string().datetime().optional(),
    inspector_user_id: z.string().uuid().optional(),
    inspector_external_name: z.string().trim().min(1).max(200).optional(),
    summary_notes: z.string().trim().max(2000).optional(),
  })
  .refine(
    (b) => !!(b.inspector_user_id || b.inspector_external_name),
    { message: 'inspector_user_id or inspector_external_name is required' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const leaseId = getRouterParam(event, 'id')
    if (!leaseId || !/^[0-9a-f-]{36}$/i.test(leaseId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid lease id' })
    }

    const admin = getServerSupabaseAdmin()

    // Resolve unit_id from the lease so the inspection's unit_id is
    // authoritative â€” operators can't accidentally point a lease's
    // inspection at a different unit.
    const { data: lease, error: leaseErr } = await (admin as any)
      .from('leases')
      .select('id, unit_id, status')
      .eq('id', leaseId)
      .maybeSingle()
    if (leaseErr) {
      throw createError({ statusCode: 500, statusMessage: leaseErr.message })
    }
    if (!lease) {
      throw createError({ statusCode: 404, statusMessage: 'Lease not found' })
    }

    const caller = await serverSupabaseUser(event)
    const inspectorId = body.inspector_user_id ?? caller?.id ?? null

    const insertRow: Record<string, unknown> = {
      unit_id: lease.unit_id,
      lease_id: leaseId,
      inspection_kind: body.inspection_kind,
      inspector_user_id: inspectorId,
      inspector_external_name: body.inspector_external_name ?? null,
      scheduled_at: body.scheduled_at ?? null,
      summary_notes: body.summary_notes ?? null,
      created_by: caller?.id ?? null,
    }

    const { data: created, error: insertErr } = await (admin as any)
      .from('inspections')
      .insert(insertRow)
      .select(
        'id, inspection_no, unit_id, lease_id, inspection_kind, status, inspector_user_id, scheduled_at, created_at',
      )
      .single()
    if (insertErr) {
      logger.error(
        { err: insertErr.message, op: 'admin.inspections.create', lease_id: leaseId },
        'inspection_create_failed',
      )
      throw createError({ statusCode: 500, statusMessage: 'Could not schedule inspection' })
    }

    await logActivity({
      event,
      action: 'inspection.scheduled',
      entity: 'inspection' as any,
      entityId: created.id,
      metadata: {
        lease_id: leaseId,
        unit_id: lease.unit_id,
        inspection_kind: body.inspection_kind,
        scheduled_at: body.scheduled_at,
        inspection_no: created.inspection_no,
      },
    })

    return { inspection: created }
  },
})
