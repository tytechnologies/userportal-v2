// Pagination helper smoke tests.
//
// pageRange and paginatedResponse are pure functions; verify the math
// + envelope shape so the snake_case contract used by tasks/notes/
// inquiries endpoints can't drift silently.

import { describe, it, expect } from 'vitest'
import {
  pageRange,
  paginatedResponse,
  paginationQuerySchema,
} from '~~/server/utils/pagination'

describe('pageRange', () => {
  it('first page → 0..(size-1)', () => {
    expect(pageRange(1, 50)).toEqual({ from: 0, to: 49 })
  })
  it('second page', () => {
    expect(pageRange(2, 50)).toEqual({ from: 50, to: 99 })
  })
  it('arbitrary page size', () => {
    expect(pageRange(3, 17)).toEqual({ from: 34, to: 50 })
  })
})

describe('paginatedResponse', () => {
  it('wraps shape correctly with positive count', () => {
    const r = paginatedResponse([{ id: 1 }, { id: 2 }], 100, 1, 50)
    expect(r).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      total: 100,
      page: 1,
      page_size: 50,
      total_pages: 2,
    })
  })

  it('handles null count as 0 with zero pages', () => {
    const r = paginatedResponse([], null, 1, 50)
    expect(r).toEqual({
      data: [],
      total: 0,
      page: 1,
      page_size: 50,
      total_pages: 0,
    })
  })

  it('rounds up partial last pages', () => {
    const r = paginatedResponse([], 101, 3, 50)
    expect(r.total_pages).toBe(3)
  })
})

describe('paginationQuerySchema', () => {
  it('coerces string page → number, defaults applied', () => {
    const parsed = paginationQuerySchema.parse({ page: '2', page_size: '25' })
    expect(parsed).toEqual({ page: 2, page_size: 25 })
  })
  it('rejects out-of-range page_size', () => {
    expect(() => paginationQuerySchema.parse({ page_size: 9999 })).toThrow()
  })
  it('rejects page < 1', () => {
    expect(() => paginationQuerySchema.parse({ page: 0 })).toThrow()
  })
  it('uses defaults when fields omitted', () => {
    const parsed = paginationQuerySchema.parse({})
    expect(parsed.page).toBe(1)
    expect(parsed.page_size).toBe(50)
  })
})
