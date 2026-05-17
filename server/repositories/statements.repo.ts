// Statements repository â€” owner_statements + tenant_statements.
//
// Both follow the same lifecycle:
//   draft â†’ issued â†’ (paid | disbursed | overdue) | void
// Once issued, economic fields are locked by the statement_post_guard
// trigger; corrections require void + new statement.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { enqueueOutboundEmail, absoluteUrl } from '~~/server/utils/outboundEmail'

const OWNER_STMT_SELECT =
  'id, owner_id, statement_no, period_start, period_end, currency, ' +
  'rent_collected_minor, dues_collected_minor, expenses_minor, ' +
  'management_fee_minor, tax_withheld_minor, net_disbursement_minor, ' +
  'line_items, status, issued_at, disbursed_at, voided_at, void_reason, ' +
  'external_reference, metadata, created_at, updated_at'

const TENANT_STMT_SELECT =
  'id, lease_id, tenant_party_id, statement_no, period_start, period_end, ' +
  'currency, rent_billed_minor, other_charges_minor, payments_received_minor, ' +
  'balance_due_minor, line_items, status, issued_at, due_at, paid_at, ' +
  'voided_at, void_reason, metadata, created_at, updated_at'

export type OwnerStatementInput = {
  period_start: string
  period_end: string
  currency?: string
  rent_collected_minor?: number
  dues_collected_minor?: number
  expenses_minor?: number
  management_fee_minor?: number
  tax_withheld_minor?: number
  net_disbursement_minor?: number
  line_items?: Array<Record<string, unknown>>
  external_reference?: string | null
  metadata?: Record<string, unknown>
}

export type TenantStatementInput = {
  tenant_party_id?: string | null
  period_start: string
  period_end: string
  currency?: string
  rent_billed_minor?: number
  other_charges_minor?: number
  payments_received_minor?: number
  balance_due_minor?: number
  line_items?: Array<Record<string, unknown>>
  due_at?: string | null
  metadata?: Record<string, unknown>
}

export const statementsRepo = {
  // ===== owner_statements =====

  async listOwnerStatements({
    event,
    ownerId,
  }: {
    event: H3Event
    ownerId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('owner_statements')
      .select(OWNER_STMT_SELECT)
      .eq('owner_id', ownerId)
      .order('period_start', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async createOwnerStatement({
    event,
    ownerId,
    input,
  }: {
    event: H3Event
    ownerId: string
    input: OwnerStatementInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const { data, error } = await (client as any)
      .from('owner_statements')
      .insert({
        owner_id: ownerId,
        period_start: input.period_start,
        period_end: input.period_end,
        currency: input.currency ?? 'PHP',
        rent_collected_minor: input.rent_collected_minor ?? 0,
        dues_collected_minor: input.dues_collected_minor ?? 0,
        expenses_minor: input.expenses_minor ?? 0,
        management_fee_minor: input.management_fee_minor ?? 0,
        tax_withheld_minor: input.tax_withheld_minor ?? 0,
        net_disbursement_minor: input.net_disbursement_minor ?? 0,
        line_items: input.line_items ?? [],
        external_reference: input.external_reference ?? null,
        metadata: input.metadata ?? {},
        created_by: user.id,
      })
      .select(OWNER_STMT_SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'statements.createOwnerStatement', ownerId },
        'owner_statement_create_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async patchOwnerStatement({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: Partial<OwnerStatementInput> & {
      status?: 'void'
      void_reason?: string | null
    }
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'period_start', 'period_end', 'currency',
      'rent_collected_minor', 'dues_collected_minor', 'expenses_minor',
      'management_fee_minor', 'tax_withheld_minor', 'net_disbursement_minor',
      'line_items', 'external_reference', 'metadata', 'status', 'void_reason',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('owner_statements')
      .update(updates)
      .eq('id', id)
      .select(OWNER_STMT_SELECT)
      .single()
    if (error) {
      const msg = error.message ?? ''
      if (msg.includes('locked once issued') || msg.includes('cannot be modified')) {
        throw createError({ statusCode: 409, statusMessage: msg })
      }
      throw createError({ statusCode: 500, statusMessage: msg })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Statement not found' })
    }
    return data
  },

  async issueOwnerStatement({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('statement_mark_issued', {
      p_statement_id: id,
      p_kind: 'owner',
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'statement.owner_issued',
      entity: 'building',
      entityId: null,
      metadata: { statement_id: id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'statement_issue_activity_log_failed',
      )
    })

    enqueueOwnerStatementEmail(id).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'owner_statement_email_enqueue_failed',
      )
    })

    return { statement_id: data ?? id }
  },

  // ===== tenant_statements =====

  async listTenantStatements({
    event,
    leaseId,
  }: {
    event: H3Event
    leaseId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('tenant_statements')
      .select(TENANT_STMT_SELECT)
      .eq('lease_id', leaseId)
      .order('period_start', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async createTenantStatement({
    event,
    leaseId,
    input,
  }: {
    event: H3Event
    leaseId: string
    input: TenantStatementInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const { data, error } = await (client as any)
      .from('tenant_statements')
      .insert({
        lease_id: leaseId,
        tenant_party_id: input.tenant_party_id ?? null,
        period_start: input.period_start,
        period_end: input.period_end,
        currency: input.currency ?? 'PHP',
        rent_billed_minor: input.rent_billed_minor ?? 0,
        other_charges_minor: input.other_charges_minor ?? 0,
        payments_received_minor: input.payments_received_minor ?? 0,
        balance_due_minor: input.balance_due_minor ?? 0,
        line_items: input.line_items ?? [],
        due_at: input.due_at ?? null,
        metadata: input.metadata ?? {},
        created_by: user.id,
      })
      .select(TENANT_STMT_SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'statements.createTenantStatement', leaseId },
        'tenant_statement_create_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async patchTenantStatement({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: Partial<TenantStatementInput> & {
      status?: 'paid' | 'overdue' | 'void'
      void_reason?: string | null
    }
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'period_start', 'period_end', 'currency',
      'rent_billed_minor', 'other_charges_minor',
      'payments_received_minor', 'balance_due_minor',
      'line_items', 'due_at', 'metadata',
      'status', 'void_reason',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('tenant_statements')
      .update(updates)
      .eq('id', id)
      .select(TENANT_STMT_SELECT)
      .single()
    if (error) {
      const msg = error.message ?? ''
      if (msg.includes('locked once issued') || msg.includes('cannot be modified')) {
        throw createError({ statusCode: 409, statusMessage: msg })
      }
      throw createError({ statusCode: 500, statusMessage: msg })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Statement not found' })
    }
    return data
  },

  async issueTenantStatement({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('statement_mark_issued', {
      p_statement_id: id,
      p_kind: 'tenant',
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'statement.tenant_issued',
      entity: 'building',
      entityId: null,
      metadata: { statement_id: id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'statement_issue_activity_log_failed',
      )
    })

    enqueueTenantStatementEmail(id).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'tenant_statement_email_enqueue_failed',
      )
    })

    return { statement_id: data ?? id }
  },
}

// =====================================================================
// Helpers: enqueue statement-issued emails
// =====================================================================

async function enqueueOwnerStatementEmail(statementId: string): Promise<void> {
  const admin = getServerSupabaseAdmin()

  const { data: stmt } = await (admin as any)
    .from('owner_statements')
    .select(
      'id, owner_id, statement_no, currency, period_start, period_end, ' +
        'net_disbursement_minor',
    )
    .eq('id', statementId)
    .maybeSingle()
  if (!stmt) return

  const { data: owner } = await (admin as any)
    .from('property_owners')
    .select('user_id, external_email, external_name')
    .eq('id', stmt.owner_id)
    .maybeSingle()
  if (!owner) return

  let toEmail: string | null = owner.external_email ?? null
  let toName: string | null = owner.external_name ?? null
  if (!toEmail && owner.user_id) {
    const { data: profile } = await (admin as any)
      .from('profiles')
      .select('email, full_name')
      .eq('id', owner.user_id)
      .maybeSingle()
    toEmail = profile?.email ?? null
    toName = profile?.full_name ?? toName
  }
  if (!toEmail) return

  const phpAmount = (Number(stmt.net_disbursement_minor) / 100).toLocaleString(
    'en-PH',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  )

  await enqueueOutboundEmail({
    to: toEmail,
    toName,
    recipientUserId: owner.user_id ?? null,
    templateKind: 'statement.owner_issued',
    subject: `Owner statement ${stmt.statement_no} is ready`,
    templateInput: {
      recipientName: toName,
      title: stmt.statement_no,
      body:
        `Period ${stmt.period_start} to ${stmt.period_end} Â· ` +
        `Net disbursement: ${stmt.currency} ${phpAmount}`,
      hrefAbsolute: absoluteUrl(`/owner-statements/${stmt.id}`),
    },
    dedupeKey: `owner-statement-issued:${stmt.id}`,
    referenceKind: 'owner_statement',
    referenceId: stmt.id,
  })
}


async function enqueueTenantStatementEmail(statementId: string): Promise<void> {
  const admin = getServerSupabaseAdmin()

  const { data: stmt } = await (admin as any)
    .from('tenant_statements')
    .select(
      'id, lease_id, tenant_party_id, statement_no, currency, period_start, ' +
        'period_end, balance_due_minor, due_at',
    )
    .eq('id', statementId)
    .maybeSingle()
  if (!stmt) return

  // Resolve recipients: specific tenant_party (if set) OR all tenants on the lease.
  let partyQ = (admin as any)
    .from('lease_parties')
    .select('id, user_id, external_email, external_name')
    .eq('lease_id', stmt.lease_id)
    .eq('role', 'tenant')
  if (stmt.tenant_party_id) partyQ = partyQ.eq('id', stmt.tenant_party_id)

  const { data: parties } = await partyQ
  if (!parties || parties.length === 0) return

  const phpAmount = (Number(stmt.balance_due_minor) / 100).toLocaleString(
    'en-PH',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  )

  for (const p of parties) {
    let toEmail: string | null = p.external_email ?? null
    let toName: string | null = p.external_name ?? null
    if (!toEmail && p.user_id) {
      const { data: profile } = await (admin as any)
        .from('profiles')
        .select('email, full_name')
        .eq('id', p.user_id)
        .maybeSingle()
      toEmail = profile?.email ?? null
      toName = profile?.full_name ?? toName
    }
    if (!toEmail) continue

    await enqueueOutboundEmail({
      to: toEmail,
      toName,
      recipientUserId: p.user_id ?? null,
      templateKind: 'statement.tenant_issued',
      subject: `Statement ${stmt.statement_no} is ready`,
      templateInput: {
        recipientName: toName,
        title: stmt.statement_no,
        body:
          `Period ${stmt.period_start} to ${stmt.period_end} Â· ` +
          `Balance due: ${stmt.currency} ${phpAmount}`,
        hrefAbsolute: absoluteUrl(`/tenant-statements/${stmt.id}`),
      },
      // dedupe key includes party id so multi-tenant leases get
      // one email per tenant (not duplicate-suppressed).
      dedupeKey: `tenant-statement-issued:${stmt.id}:${p.id}`,
      referenceKind: 'tenant_statement',
      referenceId: stmt.id,
    })
  }
}
