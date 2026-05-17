// Real-estate calculator dispatcher.
//
// POST /api/admin/calculators
// Body: { kind: 'dst'|'cgt'|'transfer_tax'|'mortgage'|'amortization'
//                |'roi'|'commission_tax'|'all_in', inputs: {...} }
//
// Pure-function dispatch — no DB writes, no audit, no side effects.
// Server-side hosting keeps the rate authority on the server (future
// audit + per-tenant rate overrides drop in cleanly here), but the
// math itself is deterministic + testable independent of the endpoint.

import { z } from 'zod'
import { requireRole } from '~~/server/utils/rbac'
import {
  dst,
  cgt,
  transferTax,
  mortgage,
  amortization,
  roi,
  commissionTax,
  allInTransactionEstimate,
} from '~~/server/utils/realEstateCalculators'

const bodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dst'),
    inputs: z.object({
      selling_price: z.number().nonnegative(),
      zonal_or_fair_value: z.number().nonnegative().optional(),
      rate: z.number().min(0).max(1).optional(),
    }),
  }),
  z.object({
    kind: z.literal('cgt'),
    inputs: z.object({
      selling_price: z.number().nonnegative(),
      zonal_or_fair_value: z.number().nonnegative().optional(),
      rate: z.number().min(0).max(1).optional(),
    }),
  }),
  z.object({
    kind: z.literal('transfer_tax'),
    inputs: z.object({
      selling_price: z.number().nonnegative(),
      rate: z.number().min(0).max(1).optional(),
    }),
  }),
  z.object({
    kind: z.literal('mortgage'),
    inputs: z.object({
      principal: z.number().positive(),
      annual_rate: z.number().min(0).max(1),
      term_years: z.number().positive(),
    }),
  }),
  z.object({
    kind: z.literal('amortization'),
    inputs: z.object({
      principal: z.number().positive(),
      annual_rate: z.number().min(0).max(1),
      term_years: z.number().positive(),
      max_rows: z.number().int().positive().max(600).optional(),
    }),
  }),
  z.object({
    kind: z.literal('roi'),
    inputs: z.object({
      annual_rental_income: z.number().nonnegative(),
      annual_operating_expenses: z.number().nonnegative(),
      property_value: z.number().positive(),
    }),
  }),
  z.object({
    kind: z.literal('commission_tax'),
    inputs: z.object({
      commission_amount: z.number().nonnegative(),
      vat_registered: z.boolean().optional(),
      withholding_applies: z.boolean().optional(),
    }),
  }),
  z.object({
    kind: z.literal('all_in'),
    inputs: z.object({
      selling_price: z.number().nonnegative(),
      zonal_or_fair_value: z.number().nonnegative().optional(),
      commission_rate: z.number().min(0).max(1).optional(),
      transfer_rate: z.number().min(0).max(1).optional(),
      dst_rate: z.number().min(0).max(1).optional(),
      cgt_rate: z.number().min(0).max(1).optional(),
    }),
  }),
])

export default defineApiHandler({
  body: bodySchema,
  auth: 'required',
  handler: async ({ event, body }) => {
    // Any authenticated operator can use the calculators (broker /
    // manager / admin). Lower bar than 'manager' since these are
    // advisory tools any agent might pull up in a client meeting.
    await requireRole(event, 'agent')

    try {
      switch (body.kind) {
        case 'dst':
          return { kind: body.kind, result: dst(body.inputs) }
        case 'cgt':
          return { kind: body.kind, result: cgt(body.inputs) }
        case 'transfer_tax':
          return { kind: body.kind, result: transferTax(body.inputs) }
        case 'mortgage':
          return { kind: body.kind, result: mortgage(body.inputs) }
        case 'amortization':
          return { kind: body.kind, result: amortization(body.inputs) }
        case 'roi':
          return { kind: body.kind, result: roi(body.inputs) }
        case 'commission_tax':
          return { kind: body.kind, result: commissionTax(body.inputs) }
        case 'all_in':
          return { kind: body.kind, result: allInTransactionEstimate(body.inputs) }
      }
    } catch (err: any) {
      throw createError({
        statusCode: 422,
        statusMessage: err?.message ?? 'Calculation failed',
      })
    }
  },
})
