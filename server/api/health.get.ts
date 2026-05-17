// Public health check.
//
// Used by AWS load balancers / uptime monitors / readiness probes to
// decide whether this Nuxt server should receive traffic. Should be
// cheap, fast, and deterministic.
//
// Status codes:
//   200 OK  — process up + Supabase reachable + log_activity-style
//             trivial query returns a row. Safe to send traffic here.
//   503     — DB unreachable or query timed out. Pull this instance
//             out of rotation; another may be healthy.
//
// Anonymous: no auth gate. Returns no sensitive data — just a
// timestamp and a coarse "db reachable" flag. Cache-Control: no-store
// so probes always get a fresh check; never let a CDN/cache shadow
// the real status.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const DB_PROBE_TIMEOUT_MS = 2000

export default defineEventHandler(async (event) => {
  const startedAt = Date.now()

  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')

  let db: 'reachable' | 'unreachable' = 'unreachable'
  let dbError: string | null = null

  try {
    const client = await serverSupabaseClient(event)

    // Tiny probe — read 1 row from a known-existing table. `cities` is
    // public-readable and unlikely to ever be empty (Phil. cities seed).
    // Wrapped in Promise.race so a hung connection times out cleanly
    // instead of blocking the probe and tripping a slow-drain alarm.
    const probe = (client as any)
      .from('cities')
      .select('id', { head: true, count: 'exact' })
      .limit(1)

    const result = await Promise.race([
      probe,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('db_probe_timeout')), DB_PROBE_TIMEOUT_MS),
      ),
    ])

    if ((result as any)?.error) {
      dbError = String((result as any).error.message || 'unknown')
    } else {
      db = 'reachable'
    }
  } catch (err: any) {
    dbError = err?.message || 'probe_threw'
  }

  const elapsedMs = Date.now() - startedAt

  if (db === 'unreachable') {
    setResponseStatus(event, 503)
    return {
      status: 'degraded',
      db,
      db_error: dbError,
      elapsed_ms: elapsedMs,
      timestamp: new Date().toISOString(),
    }
  }

  return {
    status: 'ok',
    db,
    elapsed_ms: elapsedMs,
    timestamp: new Date().toISOString(),
  }
})
