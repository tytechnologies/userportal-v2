// Update the AI-generation config. Platform-admin only.
//
// PATCH /api/admin/platform-settings/ai-generation
// Body: any subset of { provider, endpoint, api_key, model, header_style, system_prompt }
//
// `api_key` is write-only. Sending an empty string CLEARS the key;
// sending a non-empty string overwrites it. Omitting the field entirely
// leaves the existing key untouched — that's the common case where the
// admin tweaks model or system_prompt without rotating the key.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  provider:      z.string().trim().max(80).optional(),
  endpoint:      z.string().trim().url().max(2000).optional(),
  api_key:       z.string().max(8000).optional(),
  model:         z.string().trim().max(120).optional(),
  header_style:  z.enum(['bearer', 'anthropic']).optional(),
  system_prompt: z.string().max(8000).optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    const supabase = await serverSupabaseClient(event)

    // Read-merge-write so partial updates don't blow away other keys.
    const { data: existing, error: readErr } = await (supabase as any)
      .from('platform_settings')
      .select('value')
      .eq('key', 'ai_generation')
      .maybeSingle()
    if (readErr) {
      logger.error(
        { err: readErr.message, op: 'platform_settings.ai.read' },
        'ai_settings_read_failed',
      )
      throw createError({ statusCode: 500, statusMessage: readErr.message })
    }
    const current: Record<string, unknown> = (existing?.value ?? {}) as Record<string, unknown>

    const next: Record<string, unknown> = { ...current }
    if (body.provider     !== undefined) next.provider     = body.provider
    if (body.endpoint     !== undefined) next.endpoint     = body.endpoint
    if (body.model        !== undefined) next.model        = body.model
    if (body.header_style !== undefined) next.header_style = body.header_style
    if (body.system_prompt!== undefined) next.system_prompt= body.system_prompt
    if (body.api_key      !== undefined) {
      // Empty string clears the key. Anything else sets it.
      if (body.api_key === '') delete next.api_key
      else next.api_key = body.api_key
    }

    const { error: writeErr } = await (supabase as any)
      .from('platform_settings')
      .update({ value: next })
      .eq('key', 'ai_generation')
    if (writeErr) {
      logger.error(
        { err: writeErr.message, op: 'platform_settings.ai.write' },
        'ai_settings_write_failed',
      )
      throw createError({ statusCode: 500, statusMessage: writeErr.message })
    }

    // Return the masked shape so the form can refresh state without
    // exposing the key.
    return {
      provider:      typeof next.provider === 'string' ? next.provider : '',
      endpoint:      typeof next.endpoint === 'string' ? next.endpoint : '',
      model:         typeof next.model === 'string' ? next.model : '',
      header_style:  next.header_style === 'anthropic' ? 'anthropic' : 'bearer',
      system_prompt: typeof next.system_prompt === 'string' ? next.system_prompt : '',
      api_key_set:   typeof next.api_key === 'string' && next.api_key.length > 0,
    }
  },
})
