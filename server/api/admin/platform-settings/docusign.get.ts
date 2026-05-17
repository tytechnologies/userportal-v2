// Read DocuSign config. Same masking pattern as ai-generation.get.ts —
// the private_key is write-only on the wire; only its presence shows.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('platform_settings')
      .select('value, updated_at, updated_by')
      .eq('key', 'docusign')
      .maybeSingle()
    if (error) {
      logger.error({ err: error.message, op: 'platform_settings.docusign.read' }, 'docusign_settings_read_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    const v = (data?.value ?? {}) as Record<string, unknown>
    return {
      account_id:      typeof v.account_id      === 'string' ? v.account_id      : '',
      integration_key: typeof v.integration_key === 'string' ? v.integration_key : '',
      user_id:         typeof v.user_id         === 'string' ? v.user_id         : '',
      base_uri:        typeof v.base_uri        === 'string' ? v.base_uri        : '',
      redirect_uri:    typeof v.redirect_uri    === 'string' ? v.redirect_uri    : '',
      // Never echo the private key or webhook secret. Surface only presence.
      private_key_set:    typeof v.private_key    === 'string' && (v.private_key as string).length > 0,
      webhook_secret_set: typeof v.webhook_secret === 'string' && (v.webhook_secret as string).length > 0,
      updated_at:      data?.updated_at ?? null,
      updated_by:      data?.updated_by ?? null,
    }
  },
})
