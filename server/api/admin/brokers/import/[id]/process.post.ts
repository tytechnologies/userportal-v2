// Admin — process a staged broker import batch.
//
// POST /api/admin/brokers/import/:id/process
// Calls process_broker_import_batch(:id) RPC. Returns counts.

import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../../../../../utils/sbUser'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { enqueueInvitationEmail } from '~~/server/repositories/orgInvitations.repo'
import { logger } from '~~/server/utils/logger'

const UUID_RE = /^[0-9a-f-]{36}$/i

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await requireRole(event, 'admin')

    const id = getRouterParam(event, 'id') || ''
    if (!UUID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid batch id' })
    }

    const supabase = await serverSupabaseClient(event)

    // Watermark BEFORE the RPC so we can find rows it created.
    const startedAt = new Date().toISOString()

    const { data, error } = await (supabase as any).rpc('process_broker_import_batch', {
      p_batch_id: id,
    })
    if (error) {
      const status = error.code === '42501' ? 403
                  : error.code === '42704' ? 404
                  : 500
      throw createError({ statusCode: status, statusMessage: error.message })
    }

    // RPC returns a single-row table.
    const summary = Array.isArray(data) ? data[0] : data

    await (supabase as any).rpc('log_activity', {
      p_action:   'broker.import_batch_processed',
      p_metadata: { batch_id: id, ...summary },
    }).catch((err: any) =>
      console.warn('[admin/brokers/import/:id/process] log_activity failed', err),
    )

    // Email fan-out for any invitations created by this batch run.
    // process_broker_import_batch creates broker_invitations rows for
    // 'invitation_created' rows; we find them by created_at watermark
    // and enqueue org.invitation_sent (idempotent dedupe per row).
    enqueueBulkInvitationEmails(startedAt).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), batch_id: id },
        'broker_import_email_enqueue_failed',
      )
    })

    return { summary }
  },
})

async function enqueueBulkInvitationEmails(sinceIso: string): Promise<void> {
  const admin = getServerSupabaseAdmin()
  const { data: invitations } = await (admin as any)
    .from('broker_invitations')
    .select('id, email, full_name, organization_id, org_role, token, invited_by, notes')
    .eq('status', 'pending')
    .gte('created_at', sinceIso)
  if (!invitations || invitations.length === 0) return

  for (const inv of invitations) {
    await enqueueInvitationEmail({
      invitationId: inv.id,
      organizationId: inv.organization_id,
      email: inv.email,
      token: inv.token,
      orgRole: inv.org_role,
      invitedBy: inv.invited_by ?? null,
      fullName: inv.full_name ?? null,
      message: inv.notes ?? null,
    })
  }
}
