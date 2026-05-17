// Admin — migrate a source's plaintext secret into vault.
//
// POST /api/admin/sources/:id/migrate-to-vault
//
// Idempotent — calling on an already-vault-migrated source returns
// the existing vault_id. RAISES if the source has no plaintext to
// migrate (operator should rotate instead).

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')

    const sourceId = Number(getRouterParam(event, 'id') || '0')
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid source id' })
    }

    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any)
      .rpc('migrate_listing_source_to_vault', { p_source_id: sourceId })

    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: error.message })
      if (code === '42704') throw createError({ statusCode: 404, statusMessage: error.message })
      if (code === '22023') throw createError({ statusCode: 422, statusMessage: error.message })
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return { vault_id: data as string }
  },
})
