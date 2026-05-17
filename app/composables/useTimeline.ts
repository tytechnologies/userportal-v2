// Unified CRM activity timeline.
//
// Cross-entity addressing rule: an activity belongs to a contact's
// timeline if EITHER:
//   - it's the contact's own row (entity = 'contact' AND metadata.contact_id = id), OR
//   - it's any other entity that linked back via metadata.contact_id.
//
// We use metadata.contact_id rather than entity_id because contacts use
// bigint PKs and `activities.entity_id` is uuid (Phase 4 design choice).
// Stamping bigint IDs in metadata is the established pattern.
//
// Security: every read goes through useSupabaseClient(); RLS on
// activities (Phase 4 + has_permission migration) decides what the
// caller can actually see. An agent never sees another user's actions.

export type TimelineEvent = {
  id: string
  action: string                              // dotted entity.verb
  created_at: string
  entity: string                              // 'contact' | 'listing' | 'document' | …
  entity_id: string | null
  metadata: Record<string, any>
  actor: { id?: string; full_name?: string | null; email?: string | null } | null
}

const SELECT_COLUMNS =
  'id, action, created_at, entity, entity_id, metadata, ' +
  'actor:profiles!user_id (id, full_name, email)'

function asArray(data: unknown): TimelineEvent[] {
  return Array.isArray(data) ? (data as TimelineEvent[]) : []
}

export function useTimeline() {
  /**
   * Unified contact-scoped timeline. Returns activities where any of:
   *   - the row's entity = 'contact' AND its own contact_id metadata matches
   *   - metadata.contact_id matches (covers listing, document, future entities)
   *
   * PostgREST OR uses comma-separated terms; nested groups use and(...).
   * `metadata->>contact_id` casts the JSONB key to text — comparing to the
   * stringified contactId works for bigint contact ids.
   */
  async function fetchContactTimeline(contactId: number, limit = 100): Promise<TimelineEvent[]> {
    if (!Number.isFinite(contactId)) return []
    const supabase = useSupabaseClient()
    const idStr = String(contactId)
    // Single-line OR — PostgREST does not accept embedded newlines.
    const orFilter = `metadata->>contact_id.eq.${idStr},and(entity.eq.contact,metadata->>contact_id.eq.${idStr})`

    const { data, error } = await (supabase as any)
      .from('activities')
      .select(SELECT_COLUMNS)
      .or(orFilter)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[useTimeline] fetchContactTimeline failed:', error.message ?? error)
      return []
    }
    // Defensive de-dupe — the OR can match the same row twice if both
    // conditions apply (e.g. contact.created where the contact's own
    // metadata.contact_id matches the contact entity branch).
    const seen = new Set<string>()
    return asArray(data).filter((row) => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
  }

  /**
   * Listing-scoped timeline — same shape as the contact one, but pivoting
   * on metadata.listing_id. Useful for the listing sidebar.
   */
  async function fetchListingTimeline(listingId: number, limit = 50): Promise<TimelineEvent[]> {
    if (!Number.isFinite(listingId)) return []
    const supabase = useSupabaseClient()
    const idStr = String(listingId)
    const orFilter = `metadata->>listing_id.eq.${idStr},and(entity.eq.listing,metadata->>listing_id.eq.${idStr})`

    const { data, error } = await (supabase as any)
      .from('activities')
      .select(SELECT_COLUMNS)
      .or(orFilter)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[useTimeline] fetchListingTimeline failed:', error.message ?? error)
      return []
    }
    const seen = new Set<string>()
    return asArray(data).filter((row) => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
  }

  /**
   * Deal-scoped timeline. Deal IDs are uuids (unlike contacts/listings
   * which are bigints), so the entity-matching branch can use a direct
   * `entity_id.eq` rather than going through metadata. The metadata
   * branch covers cross-entity events (viewing.scheduled, document
   * events, stage_changed, etc.) that stamp deal_id in their metadata
   * blob.
   */
  async function fetchDealTimeline(dealId: string, limit = 100): Promise<TimelineEvent[]> {
    if (!dealId || !/^[0-9a-f-]{36}$/i.test(dealId)) return []
    const supabase = useSupabaseClient()
    const orFilter = `metadata->>deal_id.eq.${dealId},and(entity.eq.deal,entity_id.eq.${dealId})`

    const { data, error } = await (supabase as any)
      .from('activities')
      .select(SELECT_COLUMNS)
      .or(orFilter)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[useTimeline] fetchDealTimeline failed:', error.message ?? error)
      return []
    }
    const seen = new Set<string>()
    return asArray(data).filter((row) => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
  }

  return { fetchContactTimeline, fetchListingTimeline, fetchDealTimeline }
}
