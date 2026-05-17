// /auth/callback is public because the user is mid-OAuth — they don't have
// a session yet when they land on it. The redirect-to-/dashboard branch
// also excludes it: if a session exists, the page itself navigates onward
// using ?next=, so we must not pre-empt that here.
//
// /shared/* is public-by-token: anyone with a valid share-link token can
// view the draft regardless of auth. The page itself fetches via the
// token-bound public endpoint.
//
// /invite/<token> is public because the recipient clicks the link from
// their email BEFORE creating their portal account. The page itself
// guides not-signed-in users through register/login and re-issues the
// accept request on return. Without this exemption, the invite token
// is lost when the middleware bounces to /login.
//
// /sign/<token> is public-by-token for external envelope recipients.
// They may not have a portal account; the token-bound API endpoints
// validate expiration/revocation and consume the token on completion.
const PUBLIC_ROUTES = new Set([
  '/login',
  '/register',
  '/forgot-password',
  '/auth/callback',
])

const PUBLIC_PREFIXES = [
  '/shared/',
  '/invite/',
  '/sign/',
]

export default defineNuxtRouteMiddleware((to) => {
  const user = useSupabaseUser()
  const isExactPublic = PUBLIC_ROUTES.has(to.path)
  const isPrefixPublic = PUBLIC_PREFIXES.some((p) => to.path.startsWith(p))
  const isPublic = isExactPublic || isPrefixPublic

  if (!user.value && !isPublic) return navigateTo('/login')
  // Don't redirect signed-in users away from shared pages — they may
  // legitimately want to preview what an external recipient sees.
  if (user.value && isExactPublic && to.path !== '/auth/callback') {
    return navigateTo('/dashboard')
  }
})
