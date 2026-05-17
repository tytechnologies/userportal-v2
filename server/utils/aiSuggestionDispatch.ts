// AI suggestion dispatcher.
//
// Phase D follow-on. When an operator accepts an ai_suggestions row,
// this module pushes the change into the appropriate target domain
// (listings, inquiries, document_drafts, …) and writes an activity
// audit row.
//
// Trust contract:
//   * Dispatch runs through the operator's request-scoped supabase
//     client, so target-domain RLS is enforced — never bypassed by
//     ai_suggestions.manage alone. e.g. accepting a listing.description
//     enrichment requires the operator's own listings.update grant.
//   * The handler reads the operator's `accepted_payload` (their final
//     edit), NOT the model's original `suggested_payload`.
//   * Failures in dispatch DO NOT undo the accept verdict — the row
//     stays accepted with `metadata.dispatch_error` set, so the
//     operator can retry from the UI.
//
// New kinds: add a `kindHandlers[kind] = ...` entry. No other
// boilerplate needed.

import type { H3Event } from 'h3'
import type { SupabaseLike } from './audit'
import { logActivity } from './audit'
import { logger } from './logger'

export type DispatchInput = {
  event: H3Event
  client: SupabaseLike
  user_id: string
  suggestion: {
    id: string
    kind: string
    target_kind: string
    target_id: string
    accepted_payload: Record<string, unknown> | null
    suggested_payload: Record<string, unknown>
  }
}

export type DispatchOutcome =
  | { status: 'applied'; detail?: string }
  | { status: 'noop'; detail: string }
  | { status: 'failed'; detail: string }

type Handler = (input: DispatchInput) => Promise<DispatchOutcome>

const kindHandlers: Record<string, Handler> = {
  // ------------------------------------------------------------------
  // listing.description_enrichment → write listings.description.
  //
  // Effective payload merge: operator's accepted_payload wins over
  // the model's suggested_payload. We accept either { proposed_description }
  // or { description } so a future prompt change doesn't break us.
  'listing.description_enrichment': async ({ event, client, suggestion }) => {
    const payload = (suggestion.accepted_payload ?? suggestion.suggested_payload) as Record<
      string,
      unknown
    >
    const next =
      (typeof payload.proposed_description === 'string' && payload.proposed_description) ||
      (typeof payload.description === 'string' && payload.description) ||
      null
    if (!next || next.trim().length === 0) {
      return { status: 'noop', detail: 'empty proposed_description' }
    }
    if (suggestion.target_kind !== 'listing') {
      return {
        status: 'noop',
        detail: `target_kind=${suggestion.target_kind} (expected listing)`,
      }
    }
    const listingId = Number(suggestion.target_id)
    if (!Number.isFinite(listingId)) {
      return { status: 'failed', detail: `bad listing id: ${suggestion.target_id}` }
    }
    const { error } = await (client as any)
      .from('listings')
      .update({ description: next, updated_at: new Date().toISOString() })
      .eq('id', listingId)
    if (error) return { status: 'failed', detail: error.message }
    await logActivity({
      event,
      client,
      action: 'listing.ai_description_applied',
      entity: 'listing',
      entityId: null,
      metadata: { listing_id: listingId, suggestion_id: suggestion.id, source: 'ai_suggestion' },
    }).catch((err) =>
      logger.warn({ err: (err as Error).message, op: 'dispatch.listing' }, 'audit_failed'),
    )
    return { status: 'applied' }
  },

  // ------------------------------------------------------------------
  // inquiry.summarisation → patch the summary into inquiries.metadata.
  //
  // We don't overwrite the inquiry body itself (operator may want
  // both summary + raw thread). Storing on metadata.ai_summary keeps
  // the inquiry-detail page free to render it without a new column.
  'inquiry.summarisation': async ({ event, client, suggestion, user_id }) => {
    const payload = (suggestion.accepted_payload ?? suggestion.suggested_payload) as Record<
      string,
      unknown
    >
    const summary = typeof payload.summary === 'string' ? payload.summary : null
    if (!summary) return { status: 'noop', detail: 'empty summary' }
    if (suggestion.target_kind !== 'inquiry') {
      return {
        status: 'noop',
        detail: `target_kind=${suggestion.target_kind} (expected inquiry)`,
      }
    }
    const { data: existing, error: readErr } = await (client as any)
      .from('inquiries')
      .select('id, metadata')
      .eq('id', suggestion.target_id)
      .maybeSingle()
    if (readErr) return { status: 'failed', detail: readErr.message }
    if (!existing) return { status: 'failed', detail: 'inquiry not found' }

    const metadata = {
      ...(existing.metadata ?? {}),
      ai_summary: {
        summary,
        key_points: Array.isArray(payload.key_points) ? payload.key_points : [],
        next_action: typeof payload.next_action === 'string' ? payload.next_action : null,
        applied_at: new Date().toISOString(),
        applied_by: user_id,
        suggestion_id: suggestion.id,
      },
    }
    const { error: updErr } = await (client as any)
      .from('inquiries')
      .update({ metadata })
      .eq('id', suggestion.target_id)
    if (updErr) return { status: 'failed', detail: updErr.message }
    await logActivity({
      event,
      client,
      action: 'inquiry.ai_summary_applied',
      entity: 'inquiry',
      entityId: String(suggestion.target_id),
      metadata: { suggestion_id: suggestion.id, source: 'ai_suggestion' },
    }).catch((err) =>
      logger.warn({ err: (err as Error).message, op: 'dispatch.inquiry' }, 'audit_failed'),
    )
    return { status: 'applied' }
  },
}

export function hasDispatcher(kind: string): boolean {
  return kind in kindHandlers
}

// Returns the outcome — caller is responsible for persisting it back
// to the suggestion row (so a failure here doesn't auto-revert the
// accept verdict).
export async function dispatchAcceptedSuggestion(
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const handler = kindHandlers[input.suggestion.kind]
  if (!handler) {
    return {
      status: 'noop',
      detail: `no dispatcher registered for kind=${input.suggestion.kind}`,
    }
  }
  try {
    return await handler(input)
  } catch (err: any) {
    return { status: 'failed', detail: err?.message ?? String(err) }
  }
}
