import { getUserProfile } from '~~/server/utils/rbac'

// Returns the authenticated user's profile + role. The client uses this
// to bootstrap useUserRole() / can() without a second round-trip to
// fetch profiles after Supabase Auth resolves.
export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const profile = await getUserProfile(event)
    if (!profile) throw createError({ statusCode: 404, statusMessage: 'Profile not found' })
    return profile
  },
})
