// Admin — stage a CSV broker import batch.
//
// POST /api/admin/brokers/import
// Body: { source_label?: string, rows: [
//   { email, full_name?, mobile_number?, organization_slug, branch_slug?, org_role? }
// ]}
//
// Two-step flow: this endpoint STAGES rows. Admin then reviews
// the batch, and triggers POST /:id/process to actually match
// emails / create invitations. No DB mutation against profiles or
// memberships happens at staging time.

import { z } from 'zod'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'

const ROLES = [
  'brokerage_owner', 'branch_manager', 'team_lead',
  'senior_agent', 'junior_agent', 'assistant',
] as const

const rowSchema = z.object({
  email:             z.string().trim().email().max(254),
  full_name:         z.string().trim().max(120).optional().nullable(),
  mobile_number:     z.string().trim().max(40).optional().nullable(),
  organization_slug: z.string().trim().min(2).max(64),
  branch_slug:       z.string().trim().min(2).max(64).optional().nullable(),
  org_role:          z.enum(ROLES).optional(),
})

const bodySchema = z.object({
  source_label: z.string().trim().max(120).optional(),
  rows:         z.array(rowSchema).min(1).max(5000),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    await requireRole(event, 'admin')
    const b = body as z.infer<typeof bodySchema>

    // Service-role: broker_import_batches RLS gates inserts to admins,
    // but we want a single chokepoint that doesn't depend on RLS for
    // the batch + per-row inserts (cleaner for the bulk path).
    const supabase = getServerSupabaseAdmin()

    // Resolve uploader from session.
    const event2 = event
    // Use the local sbUser wrapper. The @nuxtjs/supabase v2 helper at
    // '#supabase/server/serverSupabaseUser' now returns JWT claims
    // (.sub) instead of the legacy User shape (.id); this wrapper goes
    // through client.auth.getUser() and keeps the User shape stable.
    const { serverSupabaseUser } = await import('../../../../utils/sbUser')
    const user = await serverSupabaseUser(event2)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Create the batch.
    const { data: batch, error: batchErr } = await (supabase as any)
      .from('broker_import_batches')
      .insert({
        source_label: b.source_label ?? null,
        uploaded_by:  user.id,
        total_rows:   b.rows.length,
      })
      .select('id, source_label, total_rows, created_at, status')
      .single()
    if (batchErr) throw createError({ statusCode: 500, statusMessage: batchErr.message })

    // Build the row inserts. Email lowercased + trimmed at staging
    // time so dedup compares apples-to-apples.
    const rowInserts = b.rows.map((r, i) => ({
      batch_id:          batch.id,
      row_number:        i + 1,
      email:             r.email.trim().toLowerCase(),
      full_name:         r.full_name?.trim() || null,
      mobile_number:     r.mobile_number?.trim() || null,
      organization_slug: r.organization_slug.trim().toLowerCase(),
      branch_slug:       r.branch_slug?.trim().toLowerCase() || null,
      org_role:          r.org_role ?? 'senior_agent',
    }))

    const { error: rowsErr } = await (supabase as any)
      .from('broker_import_rows')
      .insert(rowInserts)
    if (rowsErr) {
      // Best-effort cleanup: drop the batch we just created so the
      // admin doesn't see an empty stub.
      await (supabase as any)
        .from('broker_import_batches')
        .delete()
        .eq('id', batch.id)
      throw createError({ statusCode: 500, statusMessage: rowsErr.message })
    }

    await (supabase as any).rpc('log_activity', {
      p_action:   'broker.import_batch_created',
      p_metadata: {
        batch_id:     batch.id,
        source_label: batch.source_label,
        row_count:    b.rows.length,
      },
    }).catch((err: any) =>
      console.warn('[admin/brokers/import.post] log_activity failed', err),
    )

    return { batch }
  },
})
