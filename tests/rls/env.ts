// Env detection for the RLS test suite.
//
// These tests need a real Supabase project to run against — RLS is
// enforced inside Postgres, so a mocked client tells us nothing. We
// REQUIRE the explicit `SUPABASE_TEST_PROJECT=1` env flag to confirm
// the URL is a test/local project, NOT production. Without that flag
// the suite is silently skipped, which keeps CI green when secrets
// aren't provisioned.
//
// Required env when SUPABASE_TEST_PROJECT=1:
//   SUPABASE_URL                  — http://127.0.0.1:54321 for local
//   SUPABASE_ANON_KEY             — anon key (for signInWithPassword)
//   SUPABASE_SERVICE_ROLE_KEY     — service-role key (for setup/cleanup)
//
// Flag-gating PROTECTS against pointing the harness at the production
// project: the harness creates and deletes auth users + writes test
// rows. A misconfigured CI env should refuse to run, not nuke prod.

export type RlsEnv = {
  url: string
  anonKey: string
  serviceRoleKey: string
}

const FLAG = 'SUPABASE_TEST_PROJECT'

/**
 * Returns env config when the suite is allowed to run.
 * Returns null when the test should be SKIPPED (not an error).
 */
export function rlsEnvOrSkip(): RlsEnv | null {
  if (process.env[FLAG] !== '1') return null
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !anonKey || !serviceRoleKey) {
    // Flag is set but config is incomplete — that's a misconfiguration,
    // not a "no test env" condition. Throw so the operator notices.
    throw new Error(
      `${FLAG}=1 but SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not all set`,
    )
  }
  return { url, anonKey, serviceRoleKey }
}

export function isLikelyProductionUrl(url: string): boolean {
  // Crude defense: if the URL looks like a hosted Supabase project (the
  // *.supabase.co pattern), require a second env var to acknowledge it.
  // Local URLs (127.0.0.1, localhost, internal docker hostnames) skip
  // this guard.
  return /\.supabase\.co\b/i.test(url) && process.env.SUPABASE_TEST_PROJECT_HOSTED !== '1'
}
