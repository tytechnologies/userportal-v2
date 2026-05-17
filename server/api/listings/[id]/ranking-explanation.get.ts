// Listing ranking explanation — admin debug.
//
// GET /api/listings/:id/ranking-explanation
// Auth: admin (admin.access permission, RPC-gated).
//
// Returns the per-listing breakdown: discovery signals, quality
// components, and the score for every active sort mode. Powers the
// "Why this listing ranks here" admin tooling — never exposed to
// non-admins (the formula transparency is for ranking-fairness
// audits, not customer UX).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const ID_RE = /^([0-9a-f-]{36}|[0-9]+)$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const id = getRouterParam(event, 'id') || ''
    if (!ID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid listing id' })
    }

    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any).rpc('listing_ranking_explanation', {
      p_listing_id: id,
    })
    if (error) {
      const status = error.code === '42501' ? 403 : 500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    return data
  },
})
