// List active unit ownerships for an owner.
//
// GET /api/property-owners/[id]/units
//
// Reads `unit_owners` directly with `ended_at IS NULL` so we get the
// share_pct + is_primary + effective_at + source metadata that the
// `unit_current_owner` view drops. RLS already permits owner self-read
// + property.manage on the table.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid owner id' })
    }

    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('unit_owners')
      .select(
        'id, unit_id, is_primary, share_pct, effective_at, source',
      )
      .eq('owner_id', id)
      .is('ended_at', null)
      .order('is_primary', { ascending: false })
      .order('effective_at', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return {
      items: (data ?? []).map((r: any) => ({
        unit_owner_id: r.id,
        unit_id: r.unit_id,
        is_primary: r.is_primary,
        share_pct: r.share_pct,
        effective_at: r.effective_at,
        source: r.source,
      })),
    }
  },
})
