import { refreshListingDetails } from '~~/server/utils/refresh-listing-details'

// Manual refresh endpoint. Idempotent — safe to call repeatedly. Used by:
//   - app/services/listing.services.js (after _createListingOnly /
//     _updateListing succeed)
//   - any future maintenance / debugging flow
//
// Uses force=true so the caller awaits the actual refresh and returns
// to the client only after the MV is up to date. The debounced path
// (mig 20260513000004) is for write-side hot paths that don't need
// to see their write reflected on the public MV before responding;
// this endpoint exists precisely for the opposite case.
//
// Returns 200 with { success: true } even when the underlying RPC fails —
// the helper logs the failure but never throws. This is intentional: a
// stale view is a degraded read, not a broken write.
export default defineApiHandler({
  auth: 'required',
  handler: async ({ event }) => {
    await refreshListingDetails(event, 'api.admin.refresh-listing-details', { force: true })
    return { success: true }
  },
})
