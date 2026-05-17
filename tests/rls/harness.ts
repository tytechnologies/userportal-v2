// Test harness for RLS suites.
//
// What this gives test files:
//
//   const env = rlsEnvOrSkip()
//   const ctx = await setupRlsContext(env, { runId: 'webhooks_001' })
//   const adminClient = await ctx.signInAs('admin')
//   const agentClient = await ctx.signInAs('agent_a')
//   ...assertions...
//   await ctx.cleanup()
//
// Each "run" gets a unique runId so parallel test files / re-runs
// don't step on each other's users. Created profiles are tagged with
// the runId in `profiles.full_name` so cleanup can find them by
// pattern even if a test crashed without calling cleanup() last time.
//
// User creation uses Supabase's auth admin API (service role required),
// then we upsert a `profiles` row with the right `role` so RLS
// policies that depend on `current_user_role()` resolve correctly.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isLikelyProductionUrl, type RlsEnv } from './env'

export type Role = 'admin' | 'manager' | 'agent_a' | 'agent_b'

export type TestUser = {
  id: string
  email: string
  password: string
  role: Role
}

export type RlsContext = {
  serviceClient: SupabaseClient
  users: Record<Role, TestUser>
  runId: string
  /** Returns a Supabase client authenticated as the named role. */
  signInAs: (role: Role) => Promise<SupabaseClient>
  cleanup: () => Promise<void>
}

const ROLE_TO_DB_ROLE: Record<Role, 'admin' | 'manager' | 'agent'> = {
  admin: 'admin',
  manager: 'manager',
  agent_a: 'agent',
  agent_b: 'agent',
}

function buildEmail(runId: string, role: Role): string {
  return `rls+${runId}+${role}@example.test`
}

export async function setupRlsContext(
  env: RlsEnv,
  opts: { runId: string },
): Promise<RlsContext> {
  if (isLikelyProductionUrl(env.url)) {
    throw new Error(
      `Refusing to run RLS test setup against ${env.url} — looks like a hosted Supabase project. ` +
      `Set SUPABASE_TEST_PROJECT_HOSTED=1 to override (use ONLY against a non-prod project).`,
    )
  }

  const serviceClient = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const password = `RlsHarness_${opts.runId}_xLKp`
  const users = {} as Record<Role, TestUser>

  // Create one auth user per role. createUser is idempotent in spirit
  // (a follow-up call with the same email returns 422); we treat that
  // as recoverable by looking up the user by email.
  for (const role of Object.keys(ROLE_TO_DB_ROLE) as Role[]) {
    const email = buildEmail(opts.runId, role)
    let userId: string

    // Try create first.
    const { data: created, error: createErr } = await serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { rls_test_run_id: opts.runId, rls_test_role: role },
    })

    if (createErr || !created?.user) {
      // Treat "already exists" as recoverable — find the user by email
      // via listUsers (paginated; one page is enough for test scopes).
      const { data: list } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const existing = list?.users?.find((u) => u.email === email)
      if (!existing) {
        throw new Error(
          `Failed to create or find test user ${email}: ${createErr?.message || 'unknown'}`,
        )
      }
      userId = existing.id
    } else {
      userId = created.user.id
    }

    // Upsert the matching profile row + role. The `profiles` table is
    // typically auto-populated via a trigger on auth.users insert (per
    // 20260429000006_phase4_rbac_audit.sql), but we don't depend on
    // that — explicit UPSERT keeps the test deterministic.
    const { error: profileErr } = await (serviceClient as any)
      .from('profiles')
      .upsert(
        {
          id: userId,
          email,
          full_name: `RLS Test ${role} (${opts.runId})`,
          role: ROLE_TO_DB_ROLE[role],
        },
        { onConflict: 'id' },
      )
    if (profileErr) {
      throw new Error(`Failed to upsert profile for ${email}: ${profileErr.message}`)
    }

    users[role] = { id: userId, email, password, role }
  }

  async function signInAs(role: Role): Promise<SupabaseClient> {
    const u = users[role]
    if (!u) throw new Error(`Unknown role: ${role}`)
    const c = createClient(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await c.auth.signInWithPassword({
      email: u.email,
      password: u.password,
    })
    if (error) throw new Error(`signIn(${role}) failed: ${error.message}`)
    return c
  }

  async function cleanup() {
    for (const u of Object.values(users)) {
      // Best-effort. A dangling profile row blocks future runs of the
      // same runId; auth.admin.deleteUser cascades to profiles via the
      // FK ON DELETE.
      await serviceClient.auth.admin.deleteUser(u.id).catch(() => undefined)
    }
  }

  return { serviceClient, users, runId: opts.runId, signInAs, cleanup }
}

/**
 * Convenience: wraps a Supabase query that's expected to return zero
 * rows due to RLS (PostgREST returns `{ data: [], error: null }`).
 * Throws with a clear message if rows leaked.
 */
export async function expectNoRows(
  promise: Promise<{ data: any; error: any }>,
  context: string,
): Promise<void> {
  const { data, error } = await promise
  if (error) throw new Error(`${context} — query errored: ${error.message}`)
  if (Array.isArray(data) && data.length > 0) {
    throw new Error(`${context} — expected 0 rows, got ${data.length}`)
  }
}

/**
 * Wraps a write query that's expected to fail under RLS. Supabase
 * surfaces RLS denials as `error.code === '42501'` (insufficient
 * privilege) OR a 403 PostgREST status when the WITH CHECK fails.
 */
export async function expectRlsDenied(
  promise: Promise<{ data: any; error: any }>,
  context: string,
): Promise<void> {
  const { error } = await promise
  if (!error) {
    throw new Error(`${context} — expected RLS denial, got success`)
  }
  // Accept any of the known denial signals. Different write paths
  // surface different codes (42501 from policy, PGRST116 when the row
  // doesn't pass a USING filter on UPDATE, etc.).
  const knownDenials = ['42501', 'PGRST116', 'PGRST301']
  const code = (error.code || error.statusCode || '').toString()
  const msg = (error.message || '').toLowerCase()
  const looksLikeRls =
    knownDenials.includes(code) ||
    msg.includes('row-level security') ||
    msg.includes('row level security') ||
    msg.includes('permission denied')
  if (!looksLikeRls) {
    throw new Error(
      `${context} — error didn't look like an RLS denial (code=${code}, msg="${error.message}")`,
    )
  }
}
