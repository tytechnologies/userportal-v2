// Commission-ledger repository â€” system of record for
// /api/deals/[id]/commission-ledger/* and /api/commission-ledger/*.
//
// The ledger is event-based: every economic transition lives as its
// own row. Posted rows are append-only â€” corrections are inserted as
// new entries (entry_kind='reversal' or 'adjustment') referencing the
// parent. The DB trigger commission_ledger_post_guard enforces this.
//
// RLS gates SELECT to: the participant themselves, commissions.view.platform
// holders, or commissions.ledger.read.team holders. INSERT requires either
// the team-write permission OR deal_can_write on the deal.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export type LedgerEntryKind =
  | 'projection'
  | 'earning'
  | 'invoice'
  | 'payment'
  | 'payout'
  | 'reversal'
  | 'adjustment'

export type LedgerStatus = 'draft' | 'posted' | 'void'

export type LedgerBasisType =
  | 'percent_of_deal_value'
  | 'percent_of_commission'
  | 'fixed'
  | 'split_of_parent'

export type LedgerCreateInput = {
  entry_kind: LedgerEntryKind
  participant_role: string
  amount: number
  currency?: string
  participant_user_id?: string | null
  participant_contact_id?: number | null
  participant_organization_id?: string | null
  deal_commission_id?: string | null
  parent_entry_id?: string | null
  basis_type?: LedgerBasisType | null
  basis_value?: number | null
  external_reference?: string | null
  occurred_at?: string
  notes?: string | null
  /** When 'posted', the trigger auto-stamps posted_at. */
  status?: 'draft' | 'posted'
}

export type LedgerPatchInput = {
  /** draft -> posted promotes; posted -> void requires void_reason. */
  status?: 'posted' | 'void'
  void_reason?: string | null
  notes?: string | null
  external_reference?: string | null
  /** Draft-only: amount/role/etc. The trigger blocks these on posted rows. */
  amount?: number
  participant_role?: string
  basis_type?: LedgerBasisType | null
  basis_value?: number | null
  occurred_at?: string
}

const LEDGER_SELECT =
  'id, deal_id, deal_commission_id, parent_entry_id, ' +
  'participant_user_id, participant_contact_id, participant_organization_id, ' +
  'participant_role, entry_kind, amount, currency, basis_type, basis_value, ' +
  'status, external_reference, occurred_at, posted_at, voided_at, void_reason, ' +
  'notes, created_by, created_at, updated_at'

export const commissionLedgerRepo = {
  async listForDeal({
    event,
    dealId,
    includeVoid = false,
  }: {
    event: H3Event
    dealId: string
    includeVoid?: boolean
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('commission_ledger')
      .select(LEDGER_SELECT)
      .eq('deal_id', dealId)
      .order('occurred_at', { ascending: false })
      .order('created_at', { ascending: false })

    if (!includeVoid) q = q.neq('status', 'void')

    const { data, error } = await q
    if (error) {
      logger.error(
        { err: error.message, op: 'commissionLedger.listForDeal', dealId },
        'commission_ledger_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Pull the rollup view for this deal so the UI doesn't have to
    // recompute totals client-side. RLS gates the view through the
    // underlying table policies.
    const { data: summary, error: sumErr } = await (client as any)
      .from('commission_ledger_summary')
      .select('*')
      .eq('deal_id', dealId)

    if (sumErr) {
      logger.warn(
        { err: sumErr.message, op: 'commissionLedger.summary', dealId },
        'commission_ledger_summary_failed',
      )
    }

    return { entries: data ?? [], summary: summary ?? [] }
  },

  async create({
    event,
    dealId,
    input,
  }: {
    event: H3Event
    dealId: string
    input: LedgerCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    if (
      !input.participant_user_id &&
      !input.participant_contact_id &&
      !input.participant_organization_id
    ) {
      throw createError({
        statusCode: 400,
        statusMessage:
          'At least one of participant_user_id, participant_contact_id, participant_organization_id is required',
      })
    }

    if (
      (input.entry_kind === 'reversal' || input.entry_kind === 'adjustment') &&
      !input.parent_entry_id
    ) {
      throw createError({
        statusCode: 400,
        statusMessage: `${input.entry_kind} entries require parent_entry_id`,
      })
    }

    const insert: Record<string, unknown> = {
      deal_id: dealId,
      deal_commission_id: input.deal_commission_id ?? null,
      parent_entry_id: input.parent_entry_id ?? null,
      participant_user_id: input.participant_user_id ?? null,
      participant_contact_id: input.participant_contact_id ?? null,
      participant_organization_id: input.participant_organization_id ?? null,
      participant_role: input.participant_role,
      entry_kind: input.entry_kind,
      amount: input.amount,
      currency: input.currency ?? 'PHP',
      basis_type: input.basis_type ?? null,
      basis_value: input.basis_value ?? null,
      status: input.status ?? 'draft',
      external_reference: input.external_reference ?? null,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      notes: input.notes ?? null,
      created_by: user.id,
    }

    const { data, error } = await (client as any)
      .from('commission_ledger')
      .insert(insert)
      .select(LEDGER_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'commissionLedger.create', dealId },
        'commission_ledger_create_failed',
      )
      // 23514 = check_violation (e.g., reversal without parent slipped past TS check)
      if ((error as any).code === '23514') {
        throw createError({ statusCode: 400, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action:
        input.status === 'posted'
          ? 'deal.commission_ledger_posted'
          : 'deal.commission_ledger_drafted',
      entity: 'deal',
      entityId: dealId,
      metadata: {
        ledger_id: data.id,
        entry_kind: data.entry_kind,
        amount: data.amount,
        currency: data.currency,
        participant_role: data.participant_role,
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'commission_ledger_create_activity_log_failed',
      )
    })

    return data
  },

  async patch({
    event,
    ledgerId,
    input,
  }: {
    event: H3Event
    ledgerId: string
    input: LedgerPatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    if (input.status === 'void' && !input.void_reason?.trim()) {
      throw createError({
        statusCode: 400,
        statusMessage: 'void_reason is required when voiding a posted entry',
      })
    }

    const updates: Record<string, unknown> = {}
    if (input.status !== undefined) updates.status = input.status
    if (input.void_reason !== undefined) updates.void_reason = input.void_reason
    if (input.notes !== undefined) updates.notes = input.notes
    if (input.external_reference !== undefined) {
      updates.external_reference = input.external_reference
    }
    if (input.amount !== undefined) updates.amount = input.amount
    if (input.participant_role !== undefined) {
      updates.participant_role = input.participant_role
    }
    if (input.basis_type !== undefined) updates.basis_type = input.basis_type
    if (input.basis_value !== undefined) updates.basis_value = input.basis_value
    if (input.occurred_at !== undefined) updates.occurred_at = input.occurred_at

    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }

    const { data, error } = await (client as any)
      .from('commission_ledger')
      .update(updates)
      .eq('id', ledgerId)
      .select(LEDGER_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'commissionLedger.patch', ledgerId },
        'commission_ledger_patch_failed',
      )
      // The post-guard trigger raises a custom message when economic
      // fields are touched on a posted row. Surface as 409.
      if ((error as any).message?.includes('append-only')) {
        throw createError({
          statusCode: 409,
          statusMessage:
            'This entry is posted. Insert a reversal or adjustment entry instead.',
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Ledger entry not found' })
    }

    logActivity({
      event,
      action:
        input.status === 'posted'
          ? 'deal.commission_ledger_posted'
          : input.status === 'void'
            ? 'deal.commission_ledger_voided'
            : 'deal.commission_ledger_updated',
      entity: 'deal',
      entityId: data.deal_id,
      metadata: { ledger_id: ledgerId, changed: Object.keys(updates) },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'commission_ledger_patch_activity_log_failed',
      )
    })

    return data
  },
}
