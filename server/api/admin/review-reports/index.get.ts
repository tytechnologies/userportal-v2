// Moderation queue — list open review reports.
//
// GET /api/admin/review-reports?status=open|reviewed|dismissed&limit=50
// Auth: required + reviews.moderate permission (RLS enforces).
//
// Response includes the review body inline so the moderator can
// triage without a per-row second fetch. reviewer + reporter
// resolved via public_profiles join.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  status: z.enum(['open', 'reviewed', 'dismissed']).default('open'),
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
      .from('review_reports')
      .select(
        `id, review_id, reason, status, created_at, reviewed_at, review_notes,
         reporter:public_profiles!review_reports_reporter_user_id_fkey
           (id, full_name, avatar_url, slug),
         review:reviews!review_reports_review_id_fkey
           (id, target_type, target_id, rating, title, body,
            hidden_at, hidden_reason, created_at,
            reviewer:public_profiles!reviews_reviewer_user_id_fkey
              (id, full_name, avatar_url, slug))`,
      )
      .eq('status', q.status)
      .order('created_at', { ascending: false })
      .limit(q.limit)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return { data: data ?? [] }
  },
})
