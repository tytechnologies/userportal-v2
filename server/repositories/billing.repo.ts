// Billing repository â€” accounts, payment methods, invoices, intents.
//
// Money columns are *_minor bigints (centavos for PHP). The repo
// returns them as-is; the UI handles display formatting (avoids
// floating-point drift through the wire protocol).

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const ACCOUNT_SELECT =
  'id, organization_id, provider, provider_customer_id, default_payment_method_id, ' +
  'billing_email, billing_address, tax_id, metadata, created_at, updated_at'

const METHOD_SELECT =
  'id, billing_account_id, provider, provider_method_id, method_kind, last4, ' +
  'card_brand, exp_month, exp_year, is_default, status, metadata, ' +
  'created_at, updated_at'

const INVOICE_SELECT =
  'id, billing_account_id, organization_id, subscription_id, invoice_no, currency, ' +
  'subtotal_minor, tax_minor, total_minor, amount_paid_minor, status, issued_at, ' +
  'due_at, paid_at, voided_at, void_reason, period_start, period_end, line_items, ' +
  'external_reference, metadata, created_at, updated_at'

const INTENT_SELECT =
  'id, invoice_id, billing_account_id, payment_method_id, provider, ' +
  'provider_intent_id, amount_minor, currency, status, attempt_count, ' +
  'failure_code, failure_message, succeeded_at, failed_at, refunded_at, ' +
  'metadata, created_at, updated_at'

export const billingRepo = {
  async getAccount({
    event,
    organizationId,
  }: {
    event: H3Event
    organizationId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('billing_accounts')
      .select(ACCOUNT_SELECT)
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) {
      logger.error(
        { err: error.message, op: 'billing.getAccount', organizationId },
        'billing_get_account_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },

  async upsertAccount({
    event,
    organizationId,
    input,
  }: {
    event: H3Event
    organizationId: string
    input: {
      provider?: string
      billing_email?: string | null
      billing_address?: Record<string, unknown>
      tax_id?: string | null
      metadata?: Record<string, unknown>
    }
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const updates: Record<string, unknown> = {}
    if (input.provider !== undefined) updates.provider = input.provider
    if (input.billing_email !== undefined) updates.billing_email = input.billing_email
    if (input.billing_address !== undefined) updates.billing_address = input.billing_address
    if (input.tax_id !== undefined) updates.tax_id = input.tax_id
    if (input.metadata !== undefined) updates.metadata = input.metadata

    // Upsert by organization_id (UNIQUE constraint).
    const { data, error } = await (client as any)
      .from('billing_accounts')
      .upsert(
        { organization_id: organizationId, ...updates },
        { onConflict: 'organization_id' },
      )
      .select(ACCOUNT_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'billing.upsertAccount', organizationId },
        'billing_upsert_account_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'billing.account_updated',
      entity: 'document',
      entityId: null,
      metadata: { organization_id: organizationId, changed: Object.keys(updates) },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'billing_upsert_activity_log_failed',
      )
    })

    return data
  },

  async listMethods({
    event,
    organizationId,
  }: {
    event: H3Event
    organizationId: string
  }) {
    const client = await serverSupabaseClient(event)
    const account = await this.getAccount({ event, organizationId })
    if (!account) return { items: [] }

    const { data, error } = await (client as any)
      .from('payment_methods')
      .select(METHOD_SELECT)
      .eq('billing_account_id', account.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async detachMethod({
    event,
    organizationId,
    paymentMethodId,
  }: {
    event: H3Event
    organizationId: string
    paymentMethodId: string
  }) {
    const client = await serverSupabaseClient(event)
    const account = await this.getAccount({ event, organizationId })
    if (!account) {
      throw createError({ statusCode: 404, statusMessage: 'Billing account not found' })
    }

    const { data, error } = await (client as any)
      .from('payment_methods')
      .update({ status: 'detached', is_default: false })
      .eq('id', paymentMethodId)
      .eq('billing_account_id', account.id)
      .select(METHOD_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Payment method not found' })
    }

    logActivity({
      event,
      action: 'billing.payment_method_detached',
      entity: 'document',
      entityId: null,
      metadata: { organization_id: organizationId, payment_method_id: paymentMethodId },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'billing_detach_method_activity_log_failed',
      )
    })

    return data
  },

  async listInvoices({
    event,
    organizationId,
    status,
  }: {
    event: H3Event
    organizationId: string
    status?: string
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('invoices')
      .select(INVOICE_SELECT)
      .eq('organization_id', organizationId)
      .order('issued_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async getInvoice({
    event,
    organizationId,
    invoiceId,
  }: {
    event: H3Event
    organizationId: string
    invoiceId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data: invoice, error } = await (client as any)
      .from('invoices')
      .select(INVOICE_SELECT)
      .eq('id', invoiceId)
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!invoice) {
      throw createError({ statusCode: 404, statusMessage: 'Invoice not found' })
    }

    const { data: intents } = await (client as any)
      .from('payment_intents')
      .select(INTENT_SELECT)
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: false })

    return { invoice, intents: intents ?? [] }
  },

  async getSummary({
    event,
    organizationId,
  }: {
    event: H3Event
    organizationId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('organization_billing_summary')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return data
  },
}
