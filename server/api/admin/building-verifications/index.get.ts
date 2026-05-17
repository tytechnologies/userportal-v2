// Admin queue — building verifications.
//
// GET /api/admin/building-verifications?status=approved
// Auth: admin + verifications.review_buildings.
//
// Default status='approved' — buildings are typically directly
// verified by an admin (no submit-then-approve flow), so the
// "approved" view is the working list. The pending view exists for
// completeness in case a future flow emits pending requests.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('approved'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('building_verifications')
      .select(`
        id, property_id, status, evidence_url, applicant_notes,
        submitted_by, submitted_at, reviewed_by, reviewed_at, review_notes,
        building:buildings!building_verifications_property_id_fkey
          (id, name, slug, address, is_curated)
      `)
      .eq('status', q.status)
      .order('submitted_at', { ascending: false })
      .limit(q.limit)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { data: data ?? [] }
  },
})
