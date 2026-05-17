// Recent activity feed for the dashboard. Reads from the `activities`
// audit table (see 20260429000006_phase4_rbac_audit.sql) which already
// has RLS — managers/admins see team/all per their permissions, agents
// see their own actions. Returns the last 20 events with actor profile
// hydration so the widget can render "<Full Name> · <action> · <time>"
// without per-row joins on the client.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  from:  z.string().datetime({ offset: true }).optional(),
  to:    z.string().datetime({ offset: true }).optional(),
})

export default defineApiHandler({
  query: querySchema,
  auth: 'required',
  handler: async ({ event, query }) => {
    const supabase = await serverSupabaseClient(event)
    const q = query as z.infer<typeof querySchema>
    const limit = q.limit ?? 20

    // Step 1: read the audit rows. Avoid PostgREST embed syntax for
    // the actor join — relying on FK constraint names couples this to
    // the activities migration's exact constraint label, which has
    // drifted in some environments. Batch-hydrate actor profiles
    // afterward instead.
    //
    // Column note: activities.user_id is the actor (see migration
    // 20260429000006). It is NOT actor_user_id (that name lives on
    // public.notifications). We alias it on read so downstream code
    // can stay column-agnostic.
    let queryBuilder = (supabase as any)
      .from('activities')
      .select('id, action, entity, created_at, user_id, metadata')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (q.from) queryBuilder = queryBuilder.gte('created_at', q.from)
    if (q.to)   queryBuilder = queryBuilder.lte('created_at', q.to)
    const { data: rows, error } = await queryBuilder

    if (error) {
      logger.error({ err: error.message, op: 'dashboard.activity' }, 'dashboard_activity_failed')
      return { data: [] }
    }

    const auditRows = (rows ?? []) as Array<{
      id: string
      action: string
      entity: string
      created_at: string
      user_id: string | null
      metadata: Record<string, unknown> | null
    }>

    // Step 2: batch-hydrate actor profiles. RLS on profiles allows
    // authenticated reads; we don't need service-role here.
    const actorIds = Array.from(
      new Set(auditRows.map((r) => r.user_id).filter((x): x is string => !!x)),
    )
    const actorMap = new Map<string, { id: string; full_name: string | null; avatar_url: string | null }>()
    if (actorIds.length > 0) {
      const { data: profiles } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', actorIds)
      for (const p of ((profiles ?? []) as any[])) {
        actorMap.set(p.id, p)
      }
    }

    // Step 3: shape the response — same { actor: { … } | null } shape
    // the widget expected from the embed, no client change needed.
    const data = auditRows.map((r) => ({
      id: r.id,
      action: r.action,
      entity: r.entity,
      created_at: r.created_at,
      actor: r.user_id ? actorMap.get(r.user_id) ?? null : null,
      metadata: r.metadata,
    }))

    return { data }
  },
})
