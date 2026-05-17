// Public inquiry submission endpoint.
//
// Anon-writable: the public website (housinginteractive.com.ph) POSTs
// here when a visitor clicks "Inquire" on a listing detail page. The
// request bypasses the inquiries table's RLS via service-role, but
// only this endpoint has that key — the table itself has no INSERT
// policy for anon, so direct writes against PostgREST are blocked.
//
// Validation:
//   - listing_id must reference an existing, online, non-deleted row.
//   - Either email or phone must be present so the agent can reply.
//   - Message length capped at the schema CHECK (5000) and again here.
//   - Honeypot field `website` must be empty (basic bot trap).
//
// On success: insert + fanout notification to listing.created_by, return
// { id }. On failure, the response carries a `step` field so the
// website can grep portal logs by the same identifier — every error
// path logs with that exact step value.

import { z } from 'zod'
import { defineEventHandler, createError, readBody, setResponseStatus, getRequestIP } from 'h3'
import { ZodError } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'
import { notify } from '~~/server/utils/notifications'
import { clientIp, enforceRateLimit } from '~~/server/utils/rate-limit'
import { dispatchWebhook } from '~~/server/utils/webhooks'

// Rate limit: 10 inquiries per hour per client IP. Generous for
// individual users (most send 0–2 inquiries per session); aggressive
// against spam bots that POST in bursts. Tunable here without a
// migration.
const INQUIRY_RATE_LIMIT_MAX     = 10
const INQUIRY_RATE_LIMIT_WINDOW  = 60 * 60 // seconds = 1 hour

const bodySchema = z.object({
  listing_id: z.number().int().positive(),
  sender_name: z.string().min(1).max(200),
  sender_email: z.string().email().max(320).optional().nullable(),
  sender_phone: z.string().min(4).max(40).optional().nullable(),
  message: z.string().min(1).max(5000),
  /** Honeypot — should be empty. Bots typically fill every field. */
  website: z.string().max(0).optional(),
  /** Where the inquiry came from. Defaults to 'website'. */
  source: z.string().max(40).optional(),
}).refine(
  (b) => !!(b.sender_email || b.sender_phone),
  { message: 'Either email or phone is required.', path: ['sender_email'] },
)

// Single source of truth for step identifiers. The website agent greps
// portal logs by these values to triage 500s without seeing the body.
type Step =
  | 'admin_client_init'
  | 'listing_preflight'
  | 'listing_not_found'
  | 'inquiries_insert'
  | 'notify_fanout'

function fail(step: Step, statusCode: number, statusMessage: string, err?: unknown) {
  logger.error(
    {
      step,
      err: err instanceof Error ? err.message : String(err ?? ''),
      stack: err instanceof Error ? err.stack : undefined,
    },
    'public_inquiries_failed',
  )
  throw createError({
    statusCode,
    statusMessage,
    // Surface the step to the caller so the website can pair their
    // submission with the matching portal log line.
    data: { step },
  })
}

export default defineEventHandler(async (event) => {
  // Kill switch — set PUBLIC_INQUIRIES_DISABLED=1 in the deploy env to
  // turn the public submission off cleanly while the underlying 500
  // issue is being diagnosed. Returns 503 so the website's edge can
  // surface a "temporarily unavailable" toast instead of the opaque
  // 500 the broken upstream was emitting.
  const config = useRuntimeConfig()
  const disabled =
    String((config as any).PUBLIC_INQUIRIES_DISABLED ?? process.env.PUBLIC_INQUIRIES_DISABLED ?? '')
      .toLowerCase()
      .match(/^(1|true|yes)$/)
  if (disabled) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Inquiries are temporarily disabled.',
      data: { step: 'feature_flag_disabled' },
    })
  }

  // Rate limit BEFORE body parse. Bots that hammer the endpoint pay
  // a cheap RPC call instead of Zod-validating their payload first.
  // FAILS OPEN if the RPC errors — we'd rather over-serve than DOS
  // ourselves with a flaky limiter. Uses the service-role admin
  // client so the RPC is reachable regardless of caller auth (this
  // endpoint is anonymous).
  try {
    const adminForLimit = getServerSupabaseAdmin()
    await enforceRateLimit({
      event,
      client: adminForLimit,
      key: `inquiries:${clientIp(event)}`,
      max: INQUIRY_RATE_LIMIT_MAX,
      windowSeconds: INQUIRY_RATE_LIMIT_WINDOW,
    })
  } catch (err: any) {
    if (err?.statusCode === 429) throw err
    // Service-role init failure here would also break the actual
    // endpoint a few lines later — let it through; the next code
    // path will fail more informatively.
    logger.warn(
      { err: err?.message, op: 'inquiries.rate_limit' },
      'inquiry_rate_limit_init_failed',
    )
  }

  // Anon endpoint — no auth check. Body validation is the security
  // boundary, plus the listing-existence preflight below.
  let body: z.infer<typeof bodySchema>
  try {
    const raw = await readBody(event)
    body = bodySchema.parse(raw)
  } catch (err) {
    if (err instanceof ZodError) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Validation failed',
        data: { issues: err.issues },
      })
    }
    throw err
  }

  // Honeypot tripped — pretend we accepted to not give bots a signal.
  if (body.website && body.website.length > 0) {
    setResponseStatus(event, 201)
    return { id: 'honeypot' }
  }

  // 1. Service-role client — fast-fail if SUPABASE_SERVICE_ROLE_KEY is
  // not configured in the deploy env.
  let admin
  try {
    admin = getServerSupabaseAdmin()
  } catch (err) {
    return fail('admin_client_init', 500, 'Service role client not configured', err)
  }

  // 2. Listing preflight: confirm the listing is real, online, not
  // soft-deleted, and capture the assigned agent.
  const { data: listing, error: listingError } = await (admin as any)
    .from('listings')
    .select('id, title, created_by, is_online, deleted_at')
    .eq('id', body.listing_id)
    .maybeSingle()

  if (listingError) {
    return fail('listing_preflight', 500, 'Listing preflight failed', listingError)
  }
  if (!listing || !listing.is_online || listing.deleted_at) {
    return fail('listing_not_found', 404, 'Listing not found')
  }

  // 2.5. Verify the listing's owner UUID actually has a profile row
  // before we use it as inquiries.assigned_user_id. The FK is
  //   inquiries.assigned_user_id REFERENCES profiles(id) ON DELETE SET NULL
  // so an orphan UUID (legacy data, deleted user, listing imported
  // from a feed where created_by points at no real profile) would
  // produce a 23503 foreign_key_violation and 500 the entire
  // submission. Defensively NULL the assignment instead — inquiry
  // still lands in the queue, manager / admin routes it manually.
  let assignedUserId: string | null = listing.created_by ?? null
  if (assignedUserId) {
    const { data: profileExists } = await (admin as any)
      .from('profiles')
      .select('id')
      .eq('id', assignedUserId)
      .maybeSingle()
    if (!profileExists) {
      logger.warn(
        {
          step: 'assignment_fallback',
          listing_id: body.listing_id,
          orphan_uuid: assignedUserId,
        },
        'public_inquiries_orphan_assignment',
      )
      assignedUserId = null
    }
  }

  // 3. Insert the inquiry row. FK violations should no longer surface
  // here for assigned_user_id (preflighted above) but other constraint
  // failures still drop us into the fail() branch.
  const { data, error } = await (admin as any)
    .from('inquiries')
    .insert({
      listing_id: body.listing_id,
      assigned_user_id: assignedUserId,
      sender_name: body.sender_name,
      sender_email: body.sender_email ?? null,
      sender_phone: body.sender_phone ?? null,
      message: body.message,
      source: body.source ?? 'website',
    })
    .select('id')
    .single()

  if (error) {
    logger.error(
      {
        step: 'inquiries_insert',
        err: error.message,
        code: (error as any).code,
        details: (error as any).details,
        hint: (error as any).hint,
        listing_id: body.listing_id,
        assigned_user_id: assignedUserId,
        ip: getRequestIP(event, { xForwardedFor: true }),
      },
      'public_inquiries_insert_failed',
    )
    return fail('inquiries_insert', 500, 'Failed to submit inquiry', error)
  }

  // 4. Fan out to the assigned agent. Errors here are logged but
  // non-fatal — the row is already on disk, so the agent sees the
  // inquiry on /inquiries regardless of bell + email delivery.
  if (assignedUserId) {
    try {
      await notify({
        recipientUserId: assignedUserId,
        kind: 'listing.inquiry_received',
        title: 'New inquiry on your listing',
        body: listing.title
          ? `${body.sender_name} inquired about ${listing.title}`
          : `${body.sender_name} sent you a new inquiry`,
        href: `/inquiries?id=${data.id}`,
        listingId: body.listing_id,
        metadata: {
          inquiry_id: data.id,
          sender_name: body.sender_name,
          has_email: !!body.sender_email,
          has_phone: !!body.sender_phone,
        },
      })
    } catch (err) {
      // Notify is documented as fire-and-forget; if it ever throws
      // synchronously, log and proceed. The 500 response previously
      // possible here was the failure mode the website agent suspected.
      logger.warn(
        {
          step: 'notify_fanout',
          err: err instanceof Error ? err.message : String(err),
          inquiry_id: data.id,
        },
        'public_inquiries_notify_failed',
      )
    }
  }

  // Outbound webhook fan-out. Fire-and-forget — partner endpoints get
  // a signed POST with the inquiry payload. Hard 5s per-delivery
  // timeout means a slow partner can't stall this 201.
  //
  // We MUST attach a .catch(): a bare `void dispatchWebhook(...)` would
  // discard the promise but leave any rejection (lookup error, partner
  // network throw, JSON.stringify edge cases) as an unhandled
  // rejection — Nitro logs that as `[request error] [unhandled]`,
  // even though the inquiry write itself succeeded.
  dispatchWebhook('inquiry.received', {
    inquiry_id: data.id,
    listing_id: body.listing_id,
    listing_title: listing.title || null,
    assigned_user_id: assignedUserId,
    sender_name: body.sender_name,
    sender_email: body.sender_email ?? null,
    sender_phone: body.sender_phone ?? null,
    message: body.message,
    source: body.source ?? 'website',
    created_at: new Date().toISOString(),
  }).catch((err: unknown) => {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        op: 'inquiries.webhook_dispatch',
        inquiry_id: data.id,
      },
      'public_inquiries_webhook_dispatch_threw',
    )
  })

  setResponseStatus(event, 201)
  return { id: data.id }
})
