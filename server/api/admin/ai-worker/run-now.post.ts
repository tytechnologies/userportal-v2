// Admin: trigger the AI suggestion worker on demand.
//
// POST /api/admin/ai-worker/run-now
// Body: { batch_size?: number, kinds?: string[] }
//
// Forwards to the internal worker tick (which holds the actual
// candidate-finder + LLM-completion logic) using the
// AI_WORKER_SECRET. Lets operators run the worker manually instead
// of waiting for the cron.
//
// 503 if AI_WORKER_SECRET is unset (matches the internal endpoint's
// behavior). The worker itself degrades gracefully when no AI
// provider is configured (writes a "noop" placeholder suggestion).

import { z } from 'zod'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  batch_size: z.number().int().min(1).max(50).optional(),
  kinds: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const secret = process.env.AI_WORKER_SECRET
    if (!secret) {
      throw createError({
        statusCode: 503,
        statusMessage: 'AI_WORKER_SECRET not configured. Set it in env to enable manual triggers.',
      })
    }

    // Build absolute URL to our own internal endpoint. Prefer
    // PUBLIC_APP_URL when set; otherwise reconstruct from the inbound
    // request so dev (localhost) and prod both resolve correctly.
    const reqUrl = getRequestURL(event)
    const base = (
      process.env.PUBLIC_APP_URL ??
      process.env.INTERNAL_PORTAL_URL ??
      `${reqUrl.protocol}//${reqUrl.host}`
    ).replace(/\/$/, '')

    const upstreamUrl = `${base}/api/internal/ai-suggestion-worker-tick`

    let result: { ok: boolean; stats: Record<string, { candidates: number; written: number; failed: number }> }
    try {
      result = await $fetch(upstreamUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        body: {
          batch_size: body.batch_size,
          kinds: body.kinds,
        },
      })
    } catch (err: any) {
      logger.error(
        { err: err?.message, op: 'admin.ai_worker.run_now' },
        'ai_worker_run_now_failed',
      )
      throw createError({
        statusCode: 502,
        statusMessage: `Worker tick failed: ${err?.message ?? 'unknown'}`,
      })
    }

    const totalWritten = Object.values(result.stats ?? {}).reduce(
      (sum, s) => sum + (s.written ?? 0),
      0,
    )

    await logActivity({
      event,
      action: 'ai_worker.run_now',
      entity: 'ai_worker' as any,
      metadata: {
        triggered: 'manual',
        batch_size: body.batch_size,
        kinds: body.kinds,
        total_written: totalWritten,
        stats: result.stats,
      },
    })

    return {
      ok: result.ok,
      total_written: totalWritten,
      stats: result.stats,
    }
  },
})
