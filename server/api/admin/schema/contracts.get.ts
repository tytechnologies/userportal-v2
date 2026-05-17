// Schema governance — contract registry list.
//
// GET /api/admin/schema/contracts
// Auth: admin (governance.read permission via RLS).
//
// Read-only browse of the registry. Powers the "Schema Registry"
// section of the governance dashboard and is the entry point for
// "what does the platform consider a cross-repo contract".

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')

    const supabase = await serverSupabaseClient(event)

    // Pull the registry + pre-computed health view in parallel.
    // governance_contract_health is a one-row-per-contract summary
    // with active drift counts; the join lets the UI render status
    // chips without re-running the full drift check.
    const [registryRes, healthRes] = await Promise.all([
      (supabase as any)
        .from('governance_schema_contracts')
        .select('id, contract_name, contract_type, owner_repo, consumers, description, is_public, deprecated_at, sunset_at, created_at')
        .order('contract_name'),
      (supabase as any)
        .from('governance_contract_health')
        .select('contract_name, last_drift_at, active_drift_count'),
    ])

    if (registryRes.error) {
      throw createError({ statusCode: 500, statusMessage: registryRes.error.message })
    }

    const healthByName = new Map<string, any>()
    for (const h of healthRes.data ?? []) {
      healthByName.set(h.contract_name, h)
    }

    const contracts = (registryRes.data ?? []).map((c: any) => ({
      ...c,
      health: healthByName.get(c.contract_name) ?? {
        last_drift_at: null,
        active_drift_count: 0,
      },
    }))

    return { contracts }
  },
})
