// GET /api/admin/accounting/account-balances?account_id=...
//
// Returns one or more rows from the account_balances view. Used by the
// bank reconciliation page's drift card to compare the bank's GL
// running balance against the most recent statement balance.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  account_id: z.string().uuid().optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('account_balances')
      .select(
        'account_id, code, name, account_type, currency, ' +
          'total_debit_minor, total_credit_minor, net_balance_minor',
      )
      .order('code', { ascending: true })
    if (query.account_id) q = q.eq('account_id', query.account_id)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },
})
