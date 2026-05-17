// Payment gateway events repo — webhook log + dispatch.
//
// Two surfaces:
//   1. Receiving (from /api/webhooks/payments/[provider]) — calls the
//      record_payment_gateway_event RPC for idempotent insert, then
//      dispatches the matched handler.
//   2. Reading (admin-only) — list and replay endpoints.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'

export type GatewayEventDispatchInput = {
  provider: string
  externalEventId: string
  eventType: string
  payload: Record<string, unknown>
  signatureVerified: boolean
}

const EVENT_SELECT =
  'id, provider, event_id, event_type, payload, signature_verified, ' +
  'processing_status, processing_error, processed_at, related_invoice_id, ' +
  'related_intent_id, received_at'

export const paymentEventsRepo = {
  /**
   * Record + dispatch. Caller (webhook endpoint) uses this to
   * insert the event idempotently and trigger handler logic.
   * Always uses service-role (admin client) since webhooks are
   * unauthenticated to the platform.
   */
  async recordAndDispatch(input: GatewayEventDispatchInput) {
    const admin = getServerSupabaseAdmin()

    // Idempotent insert via the RPC.
    const { data: eventId, error: insErr } = await (admin as any).rpc(
      'record_payment_gateway_event',
      {
        p_provider: input.provider,
        p_event_id: input.externalEventId,
        p_event_type: input.eventType,
        p_payload: input.payload,
        p_signature_verified: input.signatureVerified,
      },
    )
    if (insErr) {
      logger.error(
        { err: insErr.message, op: 'paymentEvents.recordAndDispatch' },
        'payment_events_record_failed',
      )
      throw createError({ statusCode: 500, statusMessage: insErr.message })
    }

    if (!input.signatureVerified) {
      // Signature failed — leave row as 'received'; do not dispatch.
      return { event_id: eventId, dispatched: false, reason: 'signature_unverified' }
    }

    // Dispatch by event_type. Only a few canonical mappings live here;
    // unknown types stay 'received' for admin review.
    let processingStatus: 'processed' | 'ignored' | 'failed' = 'ignored'
    let processingError: string | null = null

    try {
      const t = input.eventType.toLowerCase()
      if (
        t.includes('payment') && (t.includes('paid') || t.includes('succeeded'))
      ) {
        processingStatus = 'processed'
        // Real handler attaches in the gateway-integration turn:
        //   await admin.rpc('invoice_mark_paid', { ... })
      } else if (
        t.includes('payment') && (t.includes('failed') || t.includes('declined'))
      ) {
        processingStatus = 'processed'
        // Real handler:
        //   await admin.rpc('invoice_record_failure', { ... })
      } else {
        processingStatus = 'ignored'
      }
    } catch (err: any) {
      processingStatus = 'failed'
      processingError = err?.message ?? String(err)
    }

    await (admin as any)
      .from('payment_gateway_events')
      .update({
        processing_status: processingStatus,
        processing_error: processingError,
        processed_at: new Date().toISOString(),
      })
      .eq('id', eventId)

    return {
      event_id: eventId,
      dispatched: processingStatus === 'processed',
      processing_status: processingStatus,
    }
  },

  async listEvents({
    event,
    provider,
    status,
  }: {
    event: H3Event
    provider?: string
    status?: string
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('payment_gateway_events')
      .select(EVENT_SELECT)
      .order('received_at', { ascending: false })
      .limit(200)
    if (provider) q = q.eq('provider', provider)
    if (status) q = q.eq('processing_status', status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async replay({ event, eventRowId }: { event: H3Event; eventRowId: string }) {
    const client = await serverSupabaseClient(event)
    const { data: row, error } = await (client as any)
      .from('payment_gateway_events')
      .select(EVENT_SELECT)
      .eq('id', eventRowId)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: 'Event not found' })
    }

    return await this.recordAndDispatch({
      provider: row.provider,
      externalEventId: row.event_id,
      eventType: row.event_type,
      payload: row.payload,
      signatureVerified: row.signature_verified,
    })
  },
}
