// Closing-milestones repository â€” system of record for
// /api/deals/[id]/milestones/* and /api/deals/[id]/closing-status.
//
// Milestones inherit deal RLS via deal_can_read / deal_can_write â€”
// repository defers to the DB for authorization rather than
// duplicating the predicate in TS. Caller-side rejections are 401
// (no user) or 403 (write attempt without write privileges).

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export type MilestoneStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'blocked'

export type MilestoneEvidence = {
  kind: 'document' | 'note' | 'external' | 'commission_ledger'
  ref?: string | number
  label?: string
}

export type MilestoneCreateInput = {
  milestone_key: string
  title: string
  description?: string | null
  sequence?: number
  required?: boolean
  due_at?: string | null
  evidence?: MilestoneEvidence | Record<string, unknown>
  notes?: string | null
}

export type MilestonePatchInput = {
  title?: string
  description?: string | null
  sequence?: number
  required?: boolean
  status?: MilestoneStatus
  due_at?: string | null
  evidence?: MilestoneEvidence | Record<string, unknown>
  notes?: string | null
  blocked_reason?: string | null
  skipped_reason?: string | null
}

export const milestonesRepo = {
  async list({ event, dealId }: { event: H3Event; dealId: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('deal_milestones')
      .select(
        'id, deal_id, source_template_id, source_template_item_id, milestone_key, ' +
          'title, description, sequence, required, status, due_at, started_at, ' +
          'completed_at, completed_by, blocked_reason, skipped_reason, evidence, ' +
          'notes, created_at, updated_at',
      )
      .eq('deal_id', dealId)
      .order('sequence', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) {
      logger.error({ err: error.message, op: 'milestones.list', dealId }, 'milestones_list_failed')
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async create({
    event,
    dealId,
    input,
  }: {
    event: H3Event
    dealId: string
    input: MilestoneCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any)
      .from('deal_milestones')
      .insert({
        deal_id: dealId,
        milestone_key: input.milestone_key,
        title: input.title,
        description: input.description ?? null,
        sequence: input.sequence ?? 0,
        required: input.required ?? true,
        due_at: input.due_at ?? null,
        evidence: input.evidence ?? {},
        notes: input.notes ?? null,
      })
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'milestones.create', dealId },
        'milestones_create_failed',
      )
      // 23505 = unique_violation on (deal_id, milestone_key)
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `Milestone key '${input.milestone_key}' already exists on this deal`,
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'deal.milestone_created',
      entity: 'deal',
      entityId: dealId,
      metadata: { milestone_key: input.milestone_key, milestone_id: data.id },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestones_create_activity_log_failed',
      )
    })

    return data
  },

  async patch({
    event,
    dealId,
    milestoneId,
    input,
  }: {
    event: H3Event
    dealId: string
    milestoneId: string
    input: MilestonePatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const updates: Record<string, unknown> = {}
    if (input.title !== undefined) updates.title = input.title
    if (input.description !== undefined) updates.description = input.description
    if (input.sequence !== undefined) updates.sequence = input.sequence
    if (input.required !== undefined) updates.required = input.required
    if (input.due_at !== undefined) updates.due_at = input.due_at
    if (input.evidence !== undefined) updates.evidence = input.evidence
    if (input.notes !== undefined) updates.notes = input.notes
    if (input.blocked_reason !== undefined) updates.blocked_reason = input.blocked_reason
    if (input.skipped_reason !== undefined) updates.skipped_reason = input.skipped_reason

    if (input.status !== undefined) {
      updates.status = input.status
      // Auto-stamp transitions so the UI doesn't have to compute them.
      if (input.status === 'in_progress') {
        updates.started_at = new Date().toISOString()
      }
      if (input.status === 'completed') {
        updates.completed_at = new Date().toISOString()
        updates.completed_by = user.id
      }
      // Clearing a completion: explicit reset, not implicit.
      if (input.status === 'pending' || input.status === 'in_progress') {
        updates.completed_at = null
        updates.completed_by = null
      }
    }

    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }

    const { data, error } = await (client as any)
      .from('deal_milestones')
      .update(updates)
      .eq('id', milestoneId)
      .eq('deal_id', dealId)
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'milestones.patch', dealId, milestoneId },
        'milestones_patch_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Milestone not found' })
    }

    logActivity({
      event,
      action: 'deal.milestone_updated',
      entity: 'deal',
      entityId: dealId,
      metadata: {
        milestone_id: milestoneId,
        milestone_key: data.milestone_key,
        status: data.status,
        changed: Object.keys(updates),
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestones_patch_activity_log_failed',
      )
    })

    return data
  },

  async remove({
    event,
    dealId,
    milestoneId,
  }: {
    event: H3Event
    dealId: string
    milestoneId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { error } = await (client as any)
      .from('deal_milestones')
      .delete()
      .eq('id', milestoneId)
      .eq('deal_id', dealId)
    if (error) {
      logger.error(
        { err: error.message, op: 'milestones.remove', dealId, milestoneId },
        'milestones_remove_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    logActivity({
      event,
      action: 'deal.milestone_removed',
      entity: 'deal',
      entityId: dealId,
      metadata: { milestone_id: milestoneId },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestones_remove_activity_log_failed',
      )
    })
    return { ok: true }
  },

  async applyTemplate({
    event,
    dealId,
    templateId,
    anchorAt,
  }: {
    event: H3Event
    dealId: string
    templateId: string
    anchorAt?: string
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('apply_milestone_template', {
      p_deal_id: dealId,
      p_template_id: templateId,
      p_anchor_at: anchorAt ?? new Date().toISOString(),
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'milestones.applyTemplate', dealId, templateId },
        'milestones_apply_template_failed',
      )
      // Permission denied surface from the RPC (errcode 42501)
      if ((error as any).code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      if ((error as any).code === 'P0002') {
        throw createError({ statusCode: 404, statusMessage: 'Template not found or inactive' })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    const row = Array.isArray(data) ? data[0] : data
    logActivity({
      event,
      action: 'deal.milestone_template_applied',
      entity: 'deal',
      entityId: dealId,
      metadata: { template_id: templateId, ...row },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'milestones_apply_template_activity_log_failed',
      )
    })

    return {
      created_count: row?.created_count ?? 0,
      skipped_count: row?.skipped_count ?? 0,
    }
  },

  async closingStatus({ event, dealId }: { event: H3Event; dealId: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('deal_closing_status')
      .select(
        'deal_id, required_total, required_done, required_blocked, total, done, ' +
          'can_close, pct_complete, next_milestone_id',
      )
      .eq('deal_id', dealId)
      .maybeSingle()

    if (error) {
      logger.error(
        { err: error.message, op: 'milestones.closingStatus', dealId },
        'milestones_closing_status_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    // The view emits one row per deal regardless of milestone count.
    // null here means the deal id wasn't visible (RLS) or doesn't exist.
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Deal not found' })
    }
    return data
  },
}
