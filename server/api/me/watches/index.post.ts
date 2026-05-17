// Create a market watch.
//
// POST /api/me/watches
// Body: { target_type, target_id, alert_types?, label? }
// Auth: required. RLS gates user_id = auth.uid().
//
// Caps the user at 50 active watches to prevent runaway watchlists
// dominating the evaluator's workload.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../utils/sbUser'

const TARGET_TYPES = ['building', 'city', 'barangay', 'broker', 'developer', 'organization'] as const
const ALERT_TYPES = [
  'new_listing_in_watch',
  'verified_listing',
  'hot_area',
  'fast_moving_inventory',
  'trusted_broker_listed',
] as const

const bodySchema = z.object({
  target_type: z.enum(TARGET_TYPES),
  target_id:   z.string().trim().min(1).max(64),
  alert_types: z.array(z.enum(ALERT_TYPES)).min(1).optional(),
  label:       z.string().trim().max(120).optional(),
}).strict()

const MAX_WATCHES_PER_USER = 50

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const b = body as z.infer<typeof bodySchema>
    const supabase = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Cap check.
    const { count } = await (supabase as any)
      .from('market_watches')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    if ((count ?? 0) >= MAX_WATCHES_PER_USER) {
      throw createError({
        statusCode: 409,
        statusMessage: `Watch limit reached (${MAX_WATCHES_PER_USER}). Remove one before adding another.`,
      })
    }

    // Sanity-check that hot_area only applies to barangay watches â€”
    // the evaluator's hot_area branch is keyed on barangay.
    if (b.alert_types?.includes('hot_area') && b.target_type !== 'barangay') {
      throw createError({
        statusCode: 400,
        statusMessage: 'hot_area alerts apply only to barangay watches',
      })
    }
    // fast_moving_inventory only applies to city watches in v1.
    if (b.alert_types?.includes('fast_moving_inventory') && b.target_type !== 'city') {
      throw createError({
        statusCode: 400,
        statusMessage: 'fast_moving_inventory alerts apply only to city watches',
      })
    }

    const insertPayload: Record<string, unknown> = {
      user_id:     user.id,
      target_type: b.target_type,
      target_id:   b.target_id,
      label:       b.label ?? null,
    }
    if (b.alert_types) insertPayload.alert_types = b.alert_types

    const { data, error } = await (supabase as any)
      .from('market_watches')
      .insert(insertPayload)
      .select('id, target_type, target_id, alert_types, label')
      .single()

    if (error) {
      if (error.code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'You already watch this target â€” update existing watch instead.',
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { watch: data }
  },
})
