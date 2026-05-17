// Admin: manually create an AI suggestion.
//
// POST /api/admin/ai-suggestions
// Body: {
//   kind: string,                       // e.g. 'listing.description_enrichment'
//   target_kind: string,                // 'listing' | 'inquiry' | â€¦
//   target_id: string,                  // bigint or uuid as text
//   suggested_payload: object,          // shape depends on kind
//   confidence?: number,                // 0..1
//   prompt_version?: string,
//   expires_at?: ISO datetime,
// }
//
// Use cases:
//   - Operator wants to test the dispatch + accept/reject flow without
//     waiting for the cron worker.
//   - Operator received a hand-crafted suggestion (e.g., from an
//     outside auditor) and wants it tracked in the queue.
//
// Sets model_provider='manual', model_name=<operator email or 'admin'>.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  kind: z.string().trim().min(1).max(80),
  target_kind: z.string().trim().min(1).max(40),
  target_id: z.string().trim().min(1).max(64),
  suggested_payload: z.record(z.unknown()),
  confidence: z.number().min(0).max(1).nullable().optional(),
  prompt_version: z.string().trim().max(40).nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()

    const insertRow = {
      kind: body.kind,
      target_kind: body.target_kind,
      target_id: body.target_id,
      suggested_payload: body.suggested_payload,
      model_provider: 'manual',
      model_name: user?.email ?? 'admin',
      model_run_id: null,
      prompt_version: body.prompt_version ?? null,
      confidence: body.confidence ?? null,
      status: 'pending',
      expires_at: body.expires_at ?? null,
      metadata: {
        created_via: 'admin_manual',
        created_by_user_id: user?.id ?? null,
      },
    }

    const { data: created, error: insertErr } = await (admin as any)
      .from('ai_suggestions')
      .insert(insertRow)
      .select(
        'id, kind, target_kind, target_id, status, confidence, model_provider, model_name, created_at',
      )
      .single()
    if (insertErr) {
      logger.error(
        { err: insertErr.message, op: 'admin.ai_suggestions.create', kind: body.kind },
        'ai_suggestion_manual_create_failed',
      )
      throw createError({
        statusCode: 500,
        statusMessage: 'Could not create suggestion',
      })
    }

    await logActivity({
      event,
      action: 'ai_suggestion.manually_created',
      entity: 'ai_suggestion' as any,
      entityId: created.id,
      metadata: {
        kind: body.kind,
        target_kind: body.target_kind,
        target_id: body.target_id,
      },
    })

    return { suggestion: created }
  },
})
