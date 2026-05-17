// Update DocuSign config. Same partial-update semantics as
// ai-generation.patch.ts — fields you don't include are preserved,
// secrets default to "leave alone" when omitted, empty string clears.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  account_id:      z.string().trim().max(80).optional(),
  integration_key: z.string().trim().max(80).optional(),
  user_id:         z.string().trim().max(80).optional(),
  base_uri:        z.string().trim().max(120).optional(),
  redirect_uri:    z.string().trim().max(2000).optional(),
  // Secrets: empty string clears, absent leaves alone.
  private_key:     z.string().max(20_000).optional(),
  webhook_secret:  z.string().max(200).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    const supabase = await serverSupabaseClient(event)

    const { data: existing, error: readErr } = await (supabase as any)
      .from('platform_settings')
      .select('value')
      .eq('key', 'docusign')
      .maybeSingle()
    if (readErr) {
      throw createError({ statusCode: 500, statusMessage: readErr.message })
    }
    const current: Record<string, unknown> = (existing?.value ?? {}) as Record<string, unknown>

    const next: Record<string, unknown> = { ...current }
    if (body.account_id      !== undefined) next.account_id      = body.account_id
    if (body.integration_key !== undefined) next.integration_key = body.integration_key
    if (body.user_id         !== undefined) next.user_id         = body.user_id
    if (body.base_uri        !== undefined) next.base_uri        = body.base_uri
    if (body.redirect_uri    !== undefined) next.redirect_uri    = body.redirect_uri
    if (body.private_key !== undefined) {
      if (body.private_key === '') delete next.private_key
      else next.private_key = body.private_key
    }
    if (body.webhook_secret !== undefined) {
      if (body.webhook_secret === '') delete next.webhook_secret
      else next.webhook_secret = body.webhook_secret
    }

    const { error: writeErr } = await (supabase as any)
      .from('platform_settings')
      .update({ value: next })
      .eq('key', 'docusign')
    if (writeErr) {
      logger.error({ err: writeErr.message, op: 'platform_settings.docusign.write' }, 'docusign_settings_write_failed')
      throw createError({ statusCode: 500, statusMessage: writeErr.message })
    }

    return {
      account_id:      typeof next.account_id      === 'string' ? next.account_id      : '',
      integration_key: typeof next.integration_key === 'string' ? next.integration_key : '',
      user_id:         typeof next.user_id         === 'string' ? next.user_id         : '',
      base_uri:        typeof next.base_uri        === 'string' ? next.base_uri        : '',
      redirect_uri:    typeof next.redirect_uri    === 'string' ? next.redirect_uri    : '',
      private_key_set:    typeof next.private_key    === 'string' && (next.private_key as string).length > 0,
      webhook_secret_set: typeof next.webhook_secret === 'string' && (next.webhook_secret as string).length > 0,
    }
  },
})
