// Legacy-route stub for /api/documents.
//
// The OLD listing-history / viewing-list flow (pages/contracts-residential-
// viewing-list.vue, pages/contracts-commercial-viewing-list.vue,
// pages/listing-history.vue) calls this endpoint via
// `apiRoutes['documents.report']` with a legacy query shape:
//   ?searchColumn=client&division=residential&document_type=Viewing%20Lists
//
// The canonical replacement is /api/documents/list (token-style filters)
// and /api/documents/viewing-lists. The legacy endpoint was never ported
// to either repo (verified in original + main); the calling pages have
// been 404'ing since launch, with the front-end then crashing on
// undefined.forEach.
//
// Rather than reintroduce the legacy contract (which would shadow the
// canonical endpoints), this stub:
//   - Validates the legacy query shape so a caller gets a coherent
//     response.
//   - Returns the shape the legacy pages expect (an array-like wrapper
//     with `.data` and `.total` so `.data.forEach(...)` doesn't throw).
//   - Returns ZERO rows + a `deprecated` flag so the operator sees
//     the page render empty instead of crashing. The legacy pages are
//     scheduled for removal once admin/document-drafts replaces them.

import { z } from 'zod'

const querySchema = z.object({
  searchColumn:  z.string().trim().max(64).optional(),
  search:        z.string().trim().max(200).optional(),
  page:          z.coerce.number().int().min(1).optional(),
  division:      z.enum(['residential', 'commercial']).optional(),
  document_type: z.string().trim().max(64).optional(),
})

export default defineApiHandler({
  auth: 'required',
  query: querySchema,
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    // Shape mirrors the Laravel-paginated response the legacy pages
    // expected: { data: [], total, current_page, last_page, per_page,
    // from, to }. Empty so the page renders the "no rows" state.
    return {
      data: [],
      total: 0,
      current_page: 1,
      last_page: 1,
      per_page: 25,
      from: 0,
      to: 0,
      deprecated: {
        reason: 'legacy_documents_endpoint',
        message:
          'The legacy /api/documents listing was deprecated when the document-drafts redesign shipped. ' +
          'New consumers should call /api/documents/list (token filter) or /api/documents/viewing-lists. ' +
          'This stub returns an empty result so the legacy pages render without crashing.',
        replaced_by: ['/api/documents/list', '/api/documents/viewing-lists'],
      },
    }
  },
})
