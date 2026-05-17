/**
 * Public saved-search subscription create.
 *
 * POST /api/public/saved-searches
 *
 * Anonymous endpoint (no auth). Inserts a row in
 * `saved_search_subscriptions` via service-role and emails a
 * confirmation link to the subscriber.
 *
 * Request body (Zod):
 *   {
 *     email:    string (rfc-shaped),
 *     name?:    string (≤ 80 chars),
 *     filters:  object (whitelisted top-level keys, see ALLOWED_FILTER_KEYS),
 *     digest_frequency?: 'daily' | 'weekly'  (default 'weekly'),
 *     website?: string  (honeypot — must stay empty)
 *   }
 *
 * Response:
 *   201 → { id }       — sub created, confirmation email queued
 *   400 → invalid body shape
 *   422 → validation failed (Zod issues array)
 *   503 → SAVED_SEARCHES_DISABLED env kill-switch tripped
 *
 * The confirmation + unsubscribe tokens are NEVER returned to the
 * caller; they reach the user only via email. That keeps a hostile
 * client (or an XSS in a future site) from confirming or unsubscribing
 * subscriptions it didn't legitimately get an email for.
 *
 * The honeypot field `website` is a hidden form input; bots fill it,
 * humans don't. Honeypot positives return 201 with a fake id so abuse
 * signals don't leak through.
 */
import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { sendEmail } from '~~/server/utils/email'
import { logger } from '~~/server/utils/logger'
import { clientIp, enforceRateLimit } from '~~/server/utils/rate-limit'

// Rate limit: 5 subscription submissions per hour per client IP.
// Tighter than inquiries because each submission triggers an email
// send (Mailgun spend) and creates a row that has to be confirmed +
// later cleaned up. Spammers bulk-signing-up arbitrary emails would
// burn budget fast without this.
const SAVED_SEARCH_RATE_LIMIT_MAX    = 5
const SAVED_SEARCH_RATE_LIMIT_WINDOW = 60 * 60 // 1 hour

// Whitelist of top-level keys the website is allowed to ship in
// `filters`. Anything else gets stripped before insert. Mirrors the
// website's existing search-form shape.
const ALLOWED_FILTER_KEYS = new Set([
  'category',     // 'residential' | 'commercial'
  'for',          // 'buy' | 'rent'
  'minPrice',
  'maxPrice',
  'bedroomsMin',
  'bedroomsMax',
  'cityId',
  'barangayId',
  'propertyId',
  'path',         // canonical search-result-page slug
])

const FILTERS_MAX_BYTES = 4 * 1024 // 4 KB — generous; current shape ~200 B

const bodySchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'),
  name: z.string().trim().max(80).nullable().optional(),
  filters: z.record(z.unknown()).default({}),
  digest_frequency: z.enum(['daily', 'weekly']).default('weekly'),
  website: z.string().max(200).optional(), // honeypot
})

function buildConfirmationEmail(opts: {
  email: string
  name: string | null
  baseUrl: string
  confirmationToken: string
  unsubscribeToken: string
}): { subject: string; html: string } {
  const confirmHref = `${opts.baseUrl}/api/public/saved-searches/confirm/${encodeURIComponent(opts.confirmationToken)}`
  const unsubHref = `${opts.baseUrl}/api/public/saved-searches/unsubscribe/${encodeURIComponent(opts.unsubscribeToken)}`
  const label = opts.name ? `<strong>${escapeHtml(opts.name)}</strong>` : 'your saved search'
  const html = `
<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 12px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:18px;color:#111827">Confirm your saved search</h1>
          <p style="margin:0 0 12px">You asked us to send you new matches for ${label}.</p>
          <p style="margin:0 0 12px">Click the button below to confirm — we won't send you any digest emails until you do.</p>
          <p style="margin:24px 0 0">
            <a href="${confirmHref}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px">Confirm subscription</a>
          </p>
          <p style="margin:24px 0 0;font-size:11px;color:#9ca3af">If you didn't ask for this, you can safely ignore this email — without confirmation, no further messages will be sent. You can also <a href="${unsubHref}" style="color:#9ca3af">remove this subscription</a>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim()
  return {
    subject: 'Confirm your Housing Interactive saved search',
    html,
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Allowed cross-origin origins for the website's "save with email"
// flow. Comma-separated env var; matched as exact origins.
// Default: the production website + a localhost dev origin for testing.
const ALLOWED_ORIGINS = (
  process.env.SAVED_SEARCHES_ALLOWED_ORIGINS ||
  'https://housinginteractive.com.ph,http://localhost:3000,http://localhost:3001'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

function applyCors(event: Parameters<typeof getRequestHeader>[0]) {
  const origin = getRequestHeader(event, 'origin')
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    setHeader(event, 'Access-Control-Allow-Origin', origin)
    setHeader(event, 'Vary', 'Origin')
    setHeader(event, 'Access-Control-Allow-Methods', 'POST, OPTIONS')
    setHeader(event, 'Access-Control-Allow-Headers', 'content-type')
    setHeader(event, 'Access-Control-Max-Age', 600)
  }
}

export default defineEventHandler(async (event) => {
  // CORS preflight — browsers issue OPTIONS before cross-origin POST.
  // Respond 204 with the headers above; never reach the rate-limit
  // or kill-switch logic.
  if (event.node.req.method === 'OPTIONS') {
    applyCors(event)
    setResponseStatus(event, 204)
    return ''
  }
  applyCors(event)

  // Kill switch. Mirrors PUBLIC_INQUIRIES_DISABLED.
  if (
    String(process.env.SAVED_SEARCHES_DISABLED ?? '')
      .toLowerCase()
      .match(/^(1|true|yes)$/)
  ) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Saved searches temporarily disabled',
    })
  }

  // Rate limit before any expensive work. FAILS OPEN on RPC failure.
  try {
    const adminForLimit = getServerSupabaseAdmin()
    await enforceRateLimit({
      event,
      client: adminForLimit,
      key: `saved_searches:${clientIp(event)}`,
      max: SAVED_SEARCH_RATE_LIMIT_MAX,
      windowSeconds: SAVED_SEARCH_RATE_LIMIT_WINDOW,
    })
  } catch (err: any) {
    if (err?.statusCode === 429) throw err
    logger.warn(
      { err: err?.message, op: 'saved_searches.rate_limit' },
      'saved_search_rate_limit_init_failed',
    )
  }

  let body: z.infer<typeof bodySchema>
  try {
    const raw = await readBody(event)
    body = bodySchema.parse(raw ?? {})
  } catch (err: any) {
    if (err?.issues) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Validation failed',
        data: { issues: err.issues, step: 'validate' },
      })
    }
    throw createError({ statusCode: 400, statusMessage: 'Invalid request body' })
  }

  // Honeypot: silently accept and return a fake id. Bots think they
  // succeeded; we don't write anything. No abuse signal leaks.
  if (body.website && body.website.trim() !== '') {
    logger.info({ op: 'saved_searches.create.honeypot' }, 'saved_search_honeypot_hit')
    return { id: 'honeypot' }
  }

  // Strip filters to the whitelisted keys.
  const cleanFilters: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body.filters ?? {})) {
    if (ALLOWED_FILTER_KEYS.has(k)) cleanFilters[k] = v
  }
  // Cap byte size — defense against pathological JSON.
  const filtersJson = JSON.stringify(cleanFilters)
  if (filtersJson.length > FILTERS_MAX_BYTES) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Validation failed',
      data: { issues: [{ path: ['filters'], message: 'filters payload too large' }], step: 'validate' },
    })
  }

  const admin = getServerSupabaseAdmin()
  const { data, error } = await (admin as any)
    .from('saved_search_subscriptions')
    .insert({
      email: body.email,
      name: body.name?.trim() || null,
      filters: cleanFilters,
      digest_frequency: body.digest_frequency,
    })
    .select('id, confirmation_token, unsubscribe_token, name')
    .single()

  if (error) {
    logger.error(
      { err: error.message, op: 'saved_searches.create' },
      'saved_search_create_failed',
    )
    throw createError({
      statusCode: 500,
      statusMessage: 'Could not save subscription',
      data: { step: 'insert' },
    })
  }

  // Fire-and-forget confirmation email. sendEmail() doesn't throw on
  // Mailgun errors (logs + returns), so the user's POST still 201s
  // even if we can't deliver. Their row exists; admin can re-send.
  const baseUrl =
    process.env.PUBLIC_APP_URL ||
    (event.node.req.headers.origin as string | undefined) ||
    'https://app.housinginteractive.com.ph'

  const tpl = buildConfirmationEmail({
    email: body.email,
    name: data.name ?? body.name?.trim() ?? null,
    baseUrl,
    confirmationToken: data.confirmation_token,
    unsubscribeToken: data.unsubscribe_token,
  })

  // Fire-and-forget. Use .catch() not void — `void <promise>` leaves
  // any rejection as an unhandled rejection, which Nitro surfaces as
  // a noisy `[request error] [unhandled]` even though the row write
  // succeeded.
  sendEmail({ to: body.email, subject: tpl.subject, html: tpl.html }).catch((err: unknown) => {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        op: 'saved_searches.email',
        saved_search_id: data.id,
      },
      'saved_searches_confirmation_email_failed',
    )
  })

  setResponseStatus(event, 201)
  // Tokens are intentionally NOT in the response — they only reach
  // the user via the email. The id is enough for client-side
  // optimistic UI ("we emailed you, click the link").
  return { id: data.id }
})
