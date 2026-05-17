// Admin — verdict on a duplicate candidate.
//
// PATCH /api/admin/duplicates/:id
// Body: { status: 'confirmed_duplicate' | 'distinct' | 'dismissed', review_notes? }
// Auth: admin.
//
// Audit-logged via log_activity. Verdict stamps reviewed_by +
// reviewed_at via the SECURITY DEFINER `notify`/repo path; here we
// update directly under RLS (admin policy permits all access).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const UUID_RE = /^[0-9a-f-]{36}$/i

const bodySchema = z.object({
  status: z.enum(['confirmed_duplicate', 'distinct', 'dismissed', 'pending']),
  review_notes: z.string().trim().max(2000).optional().nullable(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid candidate id' })
    }

    const b = body as z.infer<typeof bodySchema>
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Verdict-driven activity verb so the audit log surfaces what
    // actually happened.
    const verb =
      b.status === 'confirmed_duplicate' ? 'duplicate.confirmed' :
      b.status === 'distinct'            ? 'duplicate.dismissed_distinct' :
      b.status === 'dismissed'           ? 'duplicate.dismissed' :
                                           'duplicate.reopened'

    const updatePayload: Record<string, unknown> = {
      status:        b.status,
      review_notes:  b.review_notes ?? null,
      reviewed_by:   b.status === 'pending' ? null : user.id,
      reviewed_at:   b.status === 'pending' ? null : new Date().toISOString(),
    }

    const { data, error } = await (supabase as any)
      .from('listing_duplicate_candidates')
      .update(updatePayload)
      .eq('id', id)
      .select('id, a_listing_id, b_listing_id, status, confidence')
      .maybeSingle()

    if (error) {
      // Log the structured supabase error so the cause (RLS denial,
      // schema-cache miss, FK violation, etc.) shows up in server logs
      // — the bare `error.message` we used to surface as a 500 status
      // message often loses the code + hint that PostgREST returns.
      logger.error(
        {
          err: error.message,
          code: (error as any).code,
          hint: (error as any).hint,
          details: (error as any).details,
          op: 'admin.duplicates.patch',
          candidate_id: id,
          status: b.status,
          user_id: user.id,
        },
        'duplicate_verdict_failed',
      )
      throw createError({
        statusCode: 500,
        statusMessage: `Duplicate verdict failed: ${error.message}${(error as any).hint ? ` (hint: ${(error as any).hint})` : ''}`,
      })
    }
    if (!data)  throw createError({ statusCode: 404, statusMessage: 'Candidate not found' })

    // log_activity has signature (p_action text, p_entity text,
    // p_entity_id uuid, p_metadata jsonb) per migration
    // 20260429000006. Earlier we passed only p_action + p_metadata,
    // which PostgREST resolved to "no parameter matches" — the call
    // silently no-op'd because supabase-js returns the error as
    // `{data, error}` rather than rejecting. Still worth fixing so
    // the audit trail actually records the verdict.
    const { error: logErr } = await (supabase as any).rpc('log_activity', {
      p_action:    verb,
      p_entity:    'listing_duplicate_candidate',
      p_entity_id: data.id,
      p_metadata:  {
        candidate_id:   data.id,
        a_listing_id:   data.a_listing_id,
        b_listing_id:   data.b_listing_id,
        confidence:     data.confidence,
        notes:          b.review_notes ?? null,
      },
    })
    if (logErr) {
      // Audit log failure should not fail the request — the verdict
      // is already persisted. Log as a warn so ops can see the trail
      // gap if this happens repeatedly.
      logger.warn(
        { err: logErr.message, op: 'admin.duplicates.patch.log_activity', candidate_id: id },
        'duplicate_verdict_audit_failed',
      )
    }

    return { candidate: data }
  },
})
