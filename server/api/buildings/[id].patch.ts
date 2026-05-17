// Update a building. RLS gates this to roles with buildings.manage
// permission (admin / manager seeded by 20260501000006).

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/).optional(),
  address: z.string().max(500).nullable().optional(),
  city_id: z.number().int().positive().nullable().optional(),
  developer_id: z.number().int().positive().nullable().optional(),
  zonal_value: z.number().nonnegative().nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  amenities: z.array(z.string().max(200)).max(100).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  is_curated: z.boolean().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    const raw = getRouterParam(event, 'id')
    const id = Number(raw)
    if (!Number.isFinite(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid building id' })
    }

    const update: Record<string, unknown> = {}
    for (const k of [
      'name', 'slug', 'address', 'city_id', 'developer_id', 'zonal_value',
      'description', 'amenities', 'latitude', 'longitude', 'is_curated',
    ] as const) {
      if (body[k] !== undefined) update[k] = body[k] as unknown
    }

    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .from('buildings')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'Slug already in use by another building.',
        })
      }
      logger.error({ err: error.message, op: 'buildings.update', id }, 'buildings_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) throw createError({ statusCode: 404, statusMessage: 'Building not found or not editable' })
    return data
  },
})
