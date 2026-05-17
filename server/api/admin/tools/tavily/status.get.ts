// Admin — Tavily configuration + budget status.
//
// GET /api/admin/tools/tavily/status

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { isTavilyEnabled } from '~~/server/utils/tavily'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const today = new Date().toISOString().slice(0, 10)

    const { data: buckets } = await (supabase as any)
      .from('rate_limit_buckets')
      .select('bucket_key, count, period_start')
      .like('bucket_key', `tavily.%.${today}`)

    const usage: Record<string, number> = {
      discovery:   0,
      enrichment:  0,
      dedup_hint:  0,
    }
    for (const row of buckets ?? []) {
      const m = String(row.bucket_key).match(/^tavily\.([a-z_]+)\./)
      if (m && m[1] in usage) usage[m[1]] = Number(row.count) || 0
    }

    return {
      enabled: isTavilyEnabled(),
      caps: { discovery: 50, enrichment: 100, dedup_hint: 200 },
      usage_today: usage,
    }
  },
})
