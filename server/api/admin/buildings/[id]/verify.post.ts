// Direct-verify a building (admin shortcut).
//
// POST /api/admin/buildings/:id/verify
// Body: { status: 'approved' | 'rejected' | 'pending', evidence_url?, review_notes? }
// Auth: admin + verifications.review_buildings.
//
// Buildings don't have an obvious self-submitter, so we collapse
// submit + review into one endpoint. Defaults to status='approved'
// because the typical admin action is "yes, this building is
// real / curated → mark verified". The other states exist for
// completeness; admins can downgrade or revoke.
//
// UNIQUE(property_id) on building_verifications means re-calling
// upserts the existing row. Status flip is the typical use.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('approved'),
  evidence_url: z.string().trim().url().max(2048).nullable().optional(),
  review_notes: z.string().trim().max(2000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isFinite(id) || id <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid building id' })
    }

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Confirm building exists. RLS on the building_verifications
    // INSERT branch doesn't gate this — but a misuse of the endpoint
    // (calling with a non-existent building id) would surface as a
    // 23503 from the FK; better to return 404 cleanly.
    const { data: building } = await (supabase as any)
      .from('buildings')
      .select('id, name')
      .eq('id', id)
      .maybeSingle()
    if (!building) {
      throw createError({ statusCode: 404, statusMessage: 'Building not found' })
    }

    const now = new Date().toISOString()
    const { data, error } = await (supabase as any)
      .from('building_verifications')
      .upsert(
        {
          property_id: id,
          submitted_by: user.id,
          status: body.status,
          evidence_url: body.evidence_url ?? null,
          submitted_at: now,
          reviewed_by: user.id,
          reviewed_at: now,
          review_notes: body.review_notes ?? null,
        },
        { onConflict: 'property_id' },
      )
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'building_verifications.verify', id },
        'building_verification_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const auditAction =
      body.status === 'approved' ? 'verification.building_approved' :
      body.status === 'rejected' ? 'verification.building_rejected' :
      'verification.building_submitted'

    await logActivity({
      event,
      client: supabase,
      action: auditAction,
      entity: 'building',
      metadata: {
        property_id: id,
        building_name: building.name,
        verification_id: data.id,
        new_status: data.status,
      },
    })

    return data
  },
})
