// Admin — create a new partner source + auto-mint a vault-stored bearer.
//
// POST /api/admin/sources
// Body: { slug, display_name, base_url?, staleness_ttl_hours?, notes? }
//
// Atomic flow (best-effort cleanup if step 2 fails):
//   1. INSERT listing_sources (column default auto-generates a plaintext
//      secret; we throw that away immediately).
//   2. rotate_listing_source_secret(new_id) — generates a fresh vault-
//      backed secret. Returns the bearer in plaintext ONCE.
//
// Returns:
//   { source: {...}, bearer: '<64-hex>' }
//
// The bearer is the only opportunity to capture it — the UI displays
// + copies, then never sees it again.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/

const bodySchema = z.object({
  slug:                z.string().trim().min(1).max(80).regex(SLUG_RE, 'lowercase letters / digits / _ / -; first char letter or digit'),
  display_name:        z.string().trim().min(1).max(200),
  base_url:            z.string().trim().url().max(500).optional().nullable(),
  staleness_ttl_hours: z.coerce.number().int().min(1).max(8760).optional(),
  notes:               z.string().trim().max(2000).optional().nullable(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')

    const b = body as z.infer<typeof bodySchema>
    const supabase = await serverSupabaseClient(event)

    // Step 1 — insert. The column default for ingest_secret generates
    // a 256-bit hex; we'll overwrite it via rotate immediately.
    const { data: inserted, error: insErr } = await (supabase as any)
      .from('listing_sources')
      .insert({
        slug:                b.slug,
        display_name:        b.display_name,
        base_url:            b.base_url ?? null,
        staleness_ttl_hours: b.staleness_ttl_hours ?? 168,
        notes:               b.notes ?? null,
      })
      .select(
        'id, slug, display_name, base_url, enabled, staleness_ttl_hours, ' +
          'last_ingested_at, notes, created_at, updated_at',
      )
      .single()

    if (insErr) {
      // Unique-violation on slug = 409 (clearer for the UI than a generic 500).
      if ((insErr as any).code === '23505') {
        throw createError({ statusCode: 409, statusMessage: `Source slug "${b.slug}" already exists` })
      }
      throw createError({ statusCode: 500, statusMessage: insErr.message })
    }

    // Step 2 — rotate the auto-generated secret straight into vault.
    // If this fails we delete the row to avoid orphaning a half-set-up
    // source the operator might not be able to use.
    const { data: bearer, error: rotateErr } = await (supabase as any)
      .rpc('rotate_listing_source_secret', { p_id: inserted.id })

    if (rotateErr) {
      logger.error(
        { err: rotateErr.message, source_id: inserted.id, op: 'admin.sources.create' },
        'source_create_vault_rotate_failed',
      )
      // Best-effort cleanup. If this also fails the operator gets a
      // half-created source visible in /admin/sources — surface that
      // explicitly so they can delete or retry rotation.
      await (supabase as any)
        .from('listing_sources')
        .delete()
        .eq('id', inserted.id)
        .then((r: any) => {
          if (r.error) logger.warn(
            { err: r.error.message, source_id: inserted.id },
            'source_create_cleanup_failed',
          )
        })
      throw createError({
        statusCode: 500,
        statusMessage: `Source created but vault rotation failed: ${rotateErr.message}`,
      })
    }

    setResponseStatus(event, 201)
    return {
      source: {
        ...inserted,
        secret_state: 'vault',
      },
      bearer: bearer as string,
    }
  },
})
