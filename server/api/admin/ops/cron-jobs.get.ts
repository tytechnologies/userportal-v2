// GET /api/admin/ops/cron-jobs
//
// Returns the worker registry: each documented internal worker plus
// its last heartbeat (from public.ops_worker_status), the email/AI
// queue depth, and the env-var/cron-cadence metadata an operator
// needs to set up the cron-runner.
//
// Auth: admin.access (RLS on ops_worker_heartbeats already enforces).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

type StatusRow = {
  worker_key: string
  label: string
  expected_interval_seconds: number
  last_recorded_at: string | null
  runs_last_hour: number | null
  runs_last_day: number | null
  last_payload: Record<string, unknown> | null
  health: 'healthy' | 'slow' | 'overdue' | 'never_seen'
}

// Static metadata that doesn't live in the DB — operator runbook info
// (env vars, recommended cron cadence, kind of host).
const WORKER_META: Record<
  string,
  {
    endpoint: string | null
    schedule_hint: string
    auth_env: string | null
    description: string
    runner_kind: 'http_endpoint' | 'pg_cron'
  }
> = {
  email_worker_tick: {
    endpoint: '/api/internal/email-worker-tick',
    schedule_hint: 'every 1–5 minutes',
    auth_env: 'EMAIL_WORKER_SECRET',
    description: 'Drains outbound_emails queue via Resend.',
    runner_kind: 'http_endpoint',
  },
  ai_suggestion_worker_tick: {
    endpoint: '/api/internal/ai-suggestion-worker-tick',
    schedule_hint: 'every 5–30 minutes',
    auth_env: 'AI_WORKER_SECRET',
    description: 'Generates pending ai_suggestions rows from documented sources.',
    runner_kind: 'http_endpoint',
  },
  eis_submitter_tick: {
    endpoint: '/api/internal/eis-submitter-tick',
    schedule_hint: 'every 5–15 minutes',
    auth_env: 'EIS_WORKER_SECRET',
    description:
      'Drains queued eis_submissions to BIR EIS. Noops when EIS_PROVIDER_URL unset. Runbook: docs/eis-submitter-runbook.md',
    runner_kind: 'http_endpoint',
  },
  charge_due_reminders: {
    endpoint: null,
    schedule_hint: 'daily 09:00 UTC (pg_cron wrapper)',
    auth_env: null,
    description: 'Enqueues charge.due_soon emails for property charges.',
    runner_kind: 'pg_cron',
  },
  platform_fee_settlement: {
    endpoint: null,
    schedule_hint: 'monthly day 1 02:00 UTC (pg_cron wrapper)',
    auth_env: null,
    description: 'Settles platform commission for the previous month per broker.',
    runner_kind: 'pg_cron',
  },
}

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    const client = await serverSupabaseClient(event)

    // Heartbeat status view.
    const { data: rows, error: statusErr } = await (client as any)
      .from('ops_worker_status')
      .select(
        'worker_key, label, expected_interval_seconds, last_recorded_at, ' +
          'runs_last_hour, runs_last_day, last_payload, health',
      )
      .order('worker_key', { ascending: true })
    if (statusErr) {
      throw createError({ statusCode: 500, statusMessage: statusErr.message })
    }

    // Queue depth — pending outbound emails + pending ai_suggestions.
    // These are read separately so a heartbeat-view failure doesn't
    // hide queue depth and vice versa.
    const [{ data: emailQueue, error: eqErr }, { data: aiQueue, error: aqErr }] =
      await Promise.all([
        (client as any)
          .from('outbound_emails')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        (client as any)
          .from('ai_suggestions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
      ])

    const items = (rows ?? []).map((r: StatusRow) => ({
      ...r,
      meta: WORKER_META[r.worker_key] ?? {
        endpoint: null,
        schedule_hint: '(undocumented)',
        auth_env: null,
        description: '',
        runner_kind: 'pg_cron',
      },
    }))

    return {
      items,
      queues: {
        outbound_emails_pending: eqErr ? null : (emailQueue as any)?.count ?? 0,
        ai_suggestions_pending: aqErr ? null : (aiQueue as any)?.count ?? 0,
      },
    }
  },
})
