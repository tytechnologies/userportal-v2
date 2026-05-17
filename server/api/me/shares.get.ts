// "Shared with me" inbox â€” listings the caller has been granted
// access to via listing_shares.
//
// GET /api/me/shares
// Auth: required. RLS scopes to the caller automatically.
//
// Powers the dashboard's "Collaborations" widget + the dedicated
// /shares inbox page. Includes the parent listing's display fields
// so the inbox can render without a per-row second fetch.

import { sharesRepo } from '~~/server/repositories/shares.repo'
import { serverSupabaseUser } from '../../utils/sbUser'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const data = await sharesRepo.listForRecipient({ event, userId: user.id })
    return { data }
  },
})
