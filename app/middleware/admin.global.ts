// Global admin-section guard.
//
// Runs on every navigation. When the destination starts with `/admin/`
// (and isn't one of the few unauth-public admin-area carve-outs),
// checks `has_permission('admin.access')` and bounces non-admins to
// /dashboard with `?denied=admin` so the dashboard can render a toast.
//
// Why global with a path prefix (vs. per-page `middleware: 'admin'`):
//   - one place to gate every admin route (catalog grep `/admin/` to
//     audit, instead of grep `middleware:'admin'` across pages).
//   - new admin pages inherit the gate automatically — no risk of
//     forgetting to opt in.
//
// Server-side note:
//   Skipped during SSR because the supabase client isn't reliably
//   bound to the user JWT at render-time on tunnel-served deploys.
//   Server-side RLS + endpoint-level `has_permission` checks are the
//   actual security boundary — this middleware is a UX guard against
//   non-admins seeing the admin chrome. They couldn't write anything
//   anyway thanks to RLS.

const ADMIN_PATH_PREFIX = '/admin/'

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  if (!to.path.startsWith(ADMIN_PATH_PREFIX) && to.path !== '/admin') return

  const user = useSupabaseUser()
  // auth.global.ts already handles unauthenticated → /login. We only
  // run here when a user exists; double-check defensively anyway.
  if (!user.value) return

  const supabase = useSupabaseClient()
  let allowed = false
  try {
    const { data, error } = await (supabase as any).rpc('has_permission', {
      permission_to_check: 'admin.access',
    })
    if (!error) allowed = data === true
  } catch {
    allowed = false
  }

  if (!allowed) {
    return navigateTo({
      path: '/dashboard',
      query: { denied: 'admin' },
    })
  }
})
