// PATCH /api/admin/ai-suggestions/:id
// Body: { status: 'accepted' | 'rejected' | 'superseded' | 'expired',
//          reject_reason?, accepted_payload?, dispatch?: boolean }
//
// On status='accepted' AND dispatch !== false (default true), the
// dispatcher pushes the operator's accepted_payload into the target
// domain (listings.description, inquiries.metadata.ai_summary, …).
// Dispatch outcome is persisted back to the row's metadata so the
// UI can show "applied" vs "noop" vs "failed (retry)".
//
// Dispatch runs through the operator's session — target-domain RLS
// is enforced. If the operator lacks the target permission (e.g.
// listings.update), dispatch returns failed and the row stays
// accepted with metadata.dispatch_error set so they can fix grants
// and retry.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import {
  dispatchAcceptedSuggestion,
  hasDispatcher,
  type DispatchOutcome,
} from '~~/server/utils/aiSuggestionDispatch'

const bodySchema = z
  .object({
    status: z.enum(['accepted', 'rejected', 'superseded', 'expired']),
    reject_reason: z.string().trim().max(500).nullable().optional(),
    accepted_payload: z.record(z.unknown()).optional(),
    dispatch: z.boolean().optional(),
  })
  .refine(
    (b) => b.status !== 'rejected' || (b.reject_reason && b.reject_reason.length > 0),
    { message: 'reject_reason required when status=rejected' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
    }

    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // 1. Persist the verdict.
    const updates: Record<string, unknown> = {
      status: body.status,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    }
    if (body.reject_reason !== undefined) updates.reject_reason = body.reject_reason
    if (body.accepted_payload !== undefined)
      updates.accepted_payload = body.accepted_payload

    const { data: updated, error } = await (client as any)
      .from('ai_suggestions')
      .update(updates)
      .eq('id', id)
      .select(
        'id, kind, target_kind, target_id, status, reviewed_at, ' +
          'suggested_payload, accepted_payload, metadata',
      )
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!updated) {
      throw createError({ statusCode: 404, statusMessage: 'Suggestion not found' })
    }

    // 2. Dispatch only on accept, when a handler is registered, and
    // the caller didn't opt out.
    let dispatch: DispatchOutcome | null = null
    if (body.status === 'accepted' && body.dispatch !== false && hasDispatcher(updated.kind)) {
      dispatch = await dispatchAcceptedSuggestion({
        event,
        client,
        user_id: user.id,
        suggestion: {
          id: updated.id,
          kind: updated.kind,
          target_kind: updated.target_kind,
          target_id: updated.target_id,
          accepted_payload: updated.accepted_payload ?? null,
          suggested_payload: updated.suggested_payload ?? {},
        },
      })

      // 3. Persist dispatch outcome onto the row's metadata. We do
      // not change `status` — even on failure, the operator's
      // verdict stands; the failure is metadata so they can retry.
      const newMetadata = {
        ...(updated.metadata ?? {}),
        last_dispatch: {
          ...dispatch,
          dispatched_at: new Date().toISOString(),
          dispatched_by: user.id,
        },
      }
      const { error: metaErr } = await (client as any)
        .from('ai_suggestions')
        .update({ metadata: newMetadata })
        .eq('id', updated.id)
      if (metaErr) {
        // Don't fail the whole request just because metadata write
        // didn't stick — the dispatch already happened in DB.
        return {
          id: updated.id,
          status: updated.status,
          reviewed_at: updated.reviewed_at,
          dispatch,
          metadata_update_error: metaErr.message,
        }
      }
    }

    return {
      id: updated.id,
      status: updated.status,
      reviewed_at: updated.reviewed_at,
      dispatch,
    }
  },
})
