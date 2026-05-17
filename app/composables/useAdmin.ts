// Admin-panel data layer. Goes through useSupabaseClient() — every read
// and write is RLS-gated by the policies in 20260430000003_permissions_rbac.sql:
//
//   - profiles writes  → policy `profiles_admin_update` (has_permission('users.manage'))
//   - role_permissions → policy `role_permissions_admin_write` (current_user_role() = 'admin')
//   - permissions read → public to all authenticated users (so non-admins can
//     still see what permissions exist; mutating is admin-only)
//
// IMPORTANT: do NOT add a service-role client here. Even mistakenly. The
// admin UI relies on RLS to prevent a non-admin who guesses the route
// (or hits the RPC directly) from changing roles. A bypass client would
// undo that guarantee.

// Role lives in useAuth (single source of truth). Imported here only for
// internal use; callers that need the type should import from useAuth.
import type { Role } from '~/composables/useAuth'

export type AdminProfile = {
  id: string
  email: string | null
  full_name: string | null
  role: Role
  team_id: string | null
  avatar_url: string | null
  created_at: string | null
}

export type Permission = {
  name: string
  description: string
  category: string
}

export type RolePermission = {
  role: Role
  permission: string
}

const PROFILE_COLUMNS =
  'id, email, full_name, role, team_id, avatar_url, created_at'

function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'manager' || v === 'agent'
}

function asError(err: unknown, fallback: string): Error {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.length > 0) return new Error(msg)
  }
  return new Error(fallback)
}

export function useAdmin() {
  // ---- Users ------------------------------------------------------------

  async function listProfiles(opts: {
    /** Substring match on full_name OR email. */
    search?: string
    /** Filter to a single role; omit for all. */
    role?: Role | null
    limit?: number
  } = {}): Promise<AdminProfile[]> {
    const supabase = useSupabaseClient()
    const limit = opts.limit ?? 500

    let q = (supabase as any)
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (opts.role && isRole(opts.role)) {
      q = q.eq('role', opts.role)
    }
    if (opts.search && opts.search.trim() !== '') {
      const safe = opts.search.replace(/[%,()]/g, '').trim()
      q = q.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
    }

    const { data, error } = await q
    if (error) throw asError(error, 'Failed to load users')

    return (data ?? []).map((row: any) => ({
      id: row.id,
      email: row.email ?? null,
      full_name: row.full_name ?? null,
      role: isRole(row.role) ? row.role : 'agent',
      team_id: row.team_id ?? null,
      avatar_url: row.avatar_url ?? null,
      created_at: row.created_at ?? null,
    }))
  }

  async function updateProfileRole(id: string, role: Role): Promise<AdminProfile> {
    if (!isRole(role)) throw new Error(`Invalid role: ${role}`)
    if (!id) throw new Error('Missing user id')

    const supabase = useSupabaseClient()
    const { data, error } = await (supabase as any)
      .from('profiles')
      .update({ role })
      .eq('id', id)
      .select(PROFILE_COLUMNS)
      .maybeSingle()

    if (error) throw asError(error, 'Failed to update role')
    if (!data) {
      // RLS hid the row OR it doesn't exist. Don't differentiate.
      throw new Error('User not found or you cannot edit this user.')
    }
    return {
      id: data.id,
      email: data.email ?? null,
      full_name: data.full_name ?? null,
      role: isRole(data.role) ? data.role : 'agent',
      team_id: data.team_id ?? null,
      avatar_url: data.avatar_url ?? null,
      created_at: data.created_at ?? null,
    }
  }

  // ---- Permissions matrix ----------------------------------------------

  async function listPermissions(): Promise<Permission[]> {
    const supabase = useSupabaseClient()
    const { data, error } = await (supabase as any)
      .from('permissions')
      .select('name, description, category')
      .order('category', { ascending: true })
      .order('name', { ascending: true })

    if (error) throw asError(error, 'Failed to load permissions')
    return (data ?? []) as Permission[]
  }

  async function listRolePermissions(): Promise<RolePermission[]> {
    const supabase = useSupabaseClient()
    const { data, error } = await (supabase as any)
      .from('role_permissions')
      .select('role, permission')

    if (error) throw asError(error, 'Failed to load role permissions')
    return (data ?? [])
      .filter((row: any) => isRole(row.role))
      .map((row: any) => ({ role: row.role as Role, permission: row.permission }))
  }

  async function addRolePermission(role: Role, permission: string): Promise<void> {
    if (!isRole(role)) throw new Error(`Invalid role: ${role}`)
    if (!permission) throw new Error('Missing permission name')

    const supabase = useSupabaseClient()
    const { error } = await (supabase as any)
      .from('role_permissions')
      .insert({ role, permission })
    // Treat unique-constraint conflict as success — caller asked for the
    // row to exist, and it does. PostgREST surfaces this as code 23505.
    if (error && (error as any).code !== '23505') {
      throw asError(error, 'Failed to grant permission')
    }
  }

  async function removeRolePermission(role: Role, permission: string): Promise<void> {
    if (!isRole(role)) throw new Error(`Invalid role: ${role}`)
    if (!permission) throw new Error('Missing permission name')

    const supabase = useSupabaseClient()
    const { error } = await (supabase as any)
      .from('role_permissions')
      .delete()
      .eq('role', role)
      .eq('permission', permission)

    if (error) throw asError(error, 'Failed to revoke permission')
  }

  return {
    listProfiles,
    updateProfileRole,
    listPermissions,
    listRolePermissions,
    addRolePermission,
    removeRolePermission,
  }
}
