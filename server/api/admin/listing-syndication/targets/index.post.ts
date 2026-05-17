// Create a syndication target.
//
// POST /api/admin/listing-syndication/targets
// Body: { slug, display_name, feed_format, delivery_mode,
//          push_endpoint_url?, include_filters?, max_listings_per_run?,
//          refresh_cron?, notes? }

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logActivity } from '~~/server/utils/audit'
import { logger } from '~~/server/utils/logger'

const bodySchema = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'slug must be a-z0-9_- (2-40 chars)'),
    display_name: z.string().trim().min(1).max(120),
    feed_format: z.enum(['json', 'xml', 'csv', 'rss']).default('json'),
    delivery_mode: z.enum(['pull', 'push']).default('pull'),
    push_endpoint_url: z.string().url().max(2048).nullable().optional(),
    push_auth_kind: z.enum(['none', 'bearer', 'hmac', 'basic']).nullable().optional(),
    push_secret_vault_key: z.string().trim().max(120).nullable().optional(),
    include_filters: z.record(z.unknown()).default({}),
    max_listings_per_run: z.number().int().min(1).max(50000).default(1000),
    refresh_cron: z.string().trim().max(64).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine(
    (b) => b.delivery_mode === 'pull' || !!b.push_endpoint_url,
    { message: 'push_endpoint_url is required when delivery_mode=push' },
  )
  .refine(
    // JSON / XML / CSV are wired. RSS still throws (needs per-listing
    // canonical URLs from the website), so we reject it at create time.
    (b) => b.feed_format === 'json' || b.feed_format === 'xml' || b.feed_format === 'csv',
    { message: 'feed_format must be json, xml, or csv (rss coming)' },
  )

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    await requireRole(event, 'manager')
    const admin = getServerSupabaseAdmin()

    const { data: created, error } = await (admin as any)
      .from('listing_syndication_targets')
      .insert({
        slug: body.slug,
        display_name: body.display_name,
        feed_format: body.feed_format,
        delivery_mode: body.delivery_mode,
        push_endpoint_url: body.push_endpoint_url ?? null,
        push_auth_kind: body.push_auth_kind ?? null,
        push_secret_vault_key: body.push_secret_vault_key ?? null,
        include_filters: body.include_filters,
        max_listings_per_run: body.max_listings_per_run,
        refresh_cron: body.refresh_cron ?? null,
        notes: body.notes ?? null,
        created_by: user?.id ?? null,
      })
      .select('*')
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'admin.syndication.create_target' },
        'syndication_create_target_failed',
      )
      const code = (error as any).code as string | undefined
      if (code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `Target with slug "${body.slug}" already exists`,
        })
      }
      if (code === '23514') {
        throw createError({ statusCode: 422, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: 'Could not create target' })
    }

    await logActivity({
      event,
      action: 'syndication.target_created',
      entity: 'syndication_target' as any,
      entityId: created.id,
      metadata: {
        slug: created.slug,
        feed_format: created.feed_format,
        delivery_mode: created.delivery_mode,
      },
    })

    return { target: created }
  },
})
