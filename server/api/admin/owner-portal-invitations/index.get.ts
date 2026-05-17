// Admin: list owner portal invitations.
//
// GET /api/admin/owner-portal-invitations?property_owner_id=&status=&limit=&offset=
//
// Token hashes are NEVER returned. Mirror of the tenant list endpoint.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  property_owner_id: z.string().uuid().optional(),
  status: z.enum(['active', 'accepted', 'revoked', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

type Row = {
  id: string
  property_owner_id: string
  invite_email: string
  expires_at: string
  accepted_at: string | null
  accepted_by_user_id: string | null
  revoked_at: string | null
  revoked_reason: string | null
  created_by: string | null
  created_at: string
}

function deriveStatus(row: Row): 'active' | 'accepted' | 'revoked' | 'expired' {
  if (row.accepted_at) return 'accepted'
  if (row.revoked_at) return 'revoked'
  if (new Date(row.expires_at).getTime() < Date.now()) return 'expired'
  return 'active'
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'manager')

    const admin = getServerSupabaseAdmin()

    let q: any = (admin as any)
      .from('owner_portal_invitations')
      .select(
        'id, property_owner_id, invite_email, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_reason, created_by, created_at',
        { count: 'estimated' },
      )
      .order('created_at', { ascending: false })
      .range(query.offset!, query.offset! + query.limit! - 1)

    if (query.property_owner_id) {
      q = q.eq('property_owner_id', query.property_owner_id)
    }

    if (query.status === 'accepted') {
      q = q.not('accepted_at', 'is', null)
    } else if (query.status === 'revoked') {
      q = q.not('revoked_at', 'is', null)
    } else if (query.status === 'active') {
      q = q.is('accepted_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString())
    } else if (query.status === 'expired') {
      q = q.is('accepted_at', null).is('revoked_at', null).lte('expires_at', new Date().toISOString())
    }

    const { data, error, count } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const rows = ((data ?? []) as Row[]).map((r) => ({
      ...r,
      status: deriveStatus(r),
    }))

    return {
      rows,
      total: count ?? rows.length,
      limit: query.limit,
      offset: query.offset,
    }
  },
})
