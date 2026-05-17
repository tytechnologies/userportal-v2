// Client-side compat shim for @nuxtjs/supabase v2.
//
// v2 of the module repopulates `useSupabaseUser()` via auth.getClaims()
// on every page:start and on every auth state change. JWT claims have
// the shape `{ sub, email, exp, role, ... }` — NOT the legacy
// supabase-js User shape `{ id, email, ... }`. The codebase reads
// `user.value.id` in ~80 client call sites (composables, services,
// pages), and a missing `.id` silently broke the role lookup:
//
//   useUserProfile() watches the user ref and compares
//   `next?.id !== prev?.id`. With claims both sides were undefined, so
//   the watcher never fired `fetchProfile()`, `useUserRole()` stuck on
//   its 'agent' default, and the sidebar's role-gated Administration
//   section disappeared for everyone.
//
// We mirror the server-side fix (server/utils/sbUser.ts) here by
// normalizing the user ref into the legacy shape: anytime the module
// writes a claims-shaped value, we re-write it with an `.id` alias
// pointing at `.sub`. This keeps every existing `user.value.id` reader
// working without rewriting them.

export default defineNuxtPlugin({
  name: 'supabase-user-shape-compat',
  setup() {
    const user = useSupabaseUser() as any

    function normalize(val: any) {
      if (!val) return val
      if (val.id) return val
      if (val.sub) return { ...val, id: val.sub }
      return val
    }

    const initial = normalize(user.value)
    if (initial !== user.value) user.value = initial

    watch(user, (val) => {
      const next = normalize(val)
      if (next !== val) user.value = next
    })
  },
})
