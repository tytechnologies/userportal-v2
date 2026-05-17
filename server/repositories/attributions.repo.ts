// Attributions repository â€” links a deal to one or more
// referral_agreements. Backs /api/deals/[id]/attributions/* and
// /api/deals/[id]/attribution-chain.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

const ATTRIBUTION_SELECT =
  'id, deal_id, agreement_id, attributed_by, attributed_at, notes'

export const attributionsRepo = {
  async listForDeal({ event, dealId }: { event: H3Event; dealId: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any)
      .from('referral_attributions')
      .select(ATTRIBUTION_SELECT)
      .eq('deal_id', dealId)
      .order('attributed_at', { ascending: false })
    if (error) {
      logger.error(
        { err: error.message, op: 'attributions.list', dealId },
        'attributions_list_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { items: data ?? [] }
  },

  async attach({
    event,
    dealId,
    agreementId,
    notes,
  }: {
    event: H3Event
    dealId: string
    agreementId: string
    notes?: string | null
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data, error } = await (client as any)
      .from('referral_attributions')
      .insert({
        deal_id: dealId,
        agreement_id: agreementId,
        attributed_by: user.id,
        notes: notes ?? null,
      })
      .select(ATTRIBUTION_SELECT)
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'attributions.attach', dealId, agreementId },
        'attributions_attach_failed',
      )
      // 23505 = unique_violation on (deal_id, agreement_id)
      if ((error as any).code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: 'This deal is already attributed to that agreement',
        })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    logActivity({
      event,
      action: 'deal.referral_attributed',
      entity: 'deal',
      entityId: dealId,
      metadata: { attribution_id: data.id, agreement_id: agreementId },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'attributions_attach_activity_log_failed',
      )
    })

    return data
  },

  async detach({
    event,
    dealId,
    attributionId,
  }: {
    event: H3Event
    dealId: string
    attributionId: string
  }) {
    const client = await serverSupabaseClient(event)
    const { error } = await (client as any)
      .from('referral_attributions')
      .delete()
      .eq('id', attributionId)
      .eq('deal_id', dealId)
    if (error) {
      logger.error(
        { err: error.message, op: 'attributions.detach', dealId, attributionId },
        'attributions_detach_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    logActivity({
      event,
      action: 'deal.referral_unattributed',
      entity: 'deal',
      entityId: dealId,
      metadata: { attribution_id: attributionId },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'attributions_detach_activity_log_failed',
      )
    })
    return { ok: true }
  },

  async chain({
    event,
    dealId,
    maxDepth = 10,
  }: {
    event: H3Event
    dealId: string
    maxDepth?: number
  }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('referral_chain_for_deal', {
      p_deal_id: dealId,
      p_max_depth: maxDepth,
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'attributions.chain', dealId },
        'attributions_chain_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { rows: data ?? [] }
  },

  async previewSplit({ event, dealId }: { event: H3Event; dealId: string }) {
    const client = await serverSupabaseClient(event)
    const { data, error } = await (client as any).rpc('preview_commission_split', {
      p_deal_id: dealId,
    })
    if (error) {
      logger.error(
        { err: error.message, op: 'attributions.previewSplit', dealId },
        'attributions_preview_split_failed',
      )
      if ((error as any).code === '42501') {
        throw createError({ statusCode: 403, statusMessage: 'Permission denied' })
      }
      throw createError({ statusCode: 500, statusMessage: error.message })
    }
    return { candidates: data ?? [] }
  },
}
