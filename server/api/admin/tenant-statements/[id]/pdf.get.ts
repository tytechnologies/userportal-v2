// Render a tenant statement as PDF.
//
// GET /api/admin/tenant-statements/[id]/pdf
//
// Returns application/pdf with Content-Disposition: inline so most
// browsers preview in a tab; users can still Save As to download.
// Filename uses the statement_no for predictable archival.
//
// RLS still permits tenant-side reads (lease_parties.user_id check)
// once the public tenant portal lands; this endpoint stays admin-only
// for now via requireRole.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'
import { renderTenantStatementPdf } from '~~/server/utils/statementPdf'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager')

  const id = getRouterParam(event, 'id')
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid statement id' })
  }

  const admin = getServerSupabaseAdmin()

  // Statement + lease + unit + primary tenant party in one round.
  const { data: statement, error: stErr } = await (admin as any)
    .from('tenant_statements')
    .select(
      'id, statement_no, lease_id, tenant_party_id, period_start, period_end, currency, ' +
        'rent_billed_minor, other_charges_minor, payments_received_minor, balance_due_minor, ' +
        'line_items, status, issued_at, due_at, paid_at, voided_at, void_reason, metadata, created_at',
    )
    .eq('id', id)
    .maybeSingle()
  if (stErr) {
    logger.error(
      { err: stErr.message, op: 'admin.tenant_statements.pdf', id },
      'tenant_statement_pdf_lookup_failed',
    )
    throw createError({ statusCode: 500, statusMessage: stErr.message })
  }
  if (!statement) {
    throw createError({ statusCode: 404, statusMessage: 'Statement not found' })
  }

  // Lease + unit context.
  const { data: lease } = await (admin as any)
    .from('leases')
    .select('id, unit_id, rent_minor, currency')
    .eq('id', statement.lease_id)
    .maybeSingle()

  let unit: { unit_number: string | null; building_id: string | null } | null = null
  if (lease?.unit_id) {
    const { data: u } = await (admin as any)
      .from('units')
      .select('unit_number, building_id')
      .eq('id', lease.unit_id)
      .maybeSingle()
    unit = u ?? null
  }

  // Primary tenant party — prefer the explicit tenant_party_id, else
  // fall back to the first tenant on the lease.
  let tenantParty: { name: string | null; email: string | null; user_id: string | null } | null = null
  if (statement.tenant_party_id) {
    const { data: lp } = await (admin as any)
      .from('lease_parties')
      .select('user_id, contact_id, external_name, external_email')
      .eq('id', statement.tenant_party_id)
      .maybeSingle()
    if (lp) {
      tenantParty = {
        name: lp.external_name,
        email: lp.external_email,
        user_id: lp.user_id,
      }
    }
  }
  if (!tenantParty && statement.lease_id) {
    const { data: lp } = await (admin as any)
      .from('lease_parties')
      .select('user_id, contact_id, external_name, external_email')
      .eq('lease_id', statement.lease_id)
      .eq('role', 'tenant')
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (lp) {
      tenantParty = {
        name: lp.external_name,
        email: lp.external_email,
        user_id: lp.user_id,
      }
    }
  }

  let pdfBytes: Uint8Array
  try {
    pdfBytes = await renderTenantStatementPdf({
      statement,
      lease,
      tenant: tenantParty,
      unit,
    })
  } catch (err: any) {
    logger.error(
      { err: err?.message, op: 'admin.tenant_statements.pdf.render', id },
      'tenant_statement_pdf_render_failed',
    )
    throw createError({
      statusCode: 500,
      statusMessage: `PDF render failed: ${err?.message ?? 'unknown'}`,
    })
  }

  setHeader(event, 'content-type', 'application/pdf')
  setHeader(
    event,
    'content-disposition',
    `inline; filename="${statement.statement_no}.pdf"`,
  )
  setHeader(event, 'cache-control', 'private, max-age=0, must-revalidate')

  // Return the bytes. h3 handles Buffer / Uint8Array natively.
  return Buffer.from(pdfBytes)
})
