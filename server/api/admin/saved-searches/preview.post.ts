// Preview a saved-search digest — dry-run for what a subscriber WOULD
// receive on the next cron firing.
//
// POST /api/admin/saved-searches/preview
// Auth: admin.
//
// Body — exactly one mode:
//   { subscription_id: uuid }
//     → resolve filters/name/last_digest_sent_at/unsubscribe_token from
//       the existing row. Closest to "what does this subscriber see?"
//
//   { filters: object, name?: string, since?: ISO8601, frequency?:
//     'daily' | 'weekly' }
//     → ad-hoc preview. Operator-supplied filters; useful for testing
//       new filter shapes before building UI for them. `since` defaults
//       to 7 days ago when unset (mirrors the run-digest fallback for
//       a fresh subscription).
//
// Response:
//   {
//     mode: 'subscription' | 'ad_hoc',
//     since: ISO8601,
//     match_count: number,
//     matches: ListingMatch[],
//     subject: string,
//     html: string,
//     would_skip: boolean   // true when match_count === 0; the cron
//                           // increments `skipped` and sends nothing.
//   }
//
// Side effects: NONE. Doesn't stamp last_digest_sent_at, doesn't queue
// email, doesn't audit (dry-runs aren't real digests). Safe to call
// repeatedly.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import {
  loadMatchingListings,
  buildDigestEmail,
  digestBaseUrl,
} from '~~/server/utils/savedSearchDigest'

// Two mutually exclusive modes — Zod's discriminated union would force
// `kind: ...` discriminator strings on the caller, which is friction
// for a dry-run tool. Use a refine() instead.
const bodySchema = z
  .object({
    subscription_id: z.string().uuid().optional(),
    filters: z.record(z.unknown()).optional(),
    name: z.string().trim().max(160).optional(),
    since: z.string().datetime().optional(),
    frequency: z.enum(['daily', 'weekly']).optional(),
  })
  .refine(
    (b) => Boolean(b.subscription_id) !== Boolean(b.filters),
    { message: 'Provide exactly one of subscription_id OR filters' },
  )

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)
    const admin = getServerSupabaseAdmin()

    let mode: 'subscription' | 'ad_hoc'
    let filters: Record<string, unknown>
    let recipientName: string | null
    let unsubscribeToken: string
    let sinceIso: string

    if (body.subscription_id) {
      mode = 'subscription'
      // Service-role read: the subscription table is anon-write-only
      // (insert via tokenized confirm flow); admins read it via service-
      // role since the table has no SELECT policy for authenticated.
      const { data, error } = await (admin as any)
        .from('saved_search_subscriptions')
        .select(
          'id, name, filters, last_digest_sent_at, unsubscribe_token, digest_frequency',
        )
        .eq('id', body.subscription_id)
        .maybeSingle()
      if (error) {
        throw createError({ statusCode: 500, statusMessage: error.message })
      }
      if (!data) {
        throw createError({ statusCode: 404, statusMessage: 'Subscription not found' })
      }
      filters = (data.filters ?? {}) as Record<string, unknown>
      recipientName = data.name ?? null
      unsubscribeToken = data.unsubscribe_token
      // Match the run-digest fallback: 7 days for first-ever digest.
      sinceIso =
        data.last_digest_sent_at ?? new Date(Date.now() - SEVEN_DAYS_MS).toISOString()
    } else {
      mode = 'ad_hoc'
      filters = body.filters ?? {}
      recipientName = body.name ?? null
      // Fake unsubscribe token so the rendered HTML is structurally
      // identical to a real digest — the link is non-functional but
      // it's there for visual fidelity in the preview.
      unsubscribeToken = '__preview_token__'
      sinceIso = body.since ?? new Date(Date.now() - SEVEN_DAYS_MS).toISOString()
    }

    const matches = await loadMatchingListings(admin, filters, sinceIso)

    const baseUrl = digestBaseUrl()
    const tpl = buildDigestEmail({
      recipientName,
      matches,
      baseUrl,
      unsubscribeToken,
    })

    return {
      mode,
      since: sinceIso,
      match_count: matches.length,
      matches,
      subject: tpl.subject,
      html: tpl.html,
      would_skip: matches.length === 0,
    }
  },
})
