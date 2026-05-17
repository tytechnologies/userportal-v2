// PATCH /api/admin/platform-settings/:key
// Body: { value: jsonb, organization_id?: uuid | null }
//
// Upserts a platform_settings row. organization_id null = global,
// non-null = per-tenant. The composite uniqueness from migration
// 077 covers both.
//
// Note: the upsert onConflict here uses raw SQL to handle the NULL
// case correctly — onConflict on (key, organization_id) doesn't
// match NULL=NULL by default in PostgREST, so we instead delete
// any existing row with the same scope and insert fresh. Fast
// enough for a settings page (single row).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'

const bodySchema = z.object({
  value: z.record(z.unknown()),
  organization_id: z.string().uuid().nullable().optional(),
})

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const key = getRouterParam(event, 'key')
    if (!key || !KEY_RE.test(key)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid setting key' })
    }
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    const orgId = body.organization_id ?? null

    // Delete the matching scope row first (handles NULL = NULL).
    let del = (client as any).from('platform_settings').delete().eq('key', key)
    del = orgId ? del.eq('organization_id', orgId) : del.is('organization_id', null)
    const { error: delErr } = await del
    if (delErr) {
      throw createError({ statusCode: 500, statusMessage: delErr.message })
    }

    const { data, error } = await (client as any)
      .from('platform_settings')
      .insert({
        key,
        value: body.value,
        organization_id: orgId,
        updated_by: user?.id ?? null,
      })
      .select('key, value, description, organization_id, updated_at')
      .single()
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })
    return data
  },
})
