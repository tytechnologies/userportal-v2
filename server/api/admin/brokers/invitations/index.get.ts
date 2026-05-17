// Admin — list broker invitations.
//
// GET /api/admin/brokers/invitations?status=pending|accepted|declined|expired&page=&page_size=
//
// Resolves organization name + branch name + invited_by name
// server-side. Includes link_shared_at + email_sent_at columns
// (mig 41) so the UI can show distribution state.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { requireRole } from '~~/server/utils/rbac'

const querySchema = z.object({
  status:    z.enum(['pending', 'accepted', 'declined', 'expired']).optional(),
  page:      z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    await requireRole(event, 'admin')
    setHeader(event, 'Cache-Control', 'no-store')
    const q = query as z.infer<typeof querySchema>

    const supabase = await serverSupabaseClient(event)

    const from = (q.page - 1) * q.page_size
    const to = from + q.page_size - 1

    // NOTE: token is intentionally returned to the admin UI (the
    // admin builds the share link from it). Admin-only RLS on this
    // table prevents leakage to non-admin clients.
    let req: any = (supabase as any)
      .from('broker_invitations')
      .select(
        'id, email, full_name, mobile_number, organization_id, branch_id, ' +
        'org_role, token, status, expires_at, accepted_at, declined_at, ' +
        'link_shared_at, email_sent_at, email_send_error, ' +
        'invited_by, created_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(from, to)
    if (q.status) req = req.eq('status', q.status)

    const { data: invs, error, count } = await req
    if (error) throw createError({ statusCode: 500, statusMessage: error.message })

    if (!invs || invs.length === 0) {
      return { invitations: [], total: count ?? 0, page: q.page, page_size: q.page_size }
    }

    const orgIds    = Array.from(new Set(invs.map((i: any) => i.organization_id).filter(Boolean)))
    const branchIds = Array.from(new Set(invs.map((i: any) => i.branch_id).filter(Boolean)))
    const inviterIds = Array.from(new Set(invs.map((i: any) => i.invited_by).filter(Boolean)))

    const [orgRes, branchRes, inviterRes] = await Promise.all([
      orgIds.length > 0
        ? (supabase as any).from('organizations').select('id, name, slug').in('id', orgIds)
        : Promise.resolve({ data: [] }),
      branchIds.length > 0
        ? (supabase as any).from('organization_branches').select('id, name, slug').in('id', branchIds)
        : Promise.resolve({ data: [] }),
      inviterIds.length > 0
        ? (supabase as any).from('profiles').select('id, full_name, email').in('id', inviterIds)
        : Promise.resolve({ data: [] }),
    ])

    const orgMap     = new Map<string, any>((orgRes.data ?? []).map((r: any) => [r.id, r]))
    const branchMap  = new Map<string, any>((branchRes.data ?? []).map((r: any) => [r.id, r]))
    const inviterMap = new Map<string, any>((inviterRes.data ?? []).map((r: any) => [r.id, r]))

    const enriched = invs.map((i: any) => ({
      ...i,
      organization: i.organization_id ? orgMap.get(i.organization_id) ?? null : null,
      branch:       i.branch_id       ? branchMap.get(i.branch_id) ?? null : null,
      inviter:      i.invited_by      ? inviterMap.get(i.invited_by) ?? null : null,
      // Auto-flag expired (cron may not have fired yet).
      effective_status:
        i.status === 'pending' && i.expires_at && new Date(i.expires_at) < new Date()
          ? 'expired'
          : i.status,
    }))

    return { invitations: enriched, total: count ?? 0, page: q.page, page_size: q.page_size }
  },
})
