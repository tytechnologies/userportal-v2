// Platform fees repository â€” commission rule + revenue ledger.
//
// commission-only model (post-pivot 2026-05-08): platform takes a
// configurable % of broker net commission per closed deal.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { enqueueOutboundEmail, absoluteUrl } from '~~/server/utils/outboundEmail'

const RULE_SELECT =
  'id, default_pct, basis_kind, applies_to, by_stage, by_org, ' +
  'active, effective_at, notes, updated_by, updated_at, created_at'

const CHARGE_SELECT =
  'id, charge_no, deal_id, organization_id, user_id, basis_kind, ' +
  'basis_value, basis_reference_minor, amount_minor, currency, status, ' +
  'invoice_id, invoiced_at, paid_at, voided_at, void_reason, metadata, ' +
  'notes, created_at, updated_at'

export type CommissionRulePatchInput = {
  default_pct?: number
  basis_kind?: 'percent_of_commission' | 'percent_of_deal_value' | 'fixed'
  applies_to?: string[]
  by_stage?: Record<string, number>
  by_org?: Record<string, number>
  active?: boolean
  notes?: string | null
}

export const platformFeesRepo = {
  async getRule({ event }: { event: H3Event }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('platform_commission_rules')
      .select(RULE_SELECT)
      .eq('id', 1)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async patchRule({
    event,
    input,
  }: {
    event: H3Event
    input: CommissionRulePatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const updates: Record<string, unknown> = { updated_by: user.id }
    for (const k of [
      'default_pct', 'basis_kind', 'applies_to', 'by_stage', 'by_org',
      'active', 'notes',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 1) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('platform_commission_rules')
      .update(updates)
      .eq('id', 1)
      .select(RULE_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'platform_fees.rule_updated',
      entity: 'document',
      entityId: null,
      metadata: { changed: Object.keys(updates) },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'platform_fee_rule_update_activity_log_failed',
      )
    })

    return data
  },

  async listCharges({
    event,
    status,
    userId,
    organizationId,
    dealId,
  }: {
    event: H3Event
    status?: 'projected' | 'invoiced' | 'paid' | 'void'
    userId?: string
    organizationId?: string
    dealId?: string
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('platform_fee_charges')
      .select(CHARGE_SELECT)
      .order('created_at', { ascending: false })
    if (status) q = q.eq('status', status)
    if (userId) q = q.eq('user_id', userId)
    if (organizationId) q = q.eq('organization_id', organizationId)
    if (dealId) q = q.eq('deal_id', dealId)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async settlementRun({
    event,
    periodEnd,
  }: {
    event: H3Event
    periodEnd?: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('platform_fee_settlement_run', {
      p_period_end: periodEnd ?? new Date().toISOString().slice(0, 10),
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'platformFees.settlementRun' },
        'platform_fee_settlement_run_failed',
      )
      const code = (error as any).code
      if (code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'platform_fees.settlement_run',
      entity: 'document',
      entityId: null,
      metadata: data ?? {},
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'platform_fee_settlement_run_activity_log_failed',
      )
    })

    // Fan-out: enqueue invoice notification per agent who got billed.
    enqueueSettlementNotifications(periodEnd ?? new Date().toISOString().slice(0, 10)).catch(
      (err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'platform_fee_settlement_email_enqueue_failed',
        )
      },
    )

    return data
  },
}

// =====================================================================
// Helper: enqueue platform-fee invoice notifications
// =====================================================================
//
// After platform_fee_settlement_run creates B6 invoices, walk the
// fresh invoices linked via metadata.kind = 'platform_fee_settlement'
// and enqueue one outbound email per agent. Idempotent via
// dedupe_key = `platform-fee-invoice:<invoice_id>`.

async function enqueueSettlementNotifications(periodEnd: string): Promise<void> {
  const admin = getServerSupabaseAdmin()

  // Find platform-fee invoices issued today (or on the period_end day).
  const { data: invoices } = await (admin as any)
    .from('invoices')
    .select(
      'id, invoice_no, currency, total_minor, organization_id, ' +
        'metadata, issued_at, due_at',
    )
    .eq('status', 'open')
    .gte('issued_at', `${periodEnd}T00:00:00Z`)
    .lte('issued_at', `${periodEnd}T23:59:59Z`)
    .contains('metadata', { kind: 'platform_fee_settlement' } as any)
  if (!invoices || invoices.length === 0) return

  for (const inv of invoices) {
    const agentId: string | null = (inv.metadata as any)?.agent_user_id ?? null
    if (!agentId) continue

    const { data: profile } = await (admin as any)
      .from('profiles')
      .select('email, full_name')
      .eq('id', agentId)
      .maybeSingle()
    if (!profile?.email) continue

    const phpAmount = Number(inv.total_minor) / 100
    const formatted = phpAmount.toLocaleString('en-PH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    const dueDate = inv.due_at ? new Date(inv.due_at).toLocaleDateString('en-PH') : null

    await enqueueOutboundEmail({
      to: profile.email,
      toName: profile.full_name ?? null,
      recipientUserId: agentId,
      templateKind: 'platform_fee.invoice_issued',
      subject: `Invoice ${inv.invoice_no} â€” Housing Interactive platform fee`,
      templateInput: {
        recipientName: profile.full_name ?? null,
        title: inv.invoice_no,
        body: `Total: ${inv.currency} ${formatted}${dueDate ? ` Â· Due ${dueDate}` : ''}`,
        hrefAbsolute: absoluteUrl(`/billing/invoices/${inv.id}`),
      },
      dedupeKey: `platform-fee-invoice:${inv.id}`,
      referenceKind: 'invoice',
      referenceId: inv.id,
      maxAttempts: 5,
    })
  }
}
