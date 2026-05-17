// Admin â€” stage a CSV listing import batch.
//
// POST /api/admin/listings/import
// Body: { source_label?, source_id?, rows: [...] }
// Each row: { title, description?, sale_price?, rent_price?,
//             property_category?, property_type?, bedrooms?, bathrooms?,
//             floor_area?, lot_area?, parking_spaces?,
//             organization_slug, broker_email, city_slug, barangay_slug?,
//             building_name?, image_urls?[] }
//
// Two-step staging mirror of mig 38's broker_import. Stages rows
// for review; no listings are created at this step. Admin reviews
// + clicks Process to run the matching RPC.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { serverSupabaseUser } from '../../../../utils/sbUser'

const PROPERTY_CATEGORIES = ['residential', 'commercial', 'land', 'industrial'] as const
const UUID_RE = /^[0-9a-f-]{36}$/i

const rowSchema = z.object({
  title:             z.string().trim().min(3).max(200),
  description:       z.string().trim().max(10_000).optional().nullable(),
  property_category: z.enum(PROPERTY_CATEGORIES).optional(),
  property_type:     z.string().trim().max(64).optional(),
  sale_price:        z.coerce.number().int().min(0).optional().nullable(),
  rent_price:        z.coerce.number().int().min(0).optional().nullable(),
  bedrooms:          z.coerce.number().int().min(0).max(99).optional().nullable(),
  bathrooms:         z.coerce.number().int().min(0).max(99).optional().nullable(),
  floor_area:        z.coerce.number().int().min(0).max(32_000).optional().nullable(),
  lot_area:          z.coerce.number().int().min(0).optional().nullable(),
  parking_spaces:    z.coerce.number().int().min(0).max(99).optional().nullable(),
  organization_slug: z.string().trim().min(2).max(64),
  broker_email:      z.string().trim().email().max(254),
  city_slug:         z.string().trim().min(2).max(64),
  barangay_slug:     z.string().trim().min(2).max(64).optional().nullable(),
  building_name:     z.string().trim().max(200).optional().nullable(),
  image_urls:        z.array(z.string().url().max(2048)).max(50).optional(),
  raw:               z.record(z.any()).optional(),
})

const bodySchema = z.object({
  source_label: z.string().trim().max(120).optional(),
  // listing_sources.id is bigint â€” accept numeric.
  source_id:    z.coerce.number().int().positive().optional().nullable(),
  rows:         z.array(rowSchema).min(1).max(2000),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    const b = body as z.infer<typeof bodySchema>

    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Service role for the bulk insert path â€” RLS policies allow it
    // for admins anyway, but the bulk path is cleaner via the
    // service-role client.
    const supabase = getServerSupabaseAdmin()

    const { data: batch, error: batchErr } = await (supabase as any)
      .from('listing_import_batches')
      .insert({
        source_label: b.source_label ?? null,
        source_id:    b.source_id ?? null,
        uploaded_by:  user.id,
        total_rows:   b.rows.length,
      })
      .select('id, source_label, total_rows, created_at, status')
      .single()
    if (batchErr) throw createError({ statusCode: 500, statusMessage: batchErr.message })

    // Lowercase slugs / email at staging so resolution is consistent.
    const rowInserts = b.rows.map((r, i) => ({
      batch_id:          batch.id,
      row_number:        i + 1,
      title:             r.title.trim(),
      description:       r.description?.trim() || null,
      property_category: r.property_category ?? null,
      property_type:     r.property_type?.trim().toLowerCase() || null,
      sale_price:        r.sale_price ?? null,
      rent_price:        r.rent_price ?? null,
      bedrooms:          r.bedrooms ?? null,
      bathrooms:         r.bathrooms ?? null,
      floor_area:        r.floor_area ?? null,
      lot_area:          r.lot_area ?? null,
      parking_spaces:    r.parking_spaces ?? null,
      organization_slug: r.organization_slug.trim().toLowerCase(),
      broker_email:      r.broker_email.trim().toLowerCase(),
      city_slug:         r.city_slug.trim().toLowerCase(),
      barangay_slug:     r.barangay_slug?.trim().toLowerCase() || null,
      building_name:     r.building_name?.trim() || null,
      image_urls:        r.image_urls ?? [],
      raw:               r.raw ?? {},
    }))

    const { error: rowsErr } = await (supabase as any)
      .from('listing_import_rows')
      .insert(rowInserts)
    if (rowsErr) {
      await (supabase as any).from('listing_import_batches').delete().eq('id', batch.id)
      throw createError({ statusCode: 500, statusMessage: rowsErr.message })
    }

    await (supabase as any).rpc('log_activity', {
      p_action:   'listing.import_batch_created',
      p_metadata: {
        batch_id:     batch.id,
        source_label: batch.source_label,
        row_count:    b.rows.length,
      },
    }).catch((err: any) =>
      console.warn('[admin/listings/import.post] log_activity failed', err),
    )

    return { batch }
  },
})
