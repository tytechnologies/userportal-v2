// GET /api/contacts
//
// Server-side counterpart to the prior browser→Supabase-REST read
// path. The 2026-05-14 smoke report flagged the read/write split:
// reads went direct to REST, writes through this Nuxt API. That
// inconsistency made the P0 silent-data-loss bug possible — the two
// surfaces could disagree about row visibility (RLS hides a wrong-
// owner row from REST → looks like data loss; but the write API
// returned 200).
//
// Routing reads through this endpoint:
//   - same auth context as the write path (request supabase client
//     carrying the JWT), so RLS surfaces identically
//   - one place to audit, log, and apply server-side filters/limits
//   - lets useContacts cache via useState across components
//
// Query params (all optional):
//   q       — substring match on full_name OR email OR mobile_phone
//   sort    — 'created_at' (default) | 'full_name'
//   order   — 'desc' (default) | 'asc'
//   limit   — 1-2000, default 1000

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

// Audit columns created_by + updated_by were added in mig
// 20260514000007. The SELECT works pre-migration too — PostgREST will
// just return null for unknown columns. After the migration applies
// they populate via DEFAULT auth.uid() (INSERT) + trigger (UPDATE).
const SELECT_COLUMNS =
  'id, owner_user_id, full_name, email, mobile_phone, home_phone, designation, link, notes, avatar, created_at, updated_at, created_by, updated_by'

const querySchema = z.object({
  q: z.string().max(200).optional(),
  sort: z.enum(['created_at', 'full_name']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    let q: any = supabase
      .from('contacts')
      .select(SELECT_COLUMNS)
      .order(query.sort, { ascending: query.order === 'asc' })
      .limit(query.limit)

    if (query.q && query.q.trim() !== '') {
      // Escape PostgREST OR-filter metacharacters before splicing.
      const safe = query.q.replace(/[%,()]/g, '').trim()
      q = q.or(
        `full_name.ilike.%${safe}%,email.ilike.%${safe}%,mobile_phone.ilike.%${safe}%`,
      )
    }

    const { data, error } = await q
    if (error) {
      logger.warn(
        { err: error.message, op: 'contacts.list' },
        'contacts_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [], total: (data ?? []).length }
  },
})
