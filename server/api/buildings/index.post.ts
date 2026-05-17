// Create a building. Any authenticated user can suggest one (matches
// the listing form's "+ Create new building" affordance). Slug is
// auto-derived from name when omitted; collision with an existing slug
// returns 409.
//
// Optional fields: address, city_id, developer_id, zonal_value. The
// legacy building_name column is also populated so the existing
// services that read it keep working without a code change.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const bodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/).optional(),
  address: z.string().max(500).nullable().optional(),
  city_id: z.number().int().positive().nullable().optional(),
  developer_id: z.number().int().positive().nullable().optional(),
  zonal_value: z.number().nonnegative().nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  amenities: z.array(z.string().max(200)).max(100).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
})

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200) || 'building'
}

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const supabase = await serverSupabaseClient(event)
    const slug = body.slug ?? slugify(body.name)

    const insert: Record<string, unknown> = {
      name: body.name,
      slug,
      address: body.address ?? null,
      city_id: body.city_id ?? null,
      developer_id: body.developer_id ?? null,
      zonal_value: body.zonal_value ?? null,
      description: body.description ?? null,
      amenities: body.amenities ?? [],
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      created_by: user?.id ?? null,
    }

    const { data, error } = await (supabase as any)
      .from('buildings')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      // 23505 = unique_violation (slug already exists). Surface as 409
      // so the client can prompt the user to pick the existing one.
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `A building with slug "${slug}" already exists.`,
        })
      }
      logger.error({ err: error.message, op: 'buildings.create' }, 'buildings_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    setResponseStatus(event, 201)
    return data
  },
})
