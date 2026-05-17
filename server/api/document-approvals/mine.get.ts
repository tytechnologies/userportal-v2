// "Pending approvals I need to review" â€” every document_approvals row
// where reviewer_user_id = caller and status = 'pending'.
//
// Returns the approval rows hydrated with the parent draft's title +
// type + last-update so a reviewer can scan the queue and click into
// the highest-priority items first. RLS already gates per-row read
// visibility (a reviewer always sees their own pending row).
//
// GET /api/document-approvals/mine?limit=50

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../utils/sbUser'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const q = query as z.infer<typeof querySchema>
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Two-step fetch instead of an embedded join. PostgREST's
    // schema-cache resolution for FKs into `profiles` has been
    // unreliable across deployments â€” when the cache is stale or the
    // FK alias differs from the constraint name, the embed errors
    // with "Could not find a relationship in the schema cache."
    // Splitting means the join works regardless of cache state. Both
    // round-trips are cheap PK lookups on small result sets.
    const { data: rows, error } = await (supabase as any)
      .from('document_approvals')
      .select('id, draft_id, status, comment, version_id, requested_at, requested_by, reviewer_user_id, draft:document_drafts (id, title, doc_type_key, status, updated_at)')
      .eq('reviewer_user_id', user.id)
      .eq('status', 'pending')
      .order('requested_at', { ascending: false })
      .limit(q.limit)
    if (error) {
      logger.error({ err: error.message, op: 'doc_approvals.mine' }, 'doc_approvals_mine_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    const approvals = rows ?? []

    // Hydrate requester profiles in one round-trip via .in().
    const requesterIds = Array.from(
      new Set(approvals.map((a: any) => a.requested_by).filter(Boolean)),
    ) as string[]
    const profileMap = new Map<string, { id: string; full_name: string | null; avatar_url: string | null }>()
    if (requesterIds.length > 0) {
      const { data: profiles } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', requesterIds)
      for (const p of (profiles ?? [])) profileMap.set(p.id, p)
    }

    // Stitch requester back onto each approval; drop rows whose
    // parent draft the caller can't read (RLS projection).
    const visible = approvals
      .filter((r: any) => r.draft)
      .map((r: any) => ({
        ...r,
        requester: r.requested_by ? profileMap.get(r.requested_by) ?? null : null,
      }))
    return { data: visible }
  },
})
