// Reviews repository â€” system of record for /api/reviews/* endpoints.
//
// Operations: create / update / hide / unhide / report / listForTarget.
//
// Audit on every mutation:
//   create   â†’ review.created    + notify(review.received) to target user (if applicable)
//   update   â†’ review.updated
//   hide     â†’ review.hidden     + notify(review.hidden) to reviewer
//   unhide   â†’ review.unhidden
//   report   â†’ review.reported   + notify(review.reported) to moderators
//
// Self-review prevention happens DB-side via the reviews_validate
// trigger (migration 20260507000018) â€” no need to duplicate that
// check here. Format checks too. We just translate Postgres errors
// to clean HTTP responses.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'

export type ReviewTargetType =
  | 'agent'
  | 'building'
  | 'developer'
  | 'listing'
  | 'owner'

export type ReviewCreateInput = {
  targetType: ReviewTargetType
  targetId: string
  rating: number  // 1.0 â€“ 5.0
  title?: string | null
  body: string
  dimensions?: Record<string, number>
  evidenceKind?: 'inquiry' | 'shared_listing' | 'transaction' | 'manual'
  evidenceRef?: string
  reviewerDisplay?: 'full_name' | 'initials_only' | 'hidden'
}

const ALLOWED_DIMENSION_KEYS = new Set([
  'responsiveness',
  'professionalism',
  'accuracy',
  'transparency',
  'property_condition',
])

function sanitizeDimensions(
  raw: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw) return out
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_DIMENSION_KEYS.has(k)) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (v < 1.0 || v > 5.0) continue
    out[k] = v
  }
  return out
}

function pgErrorToHttp(err: any): never {
  const msg = (err?.message || '').toLowerCase()
  // Self-review / format-check failures from the trigger.
  if (err?.code === '22023') {
    throw createError({ statusCode: 400, statusMessage: err.message })
  }
  // UNIQUE violation (one review per reviewer Ã— target).
  if (err?.code === '23505') {
    throw createError({
      statusCode: 409,
      statusMessage: 'You have already reviewed this. Edit your existing review instead.',
    })
  }
  // FK violation (e.g., listing/profile gone).
  if (err?.code === '23503') {
    throw createError({ statusCode: 404, statusMessage: 'Review target not found' })
  }
  if (msg.includes('row-level security')) {
    throw createError({ statusCode: 403, statusMessage: err.message })
  }
  throw createError({ statusCode: 500, statusMessage: err?.message || 'Review write failed' })
}

export const reviewsRepo = {
  /**
   * Create or upsert a review. The (reviewer, target_type, target_id)
   * UNIQUE means a re-submit by the same reviewer on the same target
   * is treated as an UPDATE â€” preserves the "one review per pair"
   * rating-distribution honesty.
   */
  async create({ event, input }: { event: H3Event; input: ReviewCreateInput }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const dimensions = sanitizeDimensions(input.dimensions)

    const { data, error } = await (client as any)
      .from('reviews')
      .upsert(
        {
          target_type: input.targetType,
          target_id: input.targetId,
          reviewer_user_id: user.id,
          rating: input.rating,
          title: input.title?.trim() || null,
          body: input.body.trim(),
          dimensions,
          evidence_kind: input.evidenceKind || null,
          evidence_ref: input.evidenceRef || null,
          reviewer_display: input.reviewerDisplay || 'full_name',
        },
        { onConflict: 'reviewer_user_id,target_type,target_id' },
      )
      .select('*')
      .single()

    if (error) pgErrorToHttp(error)

    await logActivity({
      event,
      client,
      action: 'review.created',
      entity: 'review',
      entityId: data.id,
      metadata: {
        target_type: input.targetType,
        target_id: input.targetId,
        rating: input.rating,
      },
    })

    // Notify the review target (agent / owner) when applicable. The
    // target_id for those types is a uuid pointing at profiles. For
    // listing reviews, notify the listing's created_by. For building
    // reviews, no notification (no single owner).
    let targetUserId: string | null = null
    if (input.targetType === 'agent' || input.targetType === 'owner') {
      targetUserId = input.targetId
    } else if (input.targetType === 'listing') {
      const { data: listing } = await (client as any)
        .from('listings')
        .select('created_by')
        .eq('id', input.targetId)
        .maybeSingle()
      targetUserId = listing?.created_by ?? null
    }
    if (targetUserId && targetUserId !== user.id) {
      try {
        await notify({
          recipientUserId: targetUserId,
          actorUserId: user.id,
          kind: 'review.received',
          title: 'You received a new review',
          body:
            data.rating >= 4
              ? `${data.rating.toFixed(1)} â˜… â€” ${data.title || 'New review'}`
              : `${data.rating.toFixed(1)} â˜… â€” ${data.title || 'A new review was posted'}`,
          href: `/reviews/${encodeURIComponent(data.id)}`,
          metadata: { review_id: data.id, rating: data.rating },
        })
      } catch (err: any) {
        logger.warn(
          { err: err?.message, op: 'reviews.create.notify' },
          'review_notify_failed',
        )
      }
    }

    return data
  },

  async listForTarget({
    event,
    targetType,
    targetId,
    page,
    pageSize,
  }: {
    event: H3Event
    targetType: ReviewTargetType
    targetId: string
    page: number
    pageSize: number
  }) {
    const client = await serverSupabaseClient(event)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    const { data, error, count } = await (client as any)
      .from('reviews')
      .select(
        `id, rating, title, body, dimensions, reviewer_display,
         evidence_kind, created_at, updated_at,
         reviewer:profiles!reviews_reviewer_user_id_fkey (id, full_name, avatar_url, slug)`,
        { count: 'exact' },
      )
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .is('hidden_at', null)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) {
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    // Apply reviewer_display privacy: redact full_name based on the
    // reviewer's preference.
    const rows = (data ?? []).map((r: any) => {
      const display = r.reviewer_display
      if (!r.reviewer) return r
      if (display === 'hidden') {
        return { ...r, reviewer: { id: r.reviewer.id, full_name: null, avatar_url: null, slug: null } }
      }
      if (display === 'initials_only') {
        const initials = (r.reviewer.full_name || '')
          .split(/\s+/)
          .filter(Boolean)
          .map((s: string) => s[0]!.toUpperCase())
          .join('')
        return {
          ...r,
          reviewer: { ...r.reviewer, full_name: initials || 'Anonymous', slug: null },
        }
      }
      return r
    })

    return {
      data: rows,
      total: count ?? 0,
      page,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
    }
  },

  async update({
    event,
    id,
    rating,
    title,
    body,
    dimensions,
    reviewerDisplay,
  }: {
    event: H3Event
    id: string
    rating?: number
    title?: string | null
    body?: string
    dimensions?: Record<string, number>
    reviewerDisplay?: 'full_name' | 'initials_only' | 'hidden'
  }) {
    const client = await serverSupabaseClient(event)
    const update: Record<string, unknown> = {}
    if (rating !== undefined) update.rating = rating
    if (title !== undefined) update.title = title?.trim() || null
    if (body !== undefined) update.body = body.trim()
    if (dimensions !== undefined) update.dimensions = sanitizeDimensions(dimensions)
    if (reviewerDisplay !== undefined) update.reviewer_display = reviewerDisplay

    if (Object.keys(update).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    const { data, error } = await (client as any)
      .from('reviews')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) pgErrorToHttp(error)
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Review not found or not editable' })
    }

    await logActivity({
      event,
      client,
      action: 'review.updated',
      entity: 'review',
      entityId: data.id,
      metadata: {
        target_type: data.target_type,
        target_id: data.target_id,
        fields: Object.keys(update),
      },
    })

    return data
  },

  async report({
    event,
    reviewId,
    reason,
  }: {
    event: H3Event
    reviewId: string
    reason: string
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any)
      .from('review_reports')
      .upsert(
        {
          review_id: reviewId,
          reporter_user_id: user.id,
          reason: reason.trim(),
        },
        { onConflict: 'review_id,reporter_user_id' },
      )
      .select('*')
      .single()

    if (error) pgErrorToHttp(error)

    await logActivity({
      event,
      client,
      action: 'review.reported',
      entity: 'review',
      entityId: reviewId,
      metadata: { report_id: data.id, reason: reason.slice(0, 200) },
    })

    return data
  },

  async hide({
    event,
    id,
    reason,
  }: {
    event: H3Event
    id: string
    reason: string
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    const { data, error } = await (client as any)
      .from('reviews')
      .update({
        hidden_at: new Date().toISOString(),
        hidden_reason: reason.trim(),
        hidden_by: user?.id ?? null,
      })
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) pgErrorToHttp(error)
    if (!data) {
      throw createError({ statusCode: 404, statusMessage: 'Review not found' })
    }

    await logActivity({
      event,
      client,
      action: 'review.hidden',
      entity: 'review',
      entityId: id,
      metadata: { reason: reason.slice(0, 200), target_type: data.target_type },
    })

    return data
  },
}
