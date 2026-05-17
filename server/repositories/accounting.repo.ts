// Accounting repository â€” accounts, journal, bank reconciliation.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const ACCOUNT_SELECT =
  'id, code, name, account_type, parent_account_id, currency, description, ' +
  'is_active, is_system, bir_classification, tax_code, metadata, ' +
  'created_at, updated_at'

const ENTRY_SELECT =
  'id, entry_no, entry_date, description, reference_kind, reference_id, ' +
  'currency, status, posted_at, posted_by, voided_at, voided_by, void_reason, ' +
  'reverses_entry_id, metadata, created_by, created_at, updated_at'

const LINE_SELECT =
  'id, journal_entry_id, account_id, debit_minor, credit_minor, currency, ' +
  'description, dimension_unit_id, dimension_lease_id, dimension_owner_id, ' +
  'line_no, metadata, created_at'

const BANK_ACCOUNT_SELECT =
  'id, account_id, bank_name, account_number, account_name, branch, ' +
  'swift_code, currency, account_type, status, opening_balance_minor, ' +
  'opened_at, closed_at, notes, metadata, created_at, updated_at'

const BANK_TXN_SELECT =
  'id, bank_account_id, posted_at, description, reference, amount_minor, ' +
  'balance_minor, import_batch_id, source, matched_journal_line_id, ' +
  'matched_at, matched_by, status, notes, metadata, created_at, updated_at'

export const accountingRepo = {
  // ===== Accounts =====
  async listAccounts({
    event,
    accountType,
    activeOnly,
  }: {
    event: H3Event
    accountType?: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
    activeOnly?: boolean
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('accounts')
      .select(ACCOUNT_SELECT)
      .order('code', { ascending: true })
    if (accountType) q = q.eq('account_type', accountType)
    if (activeOnly) q = q.eq('is_active', true)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async createAccount({
    event,
    input,
  }: {
    event: H3Event
    input: {
      code: string
      name: string
      account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
      parent_account_id?: string | null
      currency?: string
      description?: string | null
      bir_classification?: 'vatable' | 'non_vatable' | 'exempt' | 'zero_rated' | null
      tax_code?: string | null
    }
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('accounts')
      .insert({
        code: input.code.trim(),
        name: input.name.trim(),
        account_type: input.account_type,
        parent_account_id: input.parent_account_id ?? null,
        currency: input.currency ?? 'PHP',
        description: input.description ?? null,
        bir_classification: input.bir_classification ?? null,
        tax_code: input.tax_code ?? null,
      })
      .select(ACCOUNT_SELECT)
      .single()
    if (error) {
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `Account code '${input.code}' already exists`,
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async patchAccount({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: {
      name?: string
      parent_account_id?: string | null
      description?: string | null
      is_active?: boolean
      bir_classification?: string | null
      tax_code?: string | null
    }
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'name', 'parent_account_id', 'description', 'is_active',
      'bir_classification', 'tax_code',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }
    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('accounts')
      .update(updates)
      .eq('id', id)
      .select(ACCOUNT_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Account not found' })
    }
    return data
  },

  // ===== Journal entries =====
  async listEntries({
    event,
    status,
    referenceKind,
  }: {
    event: H3Event
    status?: 'draft' | 'posted' | 'void'
    referenceKind?: string
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('journal_entries')
      .select(ENTRY_SELECT)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500)
    if (status) q = q.eq('status', status)
    if (referenceKind) q = q.eq('reference_kind', referenceKind)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async getEntry({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data: entry, error } = await (client as any)
      .from('journal_entries')
      .select(ENTRY_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!entry) {
      throw createError({ statusCode: 404, statusMessage: 'Entry not found' })
    }
    const { data: lines } = await (client as any)
      .from('journal_lines')
      .select(LINE_SELECT)
      .eq('journal_entry_id', id)
      .order('line_no', { ascending: true })
    return { entry, lines: lines ?? [] }
  },

  async createEntry({
    event,
    input,
  }: {
    event: H3Event
    input: {
      entry_date?: string
      description: string
      reference_kind?: string
      reference_id?: string | null
      currency?: string
      lines: Array<{
        account_id: string
        debit_minor?: number
        credit_minor?: number
        description?: string | null
        dimension_unit_id?: string | null
        dimension_lease_id?: string | null
        dimension_owner_id?: string | null
      }>
      metadata?: Record<string, unknown>
    }
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    if (!input.lines || input.lines.length < 2) {
      throw createError({ statusCode: 400, statusMessage: 'At least 2 lines required' })
    }

    const currency = input.currency ?? 'PHP'

    const { data: entry, error: entryErr } = await (client as any)
      .from('journal_entries')
      .insert({
        entry_date: input.entry_date ?? new Date().toISOString().slice(0, 10),
        description: input.description,
        reference_kind: input.reference_kind ?? 'manual',
        reference_id: input.reference_id ?? null,
        currency,
        metadata: input.metadata ?? {},
        created_by: user.id,
      })
      .select(ENTRY_SELECT)
      .single()
    if (entryErr) {
      throw createError({ statusCode: 500, statusMessage: entryErr.message })
    }

    const lineRows = input.lines.map((line, idx) => ({
      journal_entry_id: entry.id,
      account_id: line.account_id,
      debit_minor: line.debit_minor ?? 0,
      credit_minor: line.credit_minor ?? 0,
      currency,
      description: line.description ?? null,
      dimension_unit_id: line.dimension_unit_id ?? null,
      dimension_lease_id: line.dimension_lease_id ?? null,
      dimension_owner_id: line.dimension_owner_id ?? null,
      line_no: idx + 1,
    }))

    const { error: linesErr } = await (client as any)
      .from('journal_lines')
      .insert(lineRows)
    if (linesErr) {
      // Best-effort cleanup of the parent entry on line failure.
      await (client as any).from('journal_entries').delete().eq('id', entry.id)
      throw createError({ statusCode: 400, statusMessage: linesErr.message })
    }

    return { entry, lines_inserted: lineRows.length }
  },

  async post({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('journal_entry_post', {
      p_entry_id: id,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Entry not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'accounting.entry_posted',
      entity: 'document',
      entityId: null,
      metadata: { entry_id: id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'accounting_post_activity_log_failed',
      )
    })

    return { entry_id: data ?? id }
  },

  async reverse({
    event,
    id,
    reversalDate,
  }: {
    event: H3Event
    id: string
    reversalDate?: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('journal_entry_reverse', {
      p_entry_id: id,
      p_reversal_date: reversalDate ?? new Date().toISOString().slice(0, 10),
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Entry not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }
    return { reversal_entry_id: data }
  },

  async autoPostPropertyCharge({
    event,
    chargeId,
  }: {
    event: H3Event
    chargeId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('auto_post_property_charge', {
      p_charge_id: chargeId,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Charge not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }
    return { entry_id: data }
  },

  async autoPostPlatformFee({
    event,
    chargeId,
  }: {
    event: H3Event
    chargeId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('auto_post_platform_fee', {
      p_charge_id: chargeId,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Charge not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }
    return { entry_id: data }
  },

  // ===== Bank accounts =====
  async listBankAccounts({ event }: { event: H3Event }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('bank_accounts')
      .select(BANK_ACCOUNT_SELECT)
      .order('bank_name', { ascending: true })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async createBankAccount({
    event,
    input,
  }: {
    event: H3Event
    input: {
      account_id: string
      bank_name: string
      account_number: string
      account_name: string
      branch?: string | null
      swift_code?: string | null
      currency?: string
      account_type?: 'checking' | 'savings' | 'time_deposit'
      opening_balance_minor?: number
      opened_at?: string
      notes?: string | null
    }
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const { data, error } = await (client as any)
      .from('bank_accounts')
      .insert({
        account_id: input.account_id,
        bank_name: input.bank_name,
        account_number: input.account_number,
        account_name: input.account_name,
        branch: input.branch ?? null,
        swift_code: input.swift_code ?? null,
        currency: input.currency ?? 'PHP',
        account_type: input.account_type ?? 'checking',
        opening_balance_minor: input.opening_balance_minor ?? 0,
        opened_at: input.opened_at ?? new Date().toISOString().slice(0, 10),
        notes: input.notes ?? null,
        created_by: user.id,
      })
      .select(BANK_ACCOUNT_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  // ===== Bank transactions =====
  async listBankTransactions({
    event,
    bankAccountId,
    status,
  }: {
    event: H3Event
    bankAccountId: string
    status?: 'unmatched' | 'matched' | 'manual' | 'ignored'
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('bank_transactions')
      .select(BANK_TXN_SELECT)
      .eq('bank_account_id', bankAccountId)
      .order('posted_at', { ascending: false })
      .limit(500)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async createBankTransaction({
    event,
    bankAccountId,
    input,
  }: {
    event: H3Event
    bankAccountId: string
    input: {
      posted_at: string
      description?: string | null
      reference?: string | null
      amount_minor: number
      balance_minor?: number | null
      import_batch_id?: string | null
      source?: 'manual' | 'csv_import' | 'api_import'
      notes?: string | null
    }
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('bank_transactions')
      .insert({
        bank_account_id: bankAccountId,
        posted_at: input.posted_at,
        description: input.description ?? null,
        reference: input.reference ?? null,
        amount_minor: input.amount_minor,
        balance_minor: input.balance_minor ?? null,
        import_batch_id: input.import_batch_id ?? null,
        source: input.source ?? 'manual',
        notes: input.notes ?? null,
      })
      .select(BANK_TXN_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async matchBankTransaction({
    event,
    bankAccountId,
    txId,
    journalLineId,
  }: {
    event: H3Event
    bankAccountId: string
    txId: string
    journalLineId: string
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }
    const { data, error } = await (client as any)
      .from('bank_transactions')
      .update({
        matched_journal_line_id: journalLineId,
        matched_at: new Date().toISOString(),
        matched_by: user.id,
        status: 'matched',
      })
      .eq('id', txId)
      .eq('bank_account_id', bankAccountId)
      .select(BANK_TXN_SELECT)
      .single()
    if (error) {
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'That journal line is already matched to another bank transaction',
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Bank transaction not found' })
    }
    return data
  },

  async trialBalance({ event }: { event: H3Event }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('trial_balance')
      .select('*')
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
}
