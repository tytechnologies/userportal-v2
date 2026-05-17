// Update an inspection finding.
//
// PATCH /api/inspections/[id]/findings/[fid]
// Body: any of { area, item, condition, description, is_damage,
//                estimated_cost_minor, baseline_finding_id, photos }
//
// RLS gates writes to scheduled/in_progress parent inspections.
// Server-side we additionally verify the parent status to surface a
// nicer 409 instead of a silent 0-row update.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const bodySchema = z
  .object({
    area: z.string().trim().min(1).max(64).optional(),
    item: z.string().trim().min(1).max(64).optional(),
    condition: z
      .enum([
        'excellent',
        'good',
        'fair',
        'damaged',
        'requires_repair',
        'requires_replacement',
        'missing',
      ])
      .optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    is_damage: z.boolean().optional(),
    estimated_cost_minor: z.number().int().min(0).nullable().optional(),
    baseline_finding_id: z.string().uuid().nullable().optional(),
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
  // The CHECK constraint on the table enforces is_damage ↔ cost; we
  // re-validate here so the API returns 422 with a clear message
  // instead of bouncing off the DB.
  .refine(
    (b) => {
      // Only validate when both fields are being patched. If the caller
      // only patches is_damage to false and leaves cost null, that's fine.
      if (b.is_damage === true && (b.estimated_cost_minor == null || b.estimated_cost_minor <= 0)) {
        return false
      }
      return true
    },
    { message: 'is_damage=true requires estimated_cost_minor > 0' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
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

    // Verify parent is mutable (or caller is admin — RBAC was already
    // checked, but we still reject completed/signed for safety so the
    // ledger stays append-only after the lock).
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
        statusMessage: `Cannot modify findings on inspection in status=${parent.status}`,
      })
    }

    // Build the patch from only the keys the caller sent.
    const patch: Record<string, unknown> = {}
    for (const k of [
      'area',
      'item',
      'condition',
      'description',
      'is_damage',
      'estimated_cost_minor',
      'baseline_finding_id',
      'photos',
    ] as const) {
      const v = (body as any)[k]
      if (v !== undefined) patch[k] = v
    }
    if (Object.keys(patch).length === 0) {
      return { finding_id: findingId, updated: false }
    }

    const { data: updated, error: updateErr } = await (admin as any)
      .from('inspection_findings')
      .update(patch)
      .eq('id', findingId)
      .eq('inspection_id', inspectionId)
      .select('*')
      .single()
    if (updateErr) {
      logger.error(
        {
          err: updateErr.message,
          op: 'admin.inspection_findings.patch',
          finding_id: findingId,
        },
        'inspection_finding_patch_failed',
      )
      const code = (updateErr as any).code as string | undefined
      if (code === '23514') {
        throw createError({ statusCode: 422, statusMessage: updateErr.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not update finding' })
    }

    return { finding: updated }
  },
})
