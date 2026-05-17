// GET /api/bank-accounts/:id/transactions/:txId/match-candidates
//
// Returns journal_lines on the bank's GL account that could match
// this bank transaction. Sign-matched: positive bank inflow ↔ DR cash
// line; negative outflow ↔ CR cash line. Bounded to ±30 days from
// the bank txn's posted_at, currency-matched, not already attached
// to another bank txn.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const accountId = getRouterParam(event, 'id')
    const txId = getRouterParam(event, 'txId')
    if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid bank account id' })
    }
    if (!txId || !/^[0-9a-f-]{36}$/i.test(txId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid transaction id' })
    }

    const client = await serverSupabaseClient(event)

    // 1. Read the bank txn + its bank account so we know currency,
    //    GL account id, signed amount, and posted_at.
    const { data: tx, error: txErr } = await (client as any)
      .from('bank_transactions')
      .select('id, bank_account_id, posted_at, amount_minor, matched_journal_line_id')
      .eq('id', txId)
      .eq('bank_account_id', accountId)
      .maybeSingle()
    if (txErr) {
      throw createError({ statusCode: 500, statusMessage: txErr.message })
    }
    if (!tx) {
      throw createError({ statusCode: 404, statusMessage: 'Bank transaction not found' })
    }
    if (tx.matched_journal_line_id) {
      // Already matched — return empty list rather than candidates.
      return { items: [], already_matched: true }
    }

    const { data: bank } = await (client as any)
      .from('bank_accounts')
      .select('account_id, currency')
      .eq('id', accountId)
      .maybeSingle()
    if (!bank) {
      throw createError({ statusCode: 404, statusMessage: 'Bank account not found' })
    }

    const amount = Number(tx.amount_minor)
    const absAmount = Math.abs(amount)
    const isInflow = amount > 0

    // 2. Pull candidate journal_lines on the bank's GL account with
    //    matching sign + amount + currency, within ±30d, posted, and
    //    not already matched to another bank txn.
    //
    // We can't easily express the "not already matched" anti-join
    // through PostgREST in one round trip, so we fetch a wider window
    // and filter client-side. The window is bounded by amount + date
    // so volume stays small.
    const { data: lines, error: lErr } = await (client as any)
      .from('journal_lines')
      .select(
        'id, journal_entry_id, account_id, debit_minor, credit_minor, ' +
          'currency, description, created_at, ' +
          'journal_entries!inner(entry_date, entry_no, status, description)',
      )
      .eq('account_id', bank.account_id)
      .eq('currency', bank.currency)
      .eq(isInflow ? 'debit_minor' : 'credit_minor', absAmount)
      .eq(isInflow ? 'credit_minor' : 'debit_minor', 0)
      .eq('journal_entries.status', 'posted')
      .gte('journal_entries.entry_date',
        new Date(new Date(tx.posted_at).getTime() - 30 * 86_400_000)
          .toISOString()
          .slice(0, 10))
      .lte('journal_entries.entry_date',
        new Date(new Date(tx.posted_at).getTime() + 30 * 86_400_000)
          .toISOString()
          .slice(0, 10))
      .limit(50)
    if (lErr) {
      throw createError({ statusCode: 500, statusMessage: lErr.message })
    }

    const candidateIds = (lines ?? []).map((l: any) => l.id)
    let alreadyMatched = new Set<string>()
    if (candidateIds.length > 0) {
      const { data: collisions } = await (client as any)
        .from('bank_transactions')
        .select('matched_journal_line_id')
        .in('matched_journal_line_id', candidateIds)
      alreadyMatched = new Set(
        (collisions ?? [])
          .map((c: any) => c.matched_journal_line_id)
          .filter((x: any): x is string => !!x),
      )
    }

    const filtered = (lines ?? [])
      .filter((l: any) => !alreadyMatched.has(l.id))
      .map((l: any) => ({
        id: l.id,
        journal_entry_id: l.journal_entry_id,
        debit_minor: l.debit_minor,
        credit_minor: l.credit_minor,
        currency: l.currency,
        description: l.description,
        entry_no: l.journal_entries?.entry_no,
        entry_description: l.journal_entries?.description,
        entry_date: l.journal_entries?.entry_date,
        // Days between bank posted and journal entry — used to sort.
        day_distance: Math.abs(
          (new Date(l.journal_entries?.entry_date ?? tx.posted_at).getTime() -
            new Date(tx.posted_at).getTime()) /
            86_400_000,
        ),
      }))
      .sort((a: any, b: any) => a.day_distance - b.day_distance)
      .slice(0, query.limit ?? 10)

    return { items: filtered, already_matched: false }
  },
})
