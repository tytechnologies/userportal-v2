// Single source of truth for projecting a listing_shares row into a
// fine-grained capability set.
//
// Why this lives in one file:
//   - Three call sites need to evaluate capabilities: the share-create
//     endpoint (validates the requested capability map), the
//     duplicate-listing endpoint (checks duplicate_allowed), and the
//     server-side inquiry-forwarding logic (checks respond_to_inquiries).
//   - Drift between any two of those would be a security hole.
//   - Legacy rows (permissions = '{}') need a deterministic role →
//     capability projection.
//
// New code should ALWAYS use evaluateSharePermissions(); never read
// share_role + permissions directly.

export type ShareCapability =
  | 'view_listing'
  | 'view_inquiries'
  | 'respond_to_inquiries'
  | 'co_market'
  | 'duplicate_allowed'
  | 'edit_listing'

export const ALL_CAPABILITIES: readonly ShareCapability[] = [
  'view_listing',
  'view_inquiries',
  'respond_to_inquiries',
  'co_market',
  'duplicate_allowed',
  'edit_listing',
] as const

const CAP_SET = new Set<ShareCapability>(ALL_CAPABILITIES)

/**
 * Drop unknown keys + non-true values from a caller-supplied map.
 * Callers can pass `{ duplicate_allowed: true, foo: 'bar' }` and
 * we'll persist `{ duplicate_allowed: true }`. Defense against typo'd
 * keys silently granting unknown capabilities later.
 */
export function sanitizeCapabilities(
  raw: Record<string, unknown> | null | undefined,
): Record<ShareCapability, true> {
  const out: Partial<Record<ShareCapability, true>> = {}
  if (!raw || typeof raw !== 'object') return out as Record<ShareCapability, true>
  for (const [key, value] of Object.entries(raw)) {
    if (CAP_SET.has(key as ShareCapability) && value === true) {
      out[key as ShareCapability] = true
    }
  }
  return out as Record<ShareCapability, true>
}

/**
 * Project the legacy share_role onto an explicit capability set. Used
 * when permissions = {} (the column default for any row that hasn't
 * been touched since migration 20260507000015).
 */
function legacyRoleCapabilities(
  shareRole: 'co_broker' | 'viewer' | string | null | undefined,
): Record<ShareCapability, true> {
  if (shareRole === 'co_broker') {
    // co_broker historically conferred edit + inquiry response.
    return {
      view_listing: true,
      view_inquiries: true,
      respond_to_inquiries: true,
      co_market: true,
      duplicate_allowed: true,
      edit_listing: true,
    }
  }
  // viewer (or unknown) → read-only.
  return {
    view_listing: true,
    view_inquiries: true,
    respond_to_inquiries: false as never,
    co_market: false as never,
    duplicate_allowed: false as never,
    edit_listing: false as never,
  } as unknown as Record<ShareCapability, true>
}

export type ShareRow = {
  share_role: 'co_broker' | 'viewer' | string
  permissions: Record<string, unknown> | null
  status: 'pending' | 'accepted' | 'revoked' | string
  expires_at: string | null
}

/**
 * Evaluate an effective capability set for a share row. Treats
 * non-accepted or expired shares as zero-capability (callers should
 * still hit RLS, but this is defense-in-depth).
 *
 * Resolution order:
 *   1. status != 'accepted' OR expired → empty set
 *   2. Non-empty permissions JSONB → use it (sanitized)
 *   3. Empty permissions → project share_role
 */
export function evaluateSharePermissions(
  row: ShareRow,
): Record<ShareCapability, true> {
  if (row.status !== 'accepted') return {} as Record<ShareCapability, true>
  if (row.expires_at) {
    const exp = new Date(row.expires_at).getTime()
    if (Number.isFinite(exp) && exp <= Date.now()) {
      return {} as Record<ShareCapability, true>
    }
  }
  const explicit = row.permissions && Object.keys(row.permissions).length > 0
    ? sanitizeCapabilities(row.permissions)
    : null
  if (explicit && Object.keys(explicit).length > 0) return explicit
  return legacyRoleCapabilities(row.share_role)
}

/**
 * Convenience predicate. Equivalent to
 *   evaluateSharePermissions(row)[cap] === true
 */
export function shareHasCapability(
  row: ShareRow,
  cap: ShareCapability,
): boolean {
  return evaluateSharePermissions(row)[cap] === true
}
