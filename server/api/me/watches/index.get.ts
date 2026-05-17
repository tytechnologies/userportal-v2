// List the caller's market watches.
//
// GET /api/me/watches
// Auth: required. RLS scopes to user_id = auth.uid().
//
// Resolves a display label per watch by joining to the target's
// table â€” buildings / cities / barangays / profiles / developers /
// organizations. Cheap because total watch count per user is small
// (capped at 50 on POST).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data: watches, error } = await (supabase as any)
      .from('market_watches')
      .select('id, target_type, target_id, alert_types, label, last_evaluated_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    if (!watches || watches.length === 0) return { watches: [] }

    // Resolve labels by target_type â†’ table. Group target_ids per
    // type so we issue at most 6 small IN-queries.
    const byType: Record<string, Set<string>> = {}
    for (const w of watches) {
      ;(byType[w.target_type] ||= new Set()).add(String(w.target_id))
    }

    const labelMap = new Map<string, string>() // key = `${type}:${id}`

    async function resolveType(type: string, table: string, idCol: string, nameCol: string, idCast: 'text' | 'numeric' | 'uuid' = 'text') {
      const ids = byType[type]
      if (!ids || ids.size === 0) return
      // PostgREST .in() handles strings; numeric-PK tables coerce server-side.
      const idArr = Array.from(ids)
      const { data } = await (supabase as any)
        .from(table)
        .select(`${idCol}, ${nameCol}`)
        .in(idCol, idArr)
      for (const row of data ?? []) {
        labelMap.set(`${type}:${row[idCol]}`, row[nameCol])
      }
    }

    await Promise.all([
      resolveType('building',     'buildings',    'id', 'name'),
      resolveType('city',         'cities',       'id', 'name'),
      resolveType('barangay',     'barangays',    'id', 'name'),
      resolveType('broker',       'profiles',     'id', 'full_name'),
      resolveType('organization', 'organizations','id', 'name'),
    ])
    // Skipping 'developer' â€” only resolve when developers table exists;
    // the label falls back to the stored watch.label or the raw id.

    const enriched = watches.map((w: any) => ({
      ...w,
      resolved_label:
        labelMap.get(`${w.target_type}:${w.target_id}`) ?? w.label ?? `${w.target_type} #${w.target_id}`,
    }))

    return { watches: enriched }
  },
})
