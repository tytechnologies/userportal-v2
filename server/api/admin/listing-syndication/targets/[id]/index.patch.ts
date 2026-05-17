// Edit a syndication target.
//
// PATCH /api/admin/listing-syndication/targets/[id]
// Body: any subset of { display_name, feed_format, delivery_mode,
//                       push_endpoint_url, push_auth_kind,
//                       push_secret_vault_key, include_filters,
//                       max_listings_per_run, refresh_cron, notes,
//                       status }
//
// Slug is intentionally NOT patchable â€” it's the public URL contract.
// Re-create the target if the slug needs to change.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  feed_format: z.enum(['json', 'xml', 'csv', 'rss']).optional(),
  delivery_mode: z.enum(['pull', 'push']).optional(),
  push_endpoint_url: z.string().url().max(2048).nullable().optional(),
  push_auth_kind: z.enum(['none', 'bearer', 'hmac', 'basic']).nullable().optional(),
  push_secret_vault_key: z.string().trim().max(120).nullable().optional(),
  include_filters: z.record(z.unknown()).optional(),
  max_listings_per_run: z.number().int().min(1).max(50000).optional(),
  refresh_cron: z.string().trim().max(64).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'manager')

    const id = getRouterParam(event, 'id')
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid target id' })
    }

    // JSON / XML / CSV are wired. RSS still throws â€” reject at patch time.
    if (
      body.feed_format &&
      body.feed_format !== 'json' &&
      body.feed_format !== 'xml' &&
      body.feed_format !== 'csv'
    ) {
      throw createError({
        statusCode: 422,
        statusMessage: 'feed_format must be json, xml, or csv (rss coming)',
      })
    }

    const admin = getServerSupabaseAdmin()

    const patch: Record<string, unknown> = {}
    for (const k of [
      'display_name',
      'feed_format',
      'delivery_mode',
      'push_endpoint_url',
      'push_auth_kind',
      'push_secret_vault_key',
      'include_filters',
      'max_listings_per_run',
      'refresh_cron',
      'notes',
      'status',
    ] as const) {
      const v = (body as any)[k]
      if (v !== undefined) patch[k] = v
    }
    if (Object.keys(patch).length === 0) {
      return { id, updated: false }
    }

    const { data: updated, error } = await (admin as any)
      .from('listing_syndication_targets')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'admin.syndication.patch_target', target_id: id },
        'syndication_patch_target_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '23514') {
        throw createError({ statusCode: 422, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not update target' })
    }

    await logActivity({
      event,
      action: 'syndication.target_updated',
      entity: 'syndication_target' as any,
      entityId: id,
      metadata: { changed_fields: Object.keys(patch) },
    })

    return { target: updated }
  },
})
