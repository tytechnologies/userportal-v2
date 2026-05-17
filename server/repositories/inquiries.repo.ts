// Inquiries repository — system of record for the authenticated
// /api/inquiries/* CRUD path.
//
// Operations exposed: list, update.
// NOT exposed:
//   - create (insert): owned by the public webform at
//     /api/public/inquiries/index.post.ts — service-role insert with
//     honeypot, listing preflight, feature flag. Doesn't share code
//     with this authenticated path.
//   - delete: no API endpoint exists; inquiries are immutable in the
//     audit sense. Status flips to 'spam' or 'closed' instead.
//   - stats: aggregation surface at /api/inquiries/stats.get.ts —
//     doesn't share code with list/update; left inline.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { pageRange, paginatedResponse } from '~~/server/utils/pagination'

type InquiryStatus = 'new' | 'in_progress' | 'replied' | 'closed' | 'spam'

export type InquiryListFilters = {
  status?: InquiryStatus
  listing_id?: number
  /** True → only inquiries assigned to the caller. */
  mine?: boolean
  /**
   * Filter on the assigned_user_id column rather than the caller.
   *   'unassigned' → assigned_user_id IS NULL  (admin triage queue)
   *   'any'        → no filter (default)
   * Mutually exclusive with `mine`; `mine` wins if both are set.
   */
  assigned?: 'unassigned' | 'any'
}

export type InquiryUpdateInput = {
  status?: InquiryStatus
  /** Optional handover — admin can reassign to another agent. */
  assigned_user_id?: string | null
}

export const inquiriesRepo = {
  /**
   * List inquiries. RLS scopes assigned/team/all per inquiries.read.*.
   * Order: created_at DESC (inbox-style — newest first).
   */
  async list({
    event,
    page,
    pageSize,
    filters,
    userId,
  }: {
    event: H3Event
    page: number
    pageSize: number
    filters: InquiryListFilters
    /** Required when filters.mine = true. */
    userId?: string | null
  }) {
    const client = await serverSupabaseClient(event)

    let q: any = (client as any)
      .from('inquiries')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })

    if (filters.status) q = q.eq('status', filters.status)
    if (filters.listing_id) q = q.eq('listing_id', filters.listing_id)
    if (filters.mine && userId) {
      q = q.eq('assigned_user_id', userId)
    } else if (filters.assigned === 'unassigned') {
      q = q.is('assigned_user_id', null)
    }

    const { from, to } = pageRange(page, pageSize)
    q = q.range(from, to)

    const { data, error, count } = await q
    if (error) {
      logger.error({ err: error.message, op: 'inquiries.list' }, 'inquiries_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return paginatedResponse(data ?? [], count ?? 0, page, pageSize)
  },

  /**
   * Update an inquiry — primarily for status flips (mark as replied,
   * close, mark as spam) or admin handover. RLS limits write to
   * assigned/team/all per inquiries.write.* permissions; spam
   * moderation is gated on listings.write.all.
   *
   * `replied_at` is a derived audit timestamp: stamped when the user
   * transitions INTO 'replied', cleared on transition back. Other
   * status transitions don't touch it.
   */
  async update({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: InquiryUpdateInput
  }) {
    const client = await serverSupabaseClient(event)

    const update: Record<string, unknown> = {}
    if (input.status !== undefined) {
      update.status = input.status
      update.replied_at =
        input.status === 'replied' ? new Date().toISOString() : null
    }
    if (input.assigned_user_id !== undefined) {
      update.assigned_user_id = input.assigned_user_id
    }

    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const { data, error } = await (client as any)
      .from('inquiries')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'inquiries.update', id }, 'inquiries_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Inquiry not found or not editable',
      })
    }

    await logActivity({
      event,
      client,
      action: 'inquiry.updated',
      entity: 'inquiry',
      entityId: data.id,
      metadata: {
        fields: Object.keys(update),
        status: data.status ?? null,
        assigned_user_id: data.assigned_user_id ?? null,
        listing_id: data.listing_id ?? null,
      },
    })

    return data
  },
}
