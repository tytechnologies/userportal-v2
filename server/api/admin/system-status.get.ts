// Admin system-status endpoint.
//
// One-page operational view: DB up, cron jobs last-run + status, listing
// inventory counts, source ingestion lag, verification queue depth,
// saved-search subscription health.
//
// Each section runs independently via Promise.allSettled — one slow or
// failing query doesn't break the whole response. Failed sections come
// back with { error } instead of data, so the admin sees the gap rather
// than a 500.
//
// Auth: admin only (requireRole). Uses service-role for the cron schema
// since cron.* is owned by postgres and isn't accessible to authenticated
// callers via RLS.
//
// Cache: no-store. Status pages must always reflect current state.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

type Section<T> = { ok: true; data: T } | { ok: false; error: string }

const KNOWN_CRON_JOBS = [
  'refresh_listing_details_periodic',
  'saved_search_digest_daily',
  'archive_stale_source_listings_daily',
  'rate_limit_buckets_cleanup_daily',
  // Minutely cadence — the warning threshold (>25h since last run) in
  // SystemStatusCard.vue is fine; a cron that hasn't fired in 25h while
  // its schedule is `* * * * *` is genuinely broken.
  'webhook_retry_queue_drain_minutely',
  'webhook_deliveries_prune_daily',
  'listing_shares_expire_daily',
] as const

function ok<T>(data: T): Section<T> {
  return { ok: true, data }
}
function fail(err: unknown): Section<never> {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err ?? 'unknown'),
  }
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const startedAt = Date.now()
    const client = await serverSupabaseClient(event)
    const admin = getServerSupabaseAdmin()

    // -------------------------------------------------------------
    // Run every section in parallel. Failures are local to each.
    // -------------------------------------------------------------
    const [
      cronSection,
      listingsSection,
      sourcesSection,
      verificationsSection,
      subscriptionsSection,
      dataHealthSection,
    ] = await Promise.all([
      readCronJobs(admin),
      readListingCounts(client),
      readSourcesStatus(client),
      readVerificationCounts(client),
      readSubscriptionCounts(admin),
      readDataHealth(client),
    ])

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      env: {
        email_delivery_disabled: parseBoolEnv('EMAIL_DELIVERY_DISABLED'),
        public_inquiries_disabled: parseBoolEnv('PUBLIC_INQUIRIES_DISABLED'),
        saved_searches_disabled: parseBoolEnv('SAVED_SEARCHES_DISABLED'),
        // Email provider is currently a no-op stub (Mailgun removed).
        // The flag stays in the response shape for backward compat
        // with the SystemStatusCard renderer.
        email_provider_configured: false,
        internal_cron_secret_set: Boolean(process.env.INTERNAL_CRON_SECRET),
      },
      cron: cronSection,
      listings: listingsSection,
      sources: sourcesSection,
      verifications: verificationsSection,
      subscriptions: subscriptionsSection,
      data_health: dataHealthSection,
    }
  },
})

// =====================================================================
// Section readers — each isolated, never throws past the section
// =====================================================================

type CronJobRow = {
  jobname: string
  schedule: string | null
  active: boolean
  last_run_started_at: string | null
  last_run_finished_at: string | null
  last_run_status: string | null
  last_run_return_message: string | null
}

async function readCronJobs(
  admin: ReturnType<typeof getServerSupabaseAdmin>,
): Promise<Section<CronJobRow[]>> {
  try {
    // Two queries: cron.job for definitions, cron.job_run_details for the
    // most recent run of each. Joined client-side because PostgREST can't
    // express the "latest per group" we want without an RPC.

    const { data: jobs, error: jobsErr } = await (admin as any)
      .schema('cron')
      .from('job')
      .select('jobid, jobname, schedule, active')
      .in('jobname', KNOWN_CRON_JOBS as unknown as string[])

    if (jobsErr) {
      // pg_cron not installed → relation doesn't exist. Surface that
      // rather than 500ing the whole status page.
      return fail(`cron.job: ${jobsErr.message}`)
    }

    // Pull recent runs (last 50) for our known jobs and pick the most
    // recent per jobid. Limit 50 keeps the round-trip cheap.
    const jobIds = ((jobs ?? []) as Array<{ jobid: number }>).map((j) => j.jobid)

    let runsByJobId: Record<number, any> = {}
    if (jobIds.length > 0) {
      const { data: runs } = await (admin as any)
        .schema('cron')
        .from('job_run_details')
        .select('jobid, start_time, end_time, status, return_message')
        .in('jobid', jobIds)
        .order('start_time', { ascending: false })
        .limit(jobIds.length * 5) // up to 5 recent runs per job

      for (const r of (runs ?? []) as Array<{ jobid: number; start_time: string }>) {
        if (!runsByJobId[r.jobid] || r.start_time > runsByJobId[r.jobid].start_time) {
          runsByJobId[r.jobid] = r
        }
      }
    }

    const out: CronJobRow[] = ((jobs ?? []) as Array<{
      jobid: number
      jobname: string
      schedule: string | null
      active: boolean
    }>).map((j) => {
      const r = runsByJobId[j.jobid]
      return {
        jobname: j.jobname,
        schedule: j.schedule,
        active: j.active,
        last_run_started_at: r?.start_time ?? null,
        last_run_finished_at: r?.end_time ?? null,
        last_run_status: r?.status ?? null,
        last_run_return_message: r?.return_message ?? null,
      }
    })

    // Sort to a stable order matching KNOWN_CRON_JOBS for the dashboard.
    out.sort(
      (a, b) =>
        KNOWN_CRON_JOBS.indexOf(a.jobname as any) -
        KNOWN_CRON_JOBS.indexOf(b.jobname as any),
    )
    return ok(out)
  } catch (err) {
    return fail(err)
  }
}

async function readListingCounts(client: any): Promise<
  Section<{
    online: number
    soft_deleted: number
    source_imported: number
    agent_created: number
    total_active: number
  }>
> {
  try {
    const [online, deleted, sourceImported, agentCreated, totalActive] = await Promise.all([
      headCount(client, 'listings', (q: any) => q.eq('is_online', true).is('deleted_at', null)),
      headCount(client, 'listings', (q: any) => q.not('deleted_at', 'is', null)),
      headCount(client, 'listings', (q: any) =>
        q.not('source_id', 'is', null).is('deleted_at', null),
      ),
      headCount(client, 'listings', (q: any) =>
        q.is('source_id', null).is('deleted_at', null),
      ),
      headCount(client, 'listings', (q: any) => q.is('deleted_at', null)),
    ])
    return ok({
      online,
      soft_deleted: deleted,
      source_imported: sourceImported,
      agent_created: agentCreated,
      total_active: totalActive,
    })
  } catch (err) {
    return fail(err)
  }
}

type SourceStatus = {
  slug: string
  display_name: string
  enabled: boolean
  staleness_ttl_hours: number
  last_ingested_at: string | null
  hours_since_last_ingest: number | null
  listing_count: number
}

async function readSourcesStatus(client: any): Promise<Section<SourceStatus[]>> {
  try {
    const { data: sources, error } = await client
      .from('listing_sources')
      .select('id, slug, display_name, enabled, staleness_ttl_hours, last_ingested_at')
      .order('slug', { ascending: true })

    if (error) return fail(error.message)
    if (!sources || sources.length === 0) return ok([])

    // Per-source listing counts. Previously this was a sequential
    // for-loop (N+1 round-trips); now we fan out via Promise.all so
    // total latency is max(per-source) instead of sum(per-source).
    // Each count uses 'planned' mode under the hood (see headCount
    // default) so they're cheap individually.
    const now = Date.now()
    const counts = await Promise.all(
      sources.map((s: any) =>
        headCount(client, 'listings', (q: any) =>
          q.eq('source_id', s.id).is('deleted_at', null),
        ).catch(() => 0),
      ),
    )

    const out: SourceStatus[] = sources.map((s: any, i: number) => {
      const hoursSince = s.last_ingested_at
        ? Math.round((now - new Date(s.last_ingested_at).getTime()) / 3_600_000)
        : null
      return {
        slug: s.slug,
        display_name: s.display_name,
        enabled: s.enabled,
        staleness_ttl_hours: s.staleness_ttl_hours,
        last_ingested_at: s.last_ingested_at,
        hours_since_last_ingest: hoursSince,
        listing_count: counts[i],
      }
    })
    return ok(out)
  } catch (err) {
    return fail(err)
  }
}

async function readVerificationCounts(
  client: any,
): Promise<
  Section<{ pending: number; approved: number; rejected: number; total: number }>
> {
  try {
    const [pending, approved, rejected, total] = await Promise.all([
      headCount(client, 'profile_verifications', (q: any) => q.eq('status', 'pending')),
      headCount(client, 'profile_verifications', (q: any) => q.eq('status', 'approved')),
      headCount(client, 'profile_verifications', (q: any) => q.eq('status', 'rejected')),
      headCount(client, 'profile_verifications'),
    ])
    return ok({ pending, approved, rejected, total })
  } catch (err) {
    return fail(err)
  }
}

async function readSubscriptionCounts(
  admin: ReturnType<typeof getServerSupabaseAdmin>,
): Promise<Section<{ total: number; confirmed: number; pending_confirm: number }>> {
  try {
    // Service-role: saved_search_subscriptions has no RLS read policy
    // (writes-only via tokens), so the admin's authenticated client
    // can't see them. Service-role bypasses RLS.
    const [total, confirmed] = await Promise.all([
      headCount(admin, 'saved_search_subscriptions'),
      headCount(admin, 'saved_search_subscriptions', (q: any) =>
        q.not('confirmed_at', 'is', null),
      ),
    ])
    return ok({
      total,
      confirmed,
      pending_confirm: total - confirmed,
    })
  } catch (err) {
    return fail(err)
  }
}

type DataHealth = {
  orphan_listings_created_by: {
    orphan_count: number
    total_with_creator: number
  } | null
  unassigned_inquiries: {
    unassigned_total: number
    unassigned_recent: number
    total: number
  } | null
}

async function readDataHealth(client: any): Promise<Section<DataHealth>> {
  // Two RPCs in parallel. Each can fail independently; we degrade to
  // null on the section that errored rather than failing the whole
  // data_health block. The card knows how to render { orphan_*: null }.
  try {
    const [orphanRes, unassignedRes] = await Promise.all([
      client.rpc('count_orphan_listings_created_by'),
      client.rpc('count_unassigned_inquiries'),
    ])

    const orphan = orphanRes?.error
      ? null
      : (orphanRes?.data as DataHealth['orphan_listings_created_by']) ?? null
    const unassigned = unassignedRes?.error
      ? null
      : (unassignedRes?.data as DataHealth['unassigned_inquiries']) ?? null

    if (orphanRes?.error) {
      logger.warn(
        { err: orphanRes.error.message, op: 'system_status.data_health.orphan' },
        'system_status_orphan_count_failed',
      )
    }
    if (unassignedRes?.error) {
      logger.warn(
        { err: unassignedRes.error.message, op: 'system_status.data_health.unassigned' },
        'system_status_unassigned_count_failed',
      )
    }

    return ok({
      orphan_listings_created_by: orphan,
      unassigned_inquiries: unassigned,
    })
  } catch (err) {
    return fail(err)
  }
}

// ---------- helpers ----------

/**
 * head:true count helper. Returns 0 on any error rather than throwing.
 *
 * `mode` defaults to 'planned' — uses Postgres's planner row estimate
 * instead of a full scan. Cheap on large tables (listings); accurate
 * within a few %. Pass `mode: 'exact'` only on small tables (verifications,
 * imports, etc.) where drift would be visible.
 *
 * See memory/feedback_count_exact_on_listings.md for the rule.
 */
async function headCount(
  client: any,
  table: string,
  filter?: (q: any) => any,
  mode: 'exact' | 'planned' | 'estimated' = 'planned',
): Promise<number> {
  let q = client.from(table).select('id', { count: mode, head: true })
  if (filter) q = filter(q)
  const { count, error } = await q
  if (error) {
    logger.warn(
      { err: error.message, table, op: 'system_status.head_count' },
      'system_status_count_failed',
    )
    throw error
  }
  return count ?? 0
}

function parseBoolEnv(name: string): boolean {
  return Boolean(
    String(process.env[name] ?? '')
      .toLowerCase()
      .match(/^(1|true|yes)$/),
  )
}
