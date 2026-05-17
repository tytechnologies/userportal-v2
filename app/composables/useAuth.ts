import { computed, ref, type ComputedRef, type Ref } from 'vue'

// Phase-4 RBAC composable. Single source of truth on the client for:
//   - useAuthUser()  → Supabase auth user (re-export, keeps imports tidy)
//   - useUserRole()  → 'admin' | 'manager' | 'agent' (defaults to 'agent')
//   - can(action)    → boolean for UI gating only
//
// IMPORTANT — read this before relying on can() for anything sensitive:
// every check here is a UX hint. The server enforces permissions in two
// places that the user cannot bypass:
//   1. RLS policies on listings / activities (see migration
//      20260429000006_phase4_rbac_audit.sql)
//   2. Server endpoints that re-derive role from auth.uid()
//
// If you find yourself adding a `can(...)` gate WITHOUT a matching RLS
// policy or server check, the rule is: add the server check first, then
// the UI hint. Skipping the backend gate is the bug pattern Phase 4
// exists to eliminate.

export type Role = 'admin' | 'manager' | 'agent'

export type AuthProfile = {
  id: string
  role: Role
  team_id: string | null
  full_name: string | null
  email: string | null
  avatar_url: string | null
}

const ROLE_RANK: Record<Role, number> = { admin: 3, manager: 2, agent: 1 }

// Catalog of UI actions. Every key here MUST have a matching server-side
// guarantee (RLS or endpoint check). Adding a key without one is a bug.
export type Action =
  | 'create_listing'
  | 'edit_listing'           // edit own (agent) / team (manager) / any (admin)
  | 'edit_any_listing'       // edit listings owned by anyone (manager+)
  | 'archive_listing'        // archive own (agent) / team (manager) / any (admin)
  | 'archive_any_listing'    // archive any (manager+)
  | 'delete_listing'         // soft-delete own (agent+)
  | 'delete_any_listing'     // hard-delete any listing (admin only) — synonym of hard_delete_listing
  | 'hard_delete_listing'    // admin only
  | 'bulk_actions'           // any role can bulk-act on rows they own; manager+ can bulk on team
  | 'view_team_listings'     // manager+
  | 'view_all_listings'      // admin only
  | 'view_all_contacts'      // admin only
  | 'edit_any_contact'       // edit contacts owned by anyone (manager+)
  | 'delete_any_contact'     // delete any contact (admin only)
  | 'edit_featured_listings' // manage the team's featured-listings deck (manager+)
  | 'manage_users'           // admin only
  | 'manage_teams'           // admin only
  | 'view_audit_log'         // manager+ for own team, admin for everything

// Module-scoped cache — `useState` would also work but `ref` keeps this
// composable framework-agnostic and easy to mock in tests.
const profileRef: Ref<AuthProfile | null> = ref(null)
const isLoadingProfile = ref(false)
let inflight: Promise<AuthProfile | null> | null = null

/** Re-export of useSupabaseUser so callers have one auth import surface. */
export function useAuthUser() {
  return useSupabaseUser()
}

/** Lazily fetches /api/me and caches the result. Safe to call from many components. */
export function useUserProfile(): {
  profile: ComputedRef<AuthProfile | null>
  isLoading: Ref<boolean>
  refresh: () => Promise<void>
} {
  const user = useSupabaseUser()

  async function fetchProfile() {
    if (!user.value) {
      profileRef.value = null
      return
    }
    if (inflight) {
      await inflight
      return
    }
    isLoadingProfile.value = true
    // Cast through unknown — the $fetch generic signature triggers TS2589
    // (excessively deep instantiation) on Nitro's typed router union.
    inflight = ($fetch('/api/me') as unknown as Promise<AuthProfile>)
      .then((data: AuthProfile) => {
        profileRef.value = data
        return data
      })
      .catch((err) => {
        // 401 just means we raced auth — leave the profile null and
        // try again on the next user.value tick.
        console.error('[useAuth] failed to load profile:', err)
        profileRef.value = null
        return null
      })
      .finally(() => {
        isLoadingProfile.value = false
        inflight = null
      })
    await inflight
  }

  // Auto-fetch when the user appears or changes. watch is set up once per
  // call site but the cache + inflight guard prevent duplicate requests.
  if (typeof window !== 'undefined') {
    watch(
      user,
      (next, prev) => {
        if (next?.id !== prev?.id) {
          profileRef.value = null
          if (next) fetchProfile()
        }
      },
      { immediate: true },
    )
  }

  return {
    profile: computed(() => profileRef.value),
    isLoading: isLoadingProfile,
    refresh: fetchProfile,
  }
}

/**
 * Reactive role of the current user. Defaults to 'agent' when no profile
 * is loaded yet — least-privilege fallback matches the server.
 */
export function useUserRole(): ComputedRef<Role> {
  // Make sure the profile is being fetched.
  useUserProfile()
  return computed<Role>(() => profileRef.value?.role ?? 'agent')
}

function roleAllows(role: Role, action: Action): boolean {
  switch (action) {
    case 'create_listing':
      // Anyone authenticated can create a listing for themselves.
      return true
    case 'edit_listing':
    case 'archive_listing':
    case 'delete_listing':
    case 'bulk_actions':
      // Every role can act on rows they own; RLS keeps them honest.
      return true
    case 'edit_any_listing':
    case 'archive_any_listing':
    case 'view_team_listings':
    case 'view_audit_log':
    case 'edit_any_contact':
    case 'edit_featured_listings':
      return ROLE_RANK[role] >= ROLE_RANK['manager']
    case 'view_all_listings':
    case 'view_all_contacts':
    case 'delete_any_listing':
    case 'delete_any_contact':
    case 'hard_delete_listing':
    case 'manage_users':
    case 'manage_teams':
      return role === 'admin'
    default:
      return false
  }
}

/**
 * UI gate. Returns true if the current role MAY perform `action` on at
 * least some rows. Caller is still responsible for row-level checks
 * (e.g. "is this listing mine?") when the action is row-scoped — the
 * server enforces the row check via RLS.
 */
export function can(action: Action): boolean {
  const role = profileRef.value?.role ?? 'agent'
  return roleAllows(role, action)
}

/** Reactive variant for templates: `:disabled="!canRef('archive_any_listing')"` */
export function canRef(action: Action): ComputedRef<boolean> {
  return computed(() => can(action))
}

/** Returns true iff the current user owns the given listing row. */
export function ownsListing(listing: { created_by?: string | null } | null | undefined): boolean {
  const user = useSupabaseUser()
  return !!user.value?.id && !!listing?.created_by && listing.created_by === user.value.id
}

// =====================================================================
// Permission-layer helpers (post-20260430000003 migration)
// =====================================================================
//
// `can(action)` above is the role-based UX shortcut for known actions.
// `hasPermission(name)` is the dynamic check that hits the database via
// the SECURITY DEFINER `has_permission()` RPC. Use this when:
//   - The permission name is configured in role_permissions (the admin
//     UI lets non-engineers re-bind it) and not hard-coded as an Action.
//   - You need the live result, not a synchronous boolean.
//
// Result is cached per name for the lifetime of the page; refresh
// permissionCache via clearPermissionCache() after an admin mutates
// role_permissions so the UI reflects the new state immediately.

const permissionCache = new Map<string, boolean>()
const permissionInflight = new Map<string, Promise<boolean>>()

/** Async permission check via the has_permission(text) RPC. Cached. */
export async function hasPermission(name: string): Promise<boolean> {
  if (permissionCache.has(name)) return permissionCache.get(name)!
  if (permissionInflight.has(name)) return permissionInflight.get(name)!

  const supabase = useSupabaseClient()
  const promise = (async () => {
    const { data, error } = await (supabase as any).rpc('has_permission', {
      permission_to_check: name,
    })
    if (error) {
      console.error('[useAuth] has_permission RPC failed:', error.message ?? error)
      return false
    }
    const allowed = data === true
    permissionCache.set(name, allowed)
    return allowed
  })()
  permissionInflight.set(name, promise)
  try {
    return await promise
  } finally {
    permissionInflight.delete(name)
  }
}

/** Drop the cache. Call after the admin UI mutates role_permissions or after sign-in/out. */
export function clearPermissionCache() {
  permissionCache.clear()
  permissionInflight.clear()
}
