// POST /api/admin/ops/cron-jobs/trigger
// Body: { worker_key: string, batch_size?: number }
//
// Server-side proxy: forwards an admin's "run now" click to the
// worker's internal endpoint with the bearer secret. The secret
// stays in the API server's env and never enters the browser.
//
// Only HTTP-runner workers can be triggered this way. pg_cron
// workers are scheduled inside Postgres and don't have a runnable
// HTTP entrypoint — for those we surface a SQL snippet the
// operator can paste into the SQL editor.
//
// Rate limit: ad-hoc — admin-only, low risk of abuse, and the
// worker endpoint itself is idempotent (it claims work, runs,
// returns).

import { z } from 'zod'
import { logger } from '~~/server/utils/logger'
import { requireRole } from '~~/server/utils/rbac'

const HTTP_WORKERS: Record<
  string,
  { endpoint: string; secret_env: string }
> = {
  email_worker_tick: {
    endpoint: '/api/internal/email-worker-tick',
    secret_env: 'EMAIL_WORKER_SECRET',
  },
  ai_suggestion_worker_tick: {
    endpoint: '/api/internal/ai-suggestion-worker-tick',
    secret_env: 'AI_WORKER_SECRET',
  },
  eis_submitter_tick: {
    endpoint: '/api/internal/eis-submitter-tick',
    secret_env: 'EIS_WORKER_SECRET',
  },
}

const bodySchema = z.object({
  worker_key: z.string().min(1).max(64),
  batch_size: z.number().int().min(1).max(200).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    const config = HTTP_WORKERS[body.worker_key]
    if (!config) {
      throw createError({
        statusCode: 400,
        statusMessage: `worker_key "${body.worker_key}" is not a triggerable HTTP worker`,
      })
    }
    const secret = process.env[config.secret_env]
    if (!secret) {
      throw createError({
        statusCode: 503,
        statusMessage: `${config.secret_env} not configured on this server`,
      })
    }

    // Resolve absolute URL for the internal endpoint. fetch() against
    // a relative path works in Nitro but only via H3's local mount;
    // we prefer building the absolute URL from the request to keep
    // the proxy explicit.
    const proto =
      getRequestHeader(event, 'x-forwarded-proto') ||
      (process.env.NODE_ENV === 'production' ? 'https' : 'http')
    const host = getRequestHeader(event, 'host') || 'localhost:3000'
    const url = `${proto}://${host}${config.endpoint}`

    const startedAt = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(
          body.batch_size ? { batch_size: body.batch_size } : {},
        ),
      })
      const text = await res.text().catch(() => '')
      let parsed: any = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      if (!res.ok) {
        throw createError({
          statusCode: res.status,
          statusMessage: `worker returned ${res.status}: ${text.slice(0, 300)}`,
        })
      }
      return {
        ok: true,
        worker_key: body.worker_key,
        elapsed_ms: Date.now() - startedAt,
        result: parsed,
      }
    } catch (err: any) {
      logger.warn(
        {
          err: err?.message,
          worker_key: body.worker_key,
          op: 'cron-trigger',
        },
        'cron_trigger_failed',
      )
      if (err?.statusCode) throw err
      throw createError({
        statusCode: 502,
        statusMessage: err?.message ?? 'worker unreachable',
      })
    }
  },
})
