// Shared pagination primitives for snake_case-shaped CRM list endpoints
// (tasks, notes, inquiries, ...).
//
// Every list endpoint in this surface returns the same envelope:
//   { data, total, page, page_size, total_pages }
//
// And accepts the same query fields:
//   ?page=N&page_size=M
//
// Spread `paginationQueryFields` into the route's Zod query schema, call
// `pageRange()` to derive the Supabase `.range()` bounds, and pass the
// fetched data + count through `paginatedResponse()` to build the
// envelope. The point is to delete ~10 lines of identical boilerplate
// per route, not to invent a new shape — listings.repo.ts uses a
// camelCase envelope and keeps it; this helper is for the snake_case
// CRM tier.
//
// MAX_PAGE_SIZE is enforced server-side to keep a hostile or buggy
// client from asking for the whole table in one round trip.

import { z } from 'zod'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

/**
 * Zod field bag — spread into a route's query schema:
 *
 *   const querySchema = z.object({
 *     ...paginationQueryFields,
 *     status: z.enum([...]).optional(),
 *   })
 */
export const paginationQueryFields = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
}

export const paginationQuerySchema = z.object(paginationQueryFields)
export type PaginationQuery = z.infer<typeof paginationQuerySchema>

/**
 * Zero-indexed inclusive range for Supabase `.range(from, to)`.
 *
 *   const { from, to } = pageRange(page, pageSize)
 *   query.range(from, to)
 */
export function pageRange(
  page: number,
  pageSize: number,
): { from: number; to: number } {
  const from = (page - 1) * pageSize
  return { from, to: from + pageSize - 1 }
}

/**
 * Standard list-endpoint envelope. snake_case keys — matches the existing
 * shape consumed by useTasks / useNotes / useInquiries on the frontend.
 *
 * `count` is whatever Supabase returns from `{ count: 'exact' }` — null
 * means the count was not requested or the query failed; treated as 0.
 */
export function paginatedResponse<T>(
  data: T[],
  count: number | null,
  page: number,
  pageSize: number,
): {
  data: T[]
  total: number
  page: number
  page_size: number
  total_pages: number
} {
  const total = count ?? 0
  return {
    data,
    total,
    page,
    page_size: pageSize,
    total_pages: total > 0 ? Math.ceil(total / pageSize) : 0,
  }
}
