// Remove a market watch.
//
// DELETE /api/me/watches/:id

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid watch id' })
    }

    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { error } = await (supabase as any)
      .from('market_watches')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return { ok: true }
  },
})
