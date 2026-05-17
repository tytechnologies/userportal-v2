// Read one tax computation record. RLS gates whether the caller can
// see it; 404 covers both "missing" and "hidden by RLS" so existence
// doesn't leak.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('tax_computations')
      .select(
        '*, owner:profiles!owner_user_id (id, full_name, avatar_url)',
      )
      .eq('id', id)
      .maybeSingle()

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Tax computation not found' })

    return data
  },
})
