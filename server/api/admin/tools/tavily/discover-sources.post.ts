// Admin — Tavily: discover partner / MLS-style listing sources for a city.
//
// POST /api/admin/tools/tavily/discover-sources
// Body: { query: string, max_results?: number }
//
// Light wrapper: runs a Tavily search with a budget guard. Returns
// the raw results for the admin to triage. NOTHING is auto-added to
// listing_sources — that's an explicit follow-up action by the admin.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { isTavilyEnabled, tavilySearch, consumeTavilyBudget } from '~~/server/utils/tavily'

const DAILY_MAX = 50

const bodySchema = z.object({
  query:       z.string().trim().min(3).max(200),
  max_results: z.coerce.number().int().min(1).max(20).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')
    const b = body as z.infer<typeof bodySchema>

    if (!isTavilyEnabled()) {
      throw createError({
        statusCode: 503,
        statusMessage: 'Tavily not configured — set TAVILY_API_KEY env var',
      })
    }

    const supabase = await serverSupabaseClient(event)
    const allowed = await consumeTavilyBudget(supabase, 'discovery', DAILY_MAX)
    if (!allowed) {
      throw createError({
        statusCode: 429,
        statusMessage: `Daily Tavily discovery budget exhausted (${DAILY_MAX}/day). Try again tomorrow or raise the cap.`,
      })
    }

    try {
      const result = await tavilySearch({
        query:        b.query,
        max_results:  b.max_results ?? 5,
        search_depth: 'basic',
      })
      return {
        ok:      true,
        query:   b.query,
        answer:  result.answer ?? null,
        results: result.results ?? [],
      }
    } catch (err: any) {
      throw createError({ statusCode: 502, statusMessage: err?.message || 'tavily error' })
    }
  },
})
