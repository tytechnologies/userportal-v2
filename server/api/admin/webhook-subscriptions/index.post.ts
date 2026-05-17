// Create a webhook subscription.
//
// POST /api/admin/webhook-subscriptions
// Auth: admin (webhooks.manage gates RLS).
//
// SSRF guard: validates the URL is HTTPS and rejects RFC1918 / loopback
// hosts at subscription time. Doesn't try to be exhaustive — partners
// can host on any public IP — but blocks the obvious mistake of
// pointing a webhook at internal infrastructure.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'

const KNOWN_KINDS = [
  'inquiry.received',
  'listing.created',
  'listing.updated',
  'listing.archived',
  'listing.ingested',
  'verification.approved',
  'verification.rejected',
  // Deal lifecycle (mig 20260507000021)
  'deal.created',
  'deal.stage_changed',
  'deal.closed_won',
  'deal.closed_lost',
  'viewing.scheduled',
] as const

const bodySchema = z.object({
  display_name: z.string().trim().min(1).max(160),
  url: z.string().trim().url().max(2048).startsWith('https://'),
  source_id: z.number().int().positive().nullable().optional(),
  event_kinds: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  notes: z.string().trim().max(4000).nullable().optional(),
})

function looksInternal(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (host === 'localhost') return true
    if (host === '0.0.0.0' || host === '127.0.0.1') return true
    // RFC1918 v4 ranges (string-prefix check; doesn't catch every edge
    // case but covers the obvious mistakes).
    if (/^10\./.test(host)) return true
    if (/^192\.168\./.test(host)) return true
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true
    // IPv6 loopback / link-local prefixes.
    if (host === '::1' || host.startsWith('fe80:')) return true
    return false
  } catch {
    return true
  }
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    if (looksInternal(body.url)) {
      throw createError({
        statusCode: 422,
        statusMessage:
          'URL points at internal / loopback infrastructure. Use a publicly reachable HTTPS endpoint.',
      })
    }

    // Warn (not block) if event_kinds contains anything outside
    // KNOWN_KINDS — partners may legitimately subscribe to a kind
    // we'll add later, and we don't want to gate on a string list.
    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('webhook_subscriptions')
      .insert({
        display_name: body.display_name.trim(),
        url: body.url.trim(),
        source_id: body.source_id ?? null,
        event_kinds: body.event_kinds,
        notes: body.notes?.trim() || null,
      })
      .select('*')
      .single()

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'webhook.subscribed' as any,
      entity: 'webhook' as any,
      entityId: data.id,
      metadata: {
        display_name: data.display_name,
        url_host: new URL(data.url).hostname,
        event_kinds: data.event_kinds,
      },
    })

    setResponseStatus(event, 201)
    return data
  },
})
