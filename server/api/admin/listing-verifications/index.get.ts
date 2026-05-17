// Admin queue — listing verifications.
//
// GET /api/admin/listing-verifications?status=pending
// Auth: admin + verifications.review_listings (RLS enforced).
//
// Joins the listing's basic display fields inline so moderators can
// triage without a per-row second fetch.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
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
      .from('listing_verifications')
      .select(`
        id, listing_id, status, evidence_url, applicant_notes,
        submitted_by, submitted_at, reviewed_by, reviewed_at, review_notes,
        listing:listings!listing_verifications_listing_id_fkey
          (id, title, sale_price, rent_price, for_sale, for_rent, is_online,
           created_by),
        submitter:public_profiles!listing_verifications_submitted_by_fkey
          (id, full_name, avatar_url, slug)
      `)
      .eq('status', q.status)
      .order('submitted_at', { ascending: false })
      .limit(q.limit)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { data: data ?? [] }
  },
})
