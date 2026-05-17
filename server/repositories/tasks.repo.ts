// Tasks repository â€” system of record for /api/tasks/*.
//
// Every server-side write to public.tasks SHOULD go through this repo.
// Co-locates four concerns that were previously inlined per endpoint:
//   1. Supabase insert/update/delete + RLS-aware filters
//   2. Audit log emission via logActivity()
//   3. Notification fanout via notify() (assignee on create)
//   4. Side-effect derivations (completed_at on status flips)
//
// Mirror of the listings.repo.ts pattern; the snake_case response
// envelope here matches existing tasks/notes/inquiries consumers
// (use server/utils/pagination.ts for the helper).
//
// Failure policy:
//   - Supabase errors throw 500 (or 404 on .maybeSingle returning null).
//   - Audit + notification calls are best-effort (logActivity / notify
//     swallow internally). They run AFTER the write succeeds so a
//     failed audit row never reverts the user's actual mutation.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'
import { pageRange, paginatedResponse } from '~~/server/utils/pagination'

type TaskStatus = 'open' | 'in_progress' | 'completed' | 'cancelled'
type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

export type TaskListFilters = {
  status?: TaskStatus
  /** 'me' â†’ only tasks assigned to the caller. */
  assigned?: 'me'
  /** True â†’ only tasks the caller owns (regardless of assignment). */
  mine?: boolean
  contact_id?: number
  listing_id?: number
  /** ISO datetime; tasks with due_at <= this are returned (overdue panel). */
  due_before?: string
}

export type TaskCreateInput = {
  title: string
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  due_at?: string | null
  contact_id?: number | null
  listing_id?: number | null
  assignee_user_id?: string | null
}

export type TaskUpdateInput = Partial<TaskCreateInput>

const UPDATABLE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'due_at',
  'contact_id',
  'listing_id',
  'assignee_user_id',
] as const

/** href to navigate to from a task notification â€” best-guess by available pivot. */
function taskNotificationHref(
  contactId: number | null | undefined,
  listingId: number | null | undefined,
): string | null {
  if (contactId) return `/contacts/${contactId}`
  if (listingId) return `/listings`
  return null
}

export const tasksRepo = {
  /**
   * List tasks. RLS scopes the rows the caller can see (own/team/all
   * via tasks.read.* + own-row + assignee fallthrough). Order: due_at
   * ASC nulls-last, then created_at DESC â€” undated stuff sinks below
   * the urgent dated stuff.
   */
  async list({
    event,
    page,
    pageSize,
    filters,
  }: {
    event: H3Event
    page: number
    pageSize: number
    filters: TaskListFilters
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    let q: any = (client as any)
      .from('tasks')
      .select('*', { count: 'exact' })
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })

    if (filters.status) q = q.eq('status', filters.status)
    if (filters.contact_id) q = q.eq('contact_id', filters.contact_id)
    if (filters.listing_id) q = q.eq('listing_id', filters.listing_id)
    if (filters.due_before) q = q.lte('due_at', filters.due_before)
    if (filters.assigned === 'me' && user?.id) {
      q = q.eq('assignee_user_id', user.id)
    }
    if (filters.mine && user?.id) {
      q = q.eq('owner_user_id', user.id)
    }

    const { from, to } = pageRange(page, pageSize)
    q = q.range(from, to)

    const { data, error, count } = await q
    if (error) {
      logger.error({ err: error.message, op: 'tasks.list' }, 'tasks_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    return paginatedResponse(data ?? [], count ?? 0, page, pageSize)
  },

  /**
   * Create a task. owner_user_id auto-stamps via DB DEFAULT auth.uid();
   * assignee defaults to the caller if not provided. Notifies the
   * assignee unless they're the caller. Emits task.created audit.
   */
  async create({
    event,
    input,
  }: {
    event: H3Event
    input: TaskCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)

    const insert: Record<string, unknown> = {
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'open',
      priority: input.priority ?? 'normal',
      due_at: input.due_at ?? null,
      contact_id: input.contact_id ?? null,
      listing_id: input.listing_id ?? null,
      assignee_user_id: input.assignee_user_id ?? user?.id ?? null,
    }

    const { data, error } = await (client as any)
      .from('tasks')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      logger.error({ err: error.message, op: 'tasks.create' }, 'tasks_create_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // notify() short-circuits when actor === recipient, so a self-assigned
    // task doesn't even need this guard â€” but skipping the call entirely
    // for the common self-assigned case avoids a service-role round trip.
    if (data.assignee_user_id && data.assignee_user_id !== user?.id) {
      await notify({
        recipientUserId: data.assignee_user_id,
        actorUserId: user?.id ?? null,
        kind: 'task.assigned',
        title: 'New task assigned to you',
        body: data.title,
        href: taskNotificationHref(data.contact_id, data.listing_id),
        contactId: data.contact_id ?? null,
        listingId: data.listing_id ?? null,
        metadata: {
          task_id: data.id,
          priority: data.priority,
          due_at: data.due_at,
        },
      })
    }

    await logActivity({
      event,
      client,
      action: 'task.created',
      entity: 'task',
      entityId: data.id,
      metadata: {
        title: data.title,
        priority: data.priority,
        due_at: data.due_at ?? null,
        contact_id: data.contact_id ?? null,
        listing_id: data.listing_id ?? null,
        assignee_user_id: data.assignee_user_id ?? null,
      },
    })

    return data
  },

  /**
   * Update a task. RLS gates own/team/all per tasks.write.* permissions.
   * Status flip to 'completed' auto-stamps completed_at; flipping back
   * to anything else nulls it. Emits task.updated audit with the diff
   * keys + new status.
   */
  async update({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: TaskUpdateInput
  }) {
    const client = await serverSupabaseClient(event)

    const update: Record<string, unknown> = {}
    for (const k of UPDATABLE_FIELDS) {
      if (input[k] !== undefined) update[k] = input[k] as unknown
    }

    if (input.status !== undefined) {
      // completed_at is a derived audit timestamp â€” only meaningful when
      // the user transitions INTO 'completed'. Other transitions (or
      // toggling back out) reset it to null so the field can't lie.
      update.completed_at =
        input.status === 'completed' ? new Date().toISOString() : null
    }

    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const { data, error } = await (client as any)
      .from('tasks')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      logger.error({ err: error.message, op: 'tasks.update', id }, 'tasks_update_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Task not found or not editable',
      })
    }

    await logActivity({
      event,
      client,
      action: 'task.updated',
      entity: 'task',
      entityId: data.id,
      metadata: {
        // Diff keys, not full body â€” reports differentiate "status flip"
        // from "title rename" without scanning every field. Includes the
        // new status so dashboards can filter for completion events
        // without a separate task.completed action.
        fields: Object.keys(update),
        status: input.status ?? null,
        contact_id: data.contact_id ?? null,
        listing_id: data.listing_id ?? null,
      },
    })

    return data
  },

  /**
   * Hard-delete a task. RLS allows owner or tasks.write.all only.
   * Snapshots contact_id/listing_id BEFORE the delete so the audit row
   * keeps the cross-entity pivots the unified timeline indexes on.
   */
  async delete({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)

    const { data: snapshot } = await (client as any)
      .from('tasks')
      .select('id, contact_id, listing_id, title')
      .eq('id', id)
      .maybeSingle()

    const { error, count } = await (client as any)
      .from('tasks')
      .delete({ count: 'exact' })
      .eq('id', id)

    if (error) {
      logger.error({ err: error.message, op: 'tasks.delete', id }, 'tasks_delete_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!count) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Task not found or not deletable',
      })
    }

    await logActivity({
      event,
      client,
      action: 'task.deleted',
      entity: 'task',
      entityId: id,
      metadata: {
        title: snapshot?.title ?? null,
        contact_id: snapshot?.contact_id ?? null,
        listing_id: snapshot?.listing_id ?? null,
      },
    })

    return { success: true }
  },
}
