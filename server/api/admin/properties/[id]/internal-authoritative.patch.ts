// Admin — toggle properties.internal_authoritative.
//
// PATCH /api/admin/properties/:id/internal-authoritative
// Body: { value: boolean }
//
// Drives the search-ranking boost + trust badge. No further validation
// beyond admin auth; the flag is operator judgement.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const bodySchema = z.object({
  value: z.boolean(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const propertyId = Number(getRouterParam(event, 'id') || '0')
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid property id' })
    }

    const b = body as z.infer<typeof bodySchema>
    const supabase = await serverSupabaseClient(event)

    const { error } = await (supabase as any)
      .from('properties')
      .update({
        internal_authoritative: b.value,
        updated_at:             new Date().toISOString(),
      })
      .eq('id', propertyId)

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    return { ok: true, property_id: propertyId, internal_authoritative: b.value }
  },
})
