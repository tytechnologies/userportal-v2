// Render an owner statement as PDF.
//
// GET /api/admin/owner-statements/[id]/pdf
//
// Mirror of the tenant endpoint but pulls from owner_statements +
// property_owners.

import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { requireRole } from '~~/server/utils/rbac'
import { logger } from '~~/server/utils/logger'
import { renderOwnerStatementPdf } from '~~/server/utils/statementPdf'

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager')

  const id = getRouterParam(event, 'id')
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid statement id' })
  }

  const admin = getServerSupabaseAdmin()

  const { data: statement, error: stErr } = await (admin as any)
    .from('owner_statements')
    .select(
      'id, statement_no, owner_id, period_start, period_end, currency, ' +
        'rent_collected_minor, dues_collected_minor, expenses_minor, management_fee_minor, ' +
        'tax_withheld_minor, net_disbursement_minor, line_items, status, issued_at, ' +
        'disbursed_at, voided_at, void_reason, metadata, created_at',
    )
    .eq('id', id)
    .maybeSingle()
  if (stErr) {
    logger.error(
      { err: stErr.message, op: 'admin.owner_statements.pdf', id },
      'owner_statement_pdf_lookup_failed',
    )
    throw createError({ statusCode: 500, statusMessage: stErr.message })
  }
  if (!statement) {
    throw createError({ statusCode: 404, statusMessage: 'Statement not found' })
  }

  let owner: { name: string | null; email: string | null; tax_id: string | null } | null = null
  if (statement.owner_id) {
    const { data: po } = await (admin as any)
      .from('property_owners')
      .select('external_name, external_email, tax_id')
      .eq('id', statement.owner_id)
      .maybeSingle()
    if (po) {
      owner = { name: po.external_name, email: po.external_email, tax_id: po.tax_id }
    }
  }

  let pdfBytes: Uint8Array
  try {
    pdfBytes = await renderOwnerStatementPdf({ statement, owner })
  } catch (err: any) {
    logger.error(
      { err: err?.message, op: 'admin.owner_statements.pdf.render', id },
      'owner_statement_pdf_render_failed',
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

  return Buffer.from(pdfBytes)
})
