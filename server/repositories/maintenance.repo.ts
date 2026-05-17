// Maintenance repository â€” requests + work orders.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const MR_SELECT =
  'id, request_no, unit_id, lease_id, reported_by_user_id, ' +
  'reported_by_contact_id, reporter_external_name, reporter_external_email, ' +
  'reporter_role, title, description, category, urgency, photos, ' +
  'access_window, access_granted, status, resolution_summary, ' +
  'tenant_satisfaction, reported_at, triaged_at, scheduled_at, in_progress_at, ' +
  'resolved_at, closed_at, cancelled_at, metadata, created_at, updated_at'

const WO_SELECT =
  'id, work_order_no, maintenance_request_id, unit_id, vendor_id, ' +
  'assigned_user_id, title, description, scope, cost_estimate_minor, ' +
  'cost_actual_minor, currency, billing_target, scheduled_at, started_at, ' +
  'completed_at, cancelled_at, status, photos_before, photos_after, ' +
  'parts_used, completion_notes, approved_by, approved_at, metadata, ' +
  'created_by, created_at, updated_at'

export type RequestCreateInput = {
  unit_id: string
  lease_id?: string | null
  reported_by_user_id?: string | null
  reported_by_contact_id?: number | null
  reporter_external_name?: string | null
  reporter_external_email?: string | null
  reporter_role?: 'tenant' | 'owner' | 'manager' | 'visitor' | 'staff'
  title: string
  description?: string | null
  category: string
  urgency?: 'emergency' | 'high' | 'normal' | 'low'
  photos?: string[]
  access_window?: Record<string, unknown>
  access_granted?: boolean
  metadata?: Record<string, unknown>
}

export type RequestPatchInput = Partial<RequestCreateInput> & {
  status?: 'scheduled' | 'in_progress' | 'resolved' | 'closed' | 'cancelled'
  resolution_summary?: string | null
  tenant_satisfaction?: number | null
}

export type WorkOrderCreateInput = {
  maintenance_request_id?: string | null
  unit_id: string
  vendor_id?: string | null
  assigned_user_id?: string | null
  title: string
  description?: string | null
  scope?: string | null
  cost_estimate_minor?: number | null
  currency?: string
  billing_target?: 'owner' | 'tenant' | 'platform'
  scheduled_at?: string | null
  metadata?: Record<string, unknown>
}

export type WorkOrderPatchInput = Partial<WorkOrderCreateInput> & {
  status?: 'pending_assignment' | 'in_progress' | 'completed' | 'cancelled'
  cost_actual_minor?: number | null
  started_at?: string | null
  completed_at?: string | null
  photos_before?: Array<Record<string, unknown> | string>
  photos_after?: Array<Record<string, unknown> | string>
  parts_used?: Array<Record<string, unknown>>
  completion_notes?: string | null
  approved_by?: string | null
  approved_at?: string | null
}

export const maintenanceRepo = {
  // ===== requests =====
  async listRequests({
    event,
    unitId,
    leaseId,
    status,
  }: {
    event: H3Event
    unitId?: string
    leaseId?: string
    status?: string
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('maintenance_requests')
      .select(MR_SELECT)
      .order('reported_at', { ascending: false })
    if (unitId) q = q.eq('unit_id', unitId)
    if (leaseId) q = q.eq('lease_id', leaseId)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async getRequest({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('maintenance_requests')
      .select(MR_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Request not found' })
    }
    return data
  },

  async createRequest({
    event,
    input,
  }: {
    event: H3Event
    input: RequestCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    // Default reporter_by_user_id to caller if not set.
    const reportedBy = input.reported_by_user_id ?? user.id

    const { data, error } = await (client as any)
      .from('maintenance_requests')
      .insert({
        unit_id: input.unit_id,
        lease_id: input.lease_id ?? null,
        reported_by_user_id: reportedBy,
        reported_by_contact_id: input.reported_by_contact_id ?? null,
        reporter_external_name: input.reporter_external_name ?? null,
        reporter_external_email: input.reporter_external_email ?? null,
        reporter_role: input.reporter_role ?? null,
        title: input.title,
        description: input.description ?? null,
        category: input.category,
        urgency: input.urgency ?? 'normal',
        photos: input.photos ?? [],
        access_window: input.access_window ?? {},
        access_granted: input.access_granted ?? false,
        metadata: input.metadata ?? {},
      })
      .select(MR_SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'maintenance.createRequest' },
        'maintenance_create_request_failed',
      )
      if ((error as any).code === '23514') {
        throw createError({ statusCode: 400, statusMessage: error.message })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'maintenance.requested',
      entity: 'building',
      entityId: null,
      metadata: { request_id: data.id, unit_id: data.unit_id, urgency: data.urgency },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'maintenance_create_request_activity_log_failed',
      )
    })
    return data
  },

  async patchRequest({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: RequestPatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'lease_id', 'title', 'description', 'category', 'urgency',
      'photos', 'access_window', 'access_granted', 'metadata',
      'resolution_summary', 'tenant_satisfaction', 'status',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }

    // Auto-stamp lifecycle fields based on status transitions.
    if (input.status === 'scheduled' && updates.scheduled_at === undefined) {
      updates.scheduled_at = new Date().toISOString()
    }
    if (input.status === 'in_progress' && updates.in_progress_at === undefined) {
      updates.in_progress_at = new Date().toISOString()
    }
    if (input.status === 'resolved' && updates.resolved_at === undefined) {
      updates.resolved_at = new Date().toISOString()
    }
    if (input.status === 'closed' && updates.closed_at === undefined) {
      updates.closed_at = new Date().toISOString()
    }
    if (input.status === 'cancelled' && updates.cancelled_at === undefined) {
      updates.cancelled_at = new Date().toISOString()
    }

    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('maintenance_requests')
      .update(updates)
      .eq('id', id)
      .select(MR_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Request not found' })
    }
    return data
  },

  async triage({
    event,
    id,
    status,
    notes,
  }: {
    event: H3Event
    id: string
    status: 'triaged' | 'cancelled'
    notes?: string | null
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('maintenance_triage', {
      p_request_id: id,
      p_status: status,
      p_notes: notes ?? null,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Request not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: status === 'triaged' ? 'maintenance.triaged' : 'maintenance.cancelled',
      entity: 'building',
      entityId: null,
      metadata: { request_id: id, notes: notes ?? null },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'maintenance_triage_activity_log_failed',
      )
    })

    return { request_id: data ?? id }
  },

  // ===== work orders =====
  async listWorkOrders({
    event,
    unitId,
    requestId,
    vendorId,
    status,
  }: {
    event: H3Event
    unitId?: string
    requestId?: string
    vendorId?: string
    status?: string
  }) {
    const client = await serverSupabaseClient(event)
    let q = (client as any)
      .from('work_orders')
      .select(WO_SELECT)
      .order('scheduled_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (unitId) q = q.eq('unit_id', unitId)
    if (requestId) q = q.eq('maintenance_request_id', requestId)
    if (vendorId) q = q.eq('vendor_id', vendorId)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async getWorkOrder({ event, id }: { event: H3Event; id: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('work_orders')
      .select(WO_SELECT)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Work order not found' })
    }
    return data
  },

  async createWorkOrder({
    event,
    input,
  }: {
    event: H3Event
    input: WorkOrderCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const initialStatus =
      input.vendor_id || input.assigned_user_id ? 'assigned' : 'draft'

    const { data, error } = await (client as any)
      .from('work_orders')
      .insert({
        maintenance_request_id: input.maintenance_request_id ?? null,
        unit_id: input.unit_id,
        vendor_id: input.vendor_id ?? null,
        assigned_user_id: input.assigned_user_id ?? null,
        title: input.title,
        description: input.description ?? null,
        scope: input.scope ?? null,
        cost_estimate_minor: input.cost_estimate_minor ?? null,
        currency: input.currency ?? 'PHP',
        billing_target: input.billing_target ?? 'owner',
        scheduled_at: input.scheduled_at ?? null,
        status: initialStatus,
        metadata: input.metadata ?? {},
        created_by: user.id,
      })
      .select(WO_SELECT)
      .single()
    if (error) {
      logger.error(
        { err: error.message, op: 'maintenance.createWorkOrder' },
        'work_order_create_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // If a request linked, bump the request to scheduled.
    if (input.maintenance_request_id) {
      await (client as any)
        .from('maintenance_requests')
        .update({ status: 'scheduled', scheduled_at: new Date().toISOString() })
        .eq('id', input.maintenance_request_id)
        .in('status', ['submitted', 'triaged'])
    }

    logActivity({
      event,
      action: 'work_order.created',
      entity: 'building',
      entityId: null,
      metadata: { work_order_id: data.id, unit_id: data.unit_id, status: data.status },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'work_order_create_activity_log_failed',
      )
    })
    return data
  },

  async patchWorkOrder({
    event,
    id,
    input,
  }: {
    event: H3Event
    id: string
    input: WorkOrderPatchInput
  }) {
    const client = await serverSupabaseClient(event)
    const updates: Record<string, unknown> = {}
    for (const k of [
      'maintenance_request_id', 'unit_id', 'vendor_id', 'assigned_user_id',
      'title', 'description', 'scope',
      'cost_estimate_minor', 'cost_actual_minor', 'currency', 'billing_target',
      'scheduled_at', 'started_at', 'completed_at',
      'photos_before', 'photos_after', 'parts_used', 'completion_notes',
      'approved_by', 'approved_at', 'metadata', 'status',
    ] as const) {
      if ((input as any)[k] !== undefined) updates[k] = (input as any)[k]
    }

    if (input.status === 'in_progress' && updates.started_at === undefined) {
      updates.started_at = new Date().toISOString()
    }
    if (input.status === 'completed' && updates.completed_at === undefined) {
      updates.completed_at = new Date().toISOString()
    }
    if (input.status === 'cancelled' && updates.cancelled_at === undefined) {
      updates.cancelled_at = new Date().toISOString()
    }

    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No updatable fields supplied' })
    }
    const { data, error } = await (client as any)
      .from('work_orders')
      .update(updates)
      .eq('id', id)
      .select(WO_SELECT)
      .single()
    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Work order not found' })
    }
    return data
  },

  async assignWorkOrder({
    event,
    id,
    vendorId,
    assignedUserId,
  }: {
    event: H3Event
    id: string
    vendorId?: string | null
    assignedUserId?: string | null
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('work_order_assign', {
      p_work_order_id: id,
      p_vendor_id: vendorId ?? null,
      p_assigned_user_id: assignedUserId ?? null,
    })
    if (error) {
      const code = (error as any).code
      if (code === '42501') throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      if (code === 'P0002') throw createError({ statusCode: 404, statusMessage: 'Work order not found' })
      throw createError({ statusCode: 400, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'work_order.assigned',
      entity: 'building',
      entityId: null,
      metadata: {
        work_order_id: id,
        vendor_id: vendorId ?? null,
        assigned_user_id: assignedUserId ?? null,
      },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'work_order_assign_activity_log_failed',
      )
    })

    return { work_order_id: data ?? id }
  },
}
