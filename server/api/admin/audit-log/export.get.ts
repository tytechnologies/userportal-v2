// GET /api/admin/audit-log/export?since=&until=&format=csv|json&source=...
//
// Phase E foundation. Streams the platform's audit trail. Sources:
//
//   activities         (default) — generic logActivity() entries
//   envelope_events    — envelope_audit_events (sign / decline / void / open)
//   payment_events     — payment_gateway_events (webhook log)
//   commission_ledger  — every ledger entry (created/posted/voided)
//   journal_entries    — every posted/draft/void journal entry header
//   all                — union of every source above, normalised by occurred_at
//
// Defaults: source=activities, last 30 days.
// Hard cap: 50,000 rows per source per request.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

const SOURCES = [
  'activities',
  'envelope_events',
  'payment_events',
  'commission_ledger',
  'journal_entries',
  'all',
] as const

const querySchema = z.object({
  since: z.string().date().optional(),
  until: z.string().date().optional(),
  format: z.enum(['csv', 'json']).optional(),
  source: z.enum(SOURCES).optional(),
  action_prefix: z.string().trim().max(40).optional(),
})

type AuditRow = {
  occurred_at: string
  source: string
  actor_user_id: string | null
  action: string
  entity: string | null
  entity_id: string | null
  metadata: Record<string, unknown>
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const client = await serverSupabaseClient(event)

    const since =
      query.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    const until = query.until ?? new Date().toISOString().slice(0, 10)
    const format = query.format ?? 'csv'
    const source = query.source ?? 'activities'

    const sinceTs = `${since}T00:00:00Z`
    const untilTs = `${until}T23:59:59Z`

    const sources: string[] =
      source === 'all'
        ? ['activities', 'envelope_events', 'payment_events', 'commission_ledger', 'journal_entries']
        : [source]

    const rows: AuditRow[] = []

    for (const src of sources) {
      if (src === 'activities') {
        let q = (client as any)
          .from('activities')
          .select('id, occurred_at, actor_user_id, action, entity, entity_id, metadata')
          .gte('occurred_at', sinceTs)
          .lte('occurred_at', untilTs)
          .order('occurred_at', { ascending: true })
          .limit(50_000)
        if (query.action_prefix) q = q.like('action', `${query.action_prefix}%`)
        const { data, error } = await q
        if (error) {
          throw createError({ statusCode: 500, statusMessage: error.message })
        }
        for (const r of data ?? []) {
          rows.push({
            occurred_at: r.occurred_at,
            source: 'activities',
            actor_user_id: r.actor_user_id,
            action: r.action,
            entity: r.entity,
            entity_id: r.entity_id,
            metadata: r.metadata ?? {},
          })
        }
      } else if (src === 'envelope_events') {
        const { data, error } = await (client as any)
          .from('envelope_audit_events')
          .select('id, occurred_at, envelope_id, recipient_id, event_kind, actor_user_id, actor_email, actor_ip, actor_ua, metadata')
          .gte('occurred_at', sinceTs)
          .lte('occurred_at', untilTs)
          .order('occurred_at', { ascending: true })
          .limit(50_000)
        if (error) {
          throw createError({ statusCode: 500, statusMessage: error.message })
        }
        for (const r of data ?? []) {
          rows.push({
            occurred_at: r.occurred_at,
            source: 'envelope_events',
            actor_user_id: r.actor_user_id,
            action: `envelope.${r.event_kind}`,
            entity: 'envelope',
            entity_id: r.envelope_id,
            metadata: {
              recipient_id: r.recipient_id,
              actor_email: r.actor_email,
              actor_ip: r.actor_ip ? `${r.actor_ip}` : null,
              actor_ua: r.actor_ua,
              ...r.metadata,
            },
          })
        }
      } else if (src === 'payment_events') {
        const { data, error } = await (client as any)
          .from('payment_gateway_events')
          .select('id, received_at, provider, event_id, event_type, signature_verified, processing_status, processing_error, related_invoice_id, related_intent_id, payload')
          .gte('received_at', sinceTs)
          .lte('received_at', untilTs)
          .order('received_at', { ascending: true })
          .limit(50_000)
        if (error) {
          throw createError({ statusCode: 500, statusMessage: error.message })
        }
        for (const r of data ?? []) {
          rows.push({
            occurred_at: r.received_at,
            source: 'payment_events',
            actor_user_id: null,
            action: `payment.${r.event_type}`,
            entity: 'payment_gateway_event',
            entity_id: r.id,
            metadata: {
              provider: r.provider,
              event_id: r.event_id,
              signature_verified: r.signature_verified,
              processing_status: r.processing_status,
              processing_error: r.processing_error,
              related_invoice_id: r.related_invoice_id,
              related_intent_id: r.related_intent_id,
            },
          })
        }
      } else if (src === 'commission_ledger') {
        const { data, error } = await (client as any)
          .from('commission_ledger')
          .select('id, created_at, deal_id, participant_user_id, participant_role, entry_kind, amount_minor, currency, status, posted_at, created_by')
          .gte('created_at', sinceTs)
          .lte('created_at', untilTs)
          .order('created_at', { ascending: true })
          .limit(50_000)
        if (error) {
          throw createError({ statusCode: 500, statusMessage: error.message })
        }
        for (const r of data ?? []) {
          rows.push({
            occurred_at: r.created_at,
            source: 'commission_ledger',
            actor_user_id: r.created_by,
            action: `commission_ledger.${r.entry_kind}`,
            entity: 'deal',
            entity_id: r.deal_id,
            metadata: {
              ledger_entry_id: r.id,
              participant_user_id: r.participant_user_id,
              participant_role: r.participant_role,
              amount_minor: r.amount_minor,
              currency: r.currency,
              status: r.status,
              posted_at: r.posted_at,
            },
          })
        }
      } else if (src === 'journal_entries') {
        const { data, error } = await (client as any)
          .from('journal_entries')
          .select('id, entry_date, entry_no, description, reference_kind, reference_id, status, posted_at, posted_by, voided_at, created_at')
          .gte('created_at', sinceTs)
          .lte('created_at', untilTs)
          .order('created_at', { ascending: true })
          .limit(50_000)
        if (error) {
          throw createError({ statusCode: 500, statusMessage: error.message })
        }
        for (const r of data ?? []) {
          rows.push({
            occurred_at: r.posted_at ?? r.created_at,
            source: 'journal_entries',
            actor_user_id: r.posted_by,
            action: `journal.${r.status}`,
            entity: 'journal_entry',
            entity_id: r.id,
            metadata: {
              entry_no: r.entry_no,
              entry_date: r.entry_date,
              description: r.description,
              reference_kind: r.reference_kind,
              reference_id: r.reference_id,
              voided_at: r.voided_at,
            },
          })
        }
      }
    }

    // For 'all', sort merged result by occurred_at; single-source data
    // is already sorted from the query.
    if (sources.length > 1) {
      rows.sort(
        (a, b) =>
          new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
      )
    }

    if (format === 'json') {
      return {
        since,
        until,
        source,
        action_prefix: query.action_prefix ?? null,
        row_count: rows.length,
        items: rows,
      }
    }

    // CSV
    const filename = `audit-log_${source}_${since}_to_${until}.csv`
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)

    const header = [
      'occurred_at',
      'source',
      'actor_user_id',
      'action',
      'entity',
      'entity_id',
      'metadata_json',
    ].join(',')

    const body = rows
      .map((r) =>
        [
          csvEscape(r.occurred_at),
          csvEscape(r.source),
          csvEscape(r.actor_user_id),
          csvEscape(r.action),
          csvEscape(r.entity),
          csvEscape(r.entity_id),
          csvEscape(JSON.stringify(r.metadata)),
        ].join(','),
      )
      .join('\n')

    return `${header}\n${body}`
  },
})
