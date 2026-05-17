// POST /api/onboarding/organization
// Body: { name, description?, slug? }
//
// Self-serve organization creation. Caller becomes the brokerage_owner
// of the new org and is auto-subscribed to the free plan via the B4
// trigger. Slug is auto-generated from name unless an override is
// supplied (must match ^[a-z0-9][a-z0-9-]{0,49}$).

import { z } from 'zod'
import { onboardingRepo } from '~~/server/repositories/onboarding.repo'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,49}$/)
    .nullable()
    .optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    return await onboardingRepo.createOrganization({ event, input: body })
  },
})
