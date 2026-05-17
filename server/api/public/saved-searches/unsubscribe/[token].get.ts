/**
 * Saved-search unsubscribe handler.
 *
 * GET /api/public/saved-searches/unsubscribe/<token>
 *
 * Hit from the unsubscribe link in confirmation + digest emails.
 * Hard-deletes the subscription row. Idempotent: re-clicks land on
 * the same "removed" page.
 *
 * Token is `unsubscribe_token` from saved_search_subscriptions —
 * different from the confirmation token. UNIQUE-indexed.
 */
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'

const TOKEN_RE = /^[0-9a-f]{32,128}$/i

function htmlPage(opts: { title: string; body: string }) {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${opts.title}</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7fa;color:#1f2937}
    .wrap{max-width:560px;margin:80px auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:12px}
    h1{margin:0 0 12px;font-size:20px;color:#111827}
    p{margin:0 0 12px;line-height:1.5}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${opts.title}</h1>
    ${opts.body}
  </div>
</body></html>`
}

export default defineEventHandler(async (event) => {
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  setHeader(event, 'cache-control', 'private, no-store')

  const token = getRouterParam(event, 'token')

  if (!token || !TOKEN_RE.test(token)) {
    setResponseStatus(event, 404)
    return htmlPage({
      title: 'Link not recognized',
      body: '<p>That unsubscribe link doesn\'t look right.</p>',
    })
  }

  const admin = getServerSupabaseAdmin()

  // count is a hint that lets us tell "unsubscribed just now" from
  // "already unsubscribed earlier" without an extra round trip.
  const { error, count } = await (admin as any)
    .from('saved_search_subscriptions')
    .delete({ count: 'exact' })
    .eq('unsubscribe_token', token)

  if (error) {
    logger.error(
      { err: error.message, op: 'saved_searches.unsubscribe' },
      'saved_search_unsubscribe_failed',
    )
    setResponseStatus(event, 500)
    return htmlPage({
      title: 'Something went wrong',
      body: '<p>We couldn\'t remove your subscription right now. Please try clicking the link again in a few minutes.</p>',
    })
  }

  if (count && count > 0) {
    return htmlPage({
      title: 'You\'ve been unsubscribed',
      body:
        '<p>You won\'t receive any more digest emails for this saved search.</p>' +
        '<p>You can save a new search any time from <a href="https://housinginteractive.com.ph">housinginteractive.com.ph</a>.</p>',
    })
  }

  // Already gone — re-click after a successful unsubscribe.
  return htmlPage({
    title: 'Already unsubscribed',
    body: '<p>This subscription was already removed. You won\'t receive any more digest emails.</p>',
  })
})
