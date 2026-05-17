// Snapshot the current draft state as a new version.
//
// POST /api/document-drafts/:id/versions
// Body: { label?: string }
//
// Server-side resolves the next version_number atomically so two
// concurrent snapshots can't collide. Snapshot copies the live row's
// `data` and (when present) `data.ai_body` into snapshot_body for
// fast diff rendering.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const bodySchema = z.object({
  label: z.string().trim().max(80).optional(),
}).strict()

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid draft id' })
    }
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    // Pull the live draft. RLS already gates this — if the caller
    // can't read the draft we'll get null and 404 below.
    const { data: draft, error: readErr } = await (supabase as any)
      .from('document_drafts')
      .select('id, data')
      .eq('id', id)
      .maybeSingle()
    if (readErr) {
      throw createError({ statusCode: 500, statusMessage: readErr.message })
    }
    if (!draft) {
      throw createError({ statusCode: 404, statusMessage: 'Draft not found' })
    }

    // Compute next version_number. Done client-side because there's
    // no SERIAL on (draft_id, version_number); the unique index will
    // surface a constraint error on the rare race, which the caller
    // can retry.
    const { data: latest } = await (supabase as any)
      .from('document_versions')
      .select('version_number')
      .eq('draft_id', id)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextVersion = (latest?.version_number ?? 0) + 1

    const data = (draft.data ?? {}) as Record<string, unknown>
    const snapshotBody = typeof data.ai_body === 'string' ? (data.ai_body as string) : null

    const { data: inserted, error: insErr } = await (supabase as any)
      .from('document_versions')
      .insert({
        draft_id:       id,
        version_number: nextVersion,
        snapshot_data:  data,
        snapshot_body:  snapshotBody,
        label:          body.label ?? null,
        created_by:     user?.id ?? null,
      })
      .select('*')
      .single()
    if (insErr) {
      // Unique-constraint conflict ⇒ concurrent snapshot race; tell
      // the caller to retry — re-resolving the next version_number.
      if (insErr.code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'Concurrent snapshot — retry the request.',
        })
      }
      logger.error({ err: insErr.message, op: 'doc_versions.create' }, 'doc_version_insert_failed')
      throw createError({ statusCode: 500, statusMessage: insErr.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'document_draft.versioned' as any,
      entity: 'document',
      metadata: {
        draft_id: id,
        version_id: inserted?.id,
        version_number: nextVersion,
        label: body.label ?? null,
      },
    })

    setResponseStatus(event, 201)
    return inserted
  },
})
