// Submit a verification request for the calling agent's profile.
//
// Self-only: profile_id auto-stamps from auth.uid(); RLS enforces it.
// Status defaults to 'pending' (CHECK constraint on the table); the
// agent cannot land an 'approved' row.
//
// Side effects:
//   - audit `verification.submitted`
//   - notify all admins via the 'verification.submitted' kind
//
// Multiple pending submissions per profile are allowed (resubmit
// flow). Admins decide what to do with stale pendings.

import { z } from 'zod'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'
import { logger } from '~~/server/utils/logger'
import { logActivity } from '~~/server/utils/audit'
import { notify } from '~~/server/utils/notifications'
import { getServerSupabaseAdmin } from '~~/server/utils/supabase'

const bodySchema = z.object({
  license_number:    z.string().trim().max(80).nullable().optional(),
  license_authority: z.string().trim().max(80).nullable().optional(),
  brokerage_name:    z.string().trim().max(160).nullable().optional(),
  evidence_url:      z.string().trim().url().max(2048).nullable().optional(),
  applicant_notes:   z.string().trim().max(4000).nullable().optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body, user }) => {
    const supabase = await serverSupabaseClient(event)

    // profile_id stamped from the JWT, never from the body. RLS
    // double-checks via WITH CHECK.
    const insert = {
      profile_id:        user!.id,
      license_number:    body.license_number ?? null,
      license_authority: body.license_authority ?? null,
      brokerage_name:    body.brokerage_name ?? null,
      evidence_url:      body.evidence_url ?? null,
      applicant_notes:   body.applicant_notes ?? null,
    }

    const { data, error } = await (supabase as any)
      .from('profile_verifications')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      logger.error(
        { err: error.message, op: 'verifications.create' },
        'verification_create_failed',
      )
      throw createError({ statusCode: 500, statusMessage: error.message })
    }

    await logActivity({
      event,
      client: supabase,
      action: 'verification.submitted',
      entity: 'verification',
      entityId: data.id,
      metadata: {
        profile_id: data.profile_id,
        has_license_number: !!data.license_number,
        has_evidence_url: !!data.evidence_url,
      },
    })

    // Fanout notification to every admin. Service-role lookup so RLS
    // doesn't hide other users' rows from the request-bound client.
    // notify() short-circuits if recipient === actor (self-submitted by
    // an admin → no echo).
    try {
      const admin = getServerSupabaseAdmin()
      const { data: admins } = await (admin as any)
        .from('profiles')
        .select('id')
        .eq('role', 'admin')

      const profilesData = (admins ?? []) as Array<{ id: string }>
      for (const a of profilesData) {
        await notify({
          recipientUserId: a.id,
          actorUserId: user!.id,
          kind: 'verification.submitted',
          title: 'New verification request',
          body: data.brokerage_name
            ? `Submitted by ${data.brokerage_name}`
            : null,
          href: `/admin?tab=verifications`,
          metadata: { verification_id: data.id, profile_id: data.profile_id },
        })
      }
    } catch (err: any) {
      logger.warn(
        { err: err?.message, op: 'verifications.create.notify' },
        'verification_notify_failed',
      )
    }

    setResponseStatus(event, 201)
    return data
  },
})
