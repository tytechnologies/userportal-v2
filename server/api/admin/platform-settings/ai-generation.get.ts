// Read the AI-generation config. Platform-admin only — RLS on
// platform_settings already gates this, but we belt-and-suspenders
// with a role check so the response shape ("Unauthorized" vs.
// "Empty value") is unambiguous.
//
// The api_key is masked in the response — only its presence is
// returned. The admin form shows "<configured>" placeholder copy and
// lets the admin paste a new key to overwrite. The plaintext key
// never leaves the server once stored.

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
      .eq('key', 'ai_generation')
      .maybeSingle()
    if (error) {
      logger.error(
        { err: error.message, op: 'platform_settings.ai.read' },
        'ai_settings_read_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    const v = (data?.value ?? {}) as Record<string, unknown>
    return {
      provider:      typeof v.provider === 'string' ? v.provider : '',
      endpoint:      typeof v.endpoint === 'string' ? v.endpoint : '',
      model:         typeof v.model === 'string' ? v.model : '',
      header_style:  v.header_style === 'anthropic' ? 'anthropic' : 'bearer',
      system_prompt: typeof v.system_prompt === 'string' ? v.system_prompt : '',
      // Never return the key. Surface only its presence.
      api_key_set:   typeof v.api_key === 'string' && v.api_key.length > 0,
      updated_at:    data?.updated_at ?? null,
      updated_by:    data?.updated_by ?? null,
    }
  },
})
