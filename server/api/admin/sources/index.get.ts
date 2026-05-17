// Admin — list of all partner sources for the CRUD page.
//
// GET /api/admin/sources
//
// Returns every listing_sources row joined with its current vault
// state (vault-migrated / plaintext / unconfigured). Companion to
// /api/admin/sources/health (which adds the SLO rollup); this
// endpoint is the simpler list view for CRUD operations.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')

    const supabase = await serverSupabaseClient(event)

    const { data, error } = await (supabase as any)
      .from('listing_sources')
      .select(
        'id, slug, display_name, base_url, enabled, staleness_ttl_hours, ' +
          'ingest_secret, ingest_secret_vault_id, last_ingested_at, notes, ' +
          'created_at, updated_at',
      )
      .order('id', { ascending: true })

    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    const sources = (data ?? []).map((s: any) => ({
      id: s.id,
      slug: s.slug,
      display_name: s.display_name,
      base_url: s.base_url,
      enabled: s.enabled,
      staleness_ttl_hours: s.staleness_ttl_hours,
      // NEVER ship the raw secret. The state flag is enough for the UI.
      secret_state:
        s.ingest_secret_vault_id != null
          ? 'vault'
          : s.ingest_secret
            ? 'plaintext'
            : 'unconfigured',
      last_ingested_at: s.last_ingested_at,
      notes: s.notes,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }))

    return { sources }
  },
})
