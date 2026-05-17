// Legacy-route stub for /api/documents/selections.
//
// Same story as /api/documents (this directory's index.get.ts): the
// legacy listing-history / viewing-list pages call this on mount via
// `apiRoutes['documents.selections']` to populate dropdown filter
// options. The endpoint was never ported when the document-drafts
// redesign shipped, so the call has been 404'ing since launch.
//
// Returns a minimal shape: empty option lists. The legacy pages use
// .forEach over the keys, so we return a plain object with the
// expected keys mapped to empty arrays so the iteration is a no-op
// rather than a TypeError.

export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    setHeader(event, 'Cache-Control', 'no-store')
    return {
      // Keys mirror the legacy contract — search-column options,
      // division options, document_type options. Empty arrays so
      // the legacy page renders empty selects without crashing.
      searchColumns: [],
      divisions:     [],
      documentTypes: [],
      deprecated: {
        reason: 'legacy_documents_endpoint',
        message:
          'The legacy /api/documents/selections endpoint was deprecated when the document-drafts redesign shipped. ' +
          'This stub returns empty option lists so the legacy pages render without crashing.',
        replaced_by: ['/api/admin/document-drafts (the canonical document surface)'],
      },
    }
  },
})
