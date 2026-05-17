// Notes repository — system of record for /api/notes/*.
//
// Mirrors tasks.repo.ts and listings.repo.ts. Co-locates Supabase CRUD,
// notification fanout (to contact owner + listing creator), and audit
// emission so the endpoint files become thin pass-throughs.
//
// Notification fanout NOTE:
//   The request-bound supabase client respects RLS. A note's author
//   may not see the related contact or listing's owner row directly
//   — RLS scopes those tables. To dispatch notifications we use the
//   service-role client (`getServerSupabaseAdmin`) for the lookup
//   only; the actual notify() insert also goes through service-role
//   internally. notify() short-circuits when actor === recipient so
//   self-fan-outs are never emitted.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'
import { pageRange, paginatedResponse } from '~~/server/utils/pagination'

export type NoteListFilters = {
  contact_id?: number
  listing_id?: number
  /** True → only the caller's notes. */
  mine?: boolean
  /** True → only pinned notes. */
  pinned?: boolean
}

export type NoteCreateInput = {
  body: string
  contact_id?: number | null
  listing_id?: number | null
  is_pinned?: boolean
}

export type NoteUpdateInput = {
  body?: string
  is_pinned?: boolean
  contact_id?: number | null
  listing_id?: number | null
}

const UPDATABLE_FIELDS = ['body', 'is_pinned', 'contact_id', 'listing_id'] as const

export const notesRepo = {
  /**
   * List notes. RLS scopes own/team/all per notes.read.* permissions.
   * Order: pinned first, then newest. Pinned floats to top regardless
   * of timestamp so quick-reference notes stay visible.
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
    filters: NoteListFilters
    /** Required when filters.mine = true. */
    userId?: string | null
  }) {
    const client = await serverSupabaseClient(event)

    let q: any = (client as any)
      .from('notes')
      .select('*', { count: 'exact' })
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })

    if (filters.contact_id) q = q.eq('contact_id', filters.contact_id)
    if (filters.listing_id) q = q.eq('listing_id', filters.listing_id)
    if (filters.mine && userId) q = q.eq('owner_user_id', userId)
    if (filters.pinned) q = q.eq('is_pinned', true)

    const { from, to } = pageRange(page, pageSize)
    q = q.range(from, to)

    const { data, error, count } = await q
    if (error) {
      logger.error({ err: error.message, op: 'notes.list' }, 'notes_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return paginatedResponse(data ?? [], count ?? 0, page, pageSize)
  },

  /**
   * Create a note. owner_user_id auto-stamps via DB DEFAULT auth.uid().
   * Either contact_id or listing_id (or both) is typical; an "orphan"
   * note (neither) is allowed for general jot-downs.
   *
   * Fanout: notifies the contact owner + the listing creator if either
   * is linked, deduped if they're the same user, skipped if they're
   * the note's author.
   */
  async create({
    event,
    input,
    userId,
  }: {
    event: H3Event
    input: NoteCreateInput
    userId: string | null | undefined
  }) {
    const client = await serverSupabaseClient(event)

    const insert: Record<string, unknown> = {
      body: input.body,
      contact_id: input.contact_id ?? null,
      listing_id: input.listing_id ?? null,
      is_pinned: input.is_pinned ?? false,
    }

    const { data, error } = await (client as any)
      .from('notes')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      logger.error({ err: error.message, op: 'notes.create' }, 'notes_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Best-effort fanout. RLS hides other users' contacts from the
    // request-bound client, so the lookup uses service-role.
    try {
      const admin = getServerSupabaseAdmin()
      const recipients = new Set<string>()

      if (data.contact_id) {
        const { data: c } = await (admin as any)
          .from('contacts')
          .select('owner_user_id, full_name')
          .eq('id', data.contact_id)
          .maybeSingle()
        if (c?.owner_user_id) {
          await notify({
            recipientUserId: c.owner_user_id,
            actorUserId: userId ?? null,
            kind: 'contact.note_added',
            title: 'New note on your contact',
            body: c.full_name ? `On ${c.full_name}` : null,
            href: `/contacts/${data.contact_id}`,
            contactId: data.contact_id,
            metadata: { note_id: data.id },
          })
          recipients.add(c.owner_user_id)
        }
      }

      if (data.listing_id) {
        const { data: l } = await (admin as any)
          .from('listings')
          .select('created_by, title')
          .eq('id', data.listing_id)
          .maybeSingle()
        if (l?.created_by && !recipients.has(l.created_by)) {
          await notify({
            recipientUserId: l.created_by,
            actorUserId: userId ?? null,
            kind: 'listing.note_added',
            title: 'New note on your listing',
            body: l.title ? `On ${l.title}` : null,
            href: `/listings`,
            listingId: data.listing_id,
            metadata: { note_id: data.id },
          })
        }
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, op: 'notes.notify' }, 'notes_notify_failed')
    }

    await logActivity({
      event,
      client,
      action: 'note.created',
      entity: 'note',
      entityId: data.id,
      metadata: {
        contact_id: data.contact_id ?? null,
        listing_id: data.listing_id ?? null,
        is_pinned: data.is_pinned ?? false,
        body_length: typeof data.body === 'string' ? data.body.length : 0,
      },
    })

    return data
  },

  /** Update a note. RLS gates own/team/all per notes.write.*. */
  async update({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: NoteUpdateInput
  }) {
    const client = await serverSupabaseClient(event)

    const update: Record<string, unknown> = {}
    for (const k of UPDATABLE_FIELDS) {
      if (input[k] !== undefined) update[k] = input[k] as unknown
    }

    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const { data, error } = await (client as any)
      .from('notes')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'notes.update', id }, 'notes_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Note not found or not editable',
      })
    }

    await logActivity({
      event,
      client,
      action: 'note.updated',
      entity: 'note',
      entityId: data.id,
      metadata: {
        fields: Object.keys(update),
        contact_id: data.contact_id ?? null,
        listing_id: data.listing_id ?? null,
      },
    })

    return data
  },

  /**
   * Hard-delete a note. RLS allows owner or notes.write.all only.
   * Snapshots cross-entity pivots BEFORE the delete so the timeline
   * doesn't lose the link the moment the note is gone.
   */
  async delete({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)

    const { data: snapshot } = await (client as any)
      .from('notes')
      .select('id, contact_id, listing_id')
      .eq('id', id)
      .maybeSingle()

    const { error, count } = await (client as any)
      .from('notes')
      .delete({ count: 'exact' })
      .eq('id', id)

    if (error) {
      logger.error({ err: error.message, op: 'notes.delete', id }, 'notes_delete_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!count) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Note not found or not deletable',
      })
    }

    await logActivity({
      event,
      client,
      action: 'note.deleted',
      entity: 'note',
      entityId: id,
      metadata: {
        contact_id: snapshot?.contact_id ?? null,
        listing_id: snapshot?.listing_id ?? null,
      },
    })

    return { success: true }
  },
}
