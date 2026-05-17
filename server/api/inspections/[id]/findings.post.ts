// Add a finding to an inspection.
//
// POST /api/inspections/[id]/findings
// Body: {
//   area: string,
//   item: string,
//   condition: 'excellent'|'good'|'fair'|'damaged'|'requires_repair'|'requires_replacement'|'missing',
//   description?: string,
//   is_damage?: boolean,
//   estimated_cost_minor?: number,
//   baseline_finding_id?: uuid,
//   photos?: Array<{ url: string }>
// }
//
// Allowed only while parent inspection is in 'scheduled' or
// 'in_progress' status (RLS enforces). Inserting auto-flips the
// inspection to 'in_progress' if currently 'scheduled' (for fluent UX).

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const bodySchema = z
  .object({
    area: z.string().trim().min(1).max(64),
    item: z.string().trim().min(1).max(64),
    condition: z.enum([
      'excellent',
      'good',
      'fair',
      'damaged',
      'requires_repair',
      'requires_replacement',
      'missing',
    ]),
    description: z.string().trim().max(2000).optional(),
    is_damage: z.boolean().default(false),
    estimated_cost_minor: z.number().int().min(0).optional(),
    baseline_finding_id: z.string().uuid().optional(),
    photos: z
      .array(
        z
          .object({
            url: z.string().min(1).max(2048).optional(),
            key: z.string().min(1).max(2048).optional(),
            name: z.string().max(200).optional(),
          })
          .refine((p) => !!(p.url || p.key), {
            message: 'photo must include either url or key',
          }),
      )
      .max(12)
      .optional(),
  })
  .refine(
    (b) => !b.is_damage || (b.estimated_cost_minor != null && b.estimated_cost_minor > 0),
    { message: 'is_damage requires estimated_cost_minor > 0' },
  )

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

    // Verify parent inspection is mutable.
    const { data: inspection, error: inspErr } = await (admin as any)
      .from('inspections')
      .select('id, status')
      .eq('id', inspectionId)
      .maybeSingle()
    if (inspErr) {
      throw createError({ statusCode: 500, statusMessage: inspErr.message })
    }
    if (!inspection) {
      throw createError({ statusCode: 404, statusMessage: 'Inspection not found' })
    }
    if (!['scheduled', 'in_progress'].includes(inspection.status)) {
      throw createError({
        statusCode: 409,
        statusMessage: `Cannot add findings to inspection in status=${inspection.status}`,
      })
    }

    const { data: created, error: insertErr } = await (admin as any)
      .from('inspection_findings')
      .insert({
        inspection_id: inspectionId,
        area: body.area,
        item: body.item,
        condition: body.condition,
        description: body.description ?? null,
        is_damage: body.is_damage,
        estimated_cost_minor: body.estimated_cost_minor ?? null,
        baseline_finding_id: body.baseline_finding_id ?? null,
        photos: body.photos ?? [],
      })
      .select('*')
      .single()
    if (insertErr) {
      logger.error(
        { err: insertErr.message, op: 'admin.inspection_findings.create', inspection_id: inspectionId },
        'inspection_finding_create_failed',
      )
      const code = (insertErr as any).code as string | undefined
      if (code === '23514') {
        throw createError({ statusCode: 422, statusMessage: insertErr.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not add finding' })
    }

    // Fluent state: a 'scheduled' inspection becomes 'in_progress' as
    // soon as the first finding lands. Errors here are non-fatal.
    if (inspection.status === 'scheduled') {
      await (admin as any)
        .from('inspections')
        .update({ status: 'in_progress', conducted_at: new Date().toISOString() })
        .eq('id', inspectionId)
        .eq('status', 'scheduled')
        .then((r: any) => r)
        .catch((err: any) =>
          logger.warn(
            { err: err?.message, op: 'admin.inspections.auto_in_progress' },
            'inspection_auto_in_progress_failed',
          ),
        )
    }

    return { finding: created }
  },
})
