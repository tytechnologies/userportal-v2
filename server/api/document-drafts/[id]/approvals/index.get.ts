// List approvals on a draft. Newest first; includes withdrawn so
// the timeline is complete.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid draft id' })
    }
    const supabase = await serverSupabaseClient(event)
    // Two-step fetch instead of an embedded join — PostgREST's
    // schema-cache resolution for the profiles FK has been
    // unreliable. See server/api/document-approvals/mine.get.ts for
    // the same pattern + reasoning.
    const { data: rows, error } = await (supabase as any)
      .from('document_approvals')
      .select('*')
      .eq('draft_id', id)
      .order('requested_at', { ascending: false })
    if (error) {
      logger.error({ err: error.message, op: 'doc_approvals.list' }, 'doc_approvals_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    const approvals = rows ?? []

    // Hydrate both reviewer + requester profiles in one round-trip.
    const profileIds = Array.from(new Set([
      ...approvals.map((a: any) => a.reviewer_user_id).filter(Boolean),
      ...approvals.map((a: any) => a.requested_by).filter(Boolean),
    ])) as string[]
    const profileMap = new Map<string, { id: string; full_name: string | null; avatar_url: string | null }>()
    if (profileIds.length > 0) {
      const { data: profiles } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', profileIds)
      for (const p of (profiles ?? [])) profileMap.set(p.id, p)
    }

    return {
      data: approvals.map((a: any) => ({
        ...a,
        reviewer:  a.reviewer_user_id ? profileMap.get(a.reviewer_user_id) ?? null : null,
        requester: a.requested_by    ? profileMap.get(a.requested_by)    ?? null : null,
      })),
    }
  },
})
