// Onboarding repository â€” self-serve organization creation.
//
// All work goes through the onboarding_create_organization SECURITY
// DEFINER RPC, which:
//   - validates auth.uid()
//   - generates a unique slug (or accepts a validated override)
//   - creates the organizations row
//   - creates the brokerage_owner organization_memberships row
//   - relies on the B4 trigger to auto-subscribe to the free plan

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { serverSupabaseUser } from '../utils/sbUser'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'

export type OnboardingCreateInput = {
  name: string
  description?: string | null
  slug?: string | null
}

const ORG_SELECT =
  'id, name, slug, description, owner_user_id, verified, branding, ' +
  'created_at, updated_at'

export const onboardingRepo = {
  async createOrganization({
    event,
    input,
  }: {
    event: H3Event
    input: OnboardingCreateInput
  }) {
    const client = await serverSupabaseClient(event)
    const user = await serverSupabaseUser(event)
    if (!user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
    }

    const { data: orgId, error } = await (client as any).rpc(
      'onboarding_create_organization',
      {
        p_name: input.name,
        p_description: input.description ?? null,
        p_slug_override: input.slug ?? null,
      },
    )
    if (error) {
      logger.error(
        { err: error.message, op: 'onboarding.createOrganization' },
        'onboarding_create_organization_failed',
      )
      const code = (error as any).code
      const msg = error.message ?? ''
      if (code === '42501') {
        throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
      }
      if (code === '23505' || msg.includes('slug')) {
        throw createError({ statusCode: 409, statusMessage: msg })
      }
      throw createError({ statusCode: 400, statusMessage: msg || 'Create failed' })
    }

    // Fetch the assembled view (org + plan).
    const { data: org } = await (client as any)
      .from('organizations')
      .select(ORG_SELECT)
      .eq('id', orgId)
      .maybeSingle()

    const { data: subscription } = await (client as any)
      .from('organization_subscriptions')
      .select('id, plan_id, status, effective_at, expires_at, granted_reason')
      .eq('organization_id', orgId)
      .in('status', ['active', 'trialing'])
      .maybeSingle()

    let plan: any = null
    if (subscription) {
      const { data: planRow } = await (client as any)
        .from('plans')
        .select('id, code, name, tier, status')
        .eq('id', subscription.plan_id)
        .maybeSingle()
      plan = planRow
    }

    logActivity({
      event,
      action: 'organization.created_self_serve',
      entity: 'document',
      entityId: null,
      metadata: { organization_id: orgId, slug: org?.slug },
    }).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'onboarding_activity_log_failed',
      )
    })

    return { organization: org, subscription: subscription ?? null, plan }
  },
}
