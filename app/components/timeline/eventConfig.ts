// Single source of truth for how every audit event renders. Add a new
// row here when you introduce a new action; the timeline picks it up
// without further changes.
//
// Fallback: if an action is not in the table, the renderer derives a
// label from the dotted name (e.g. `task.completed` → "Task: completed")
// and uses the gray dot.

export type TimelineColor = 'green' | 'blue' | 'purple' | 'red' | 'orange' | 'gray' | 'amber' | 'sky'

export type EventConfig = {
  label: string
  color: TimelineColor
  icon?: string
  /**
   * Pull a human-readable subtitle from the metadata payload. Returns
   * null when nothing relevant is present so the UI can omit the line.
   */
  meta?: (metadata: Record<string, any>) => string | null
}

const fileMeta = (m: Record<string, any>) =>
  m?.file_name ? String(m.file_name) : null

const titleMeta = (m: Record<string, any>) => {
  if (m?.title) return String(m.title)
  if (m?.listing_id) return `Listing #${m.listing_id}`
  return null
}

const fullNameMeta = (m: Record<string, any>) =>
  m?.full_name ? String(m.full_name) : null

// Listing update diff summarizer. The DB trigger
// (migration 20260507000007_listings_audit_diff_trigger) writes
// metadata.changes = { col: { from, to } }. The full diff is rendered
// elsewhere (the history drawer); the timeline subtitle just lists
// which fields changed so the row reads at a glance.
const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  unit_number: 'unit',
  property_category: 'category',
  property_type: 'type',
  status: 'status',
  condition: 'condition',
  is_online: 'visibility',
  for_sale: 'for-sale flag',
  for_rent: 'for-rent flag',
  sale_price: 'sale price',
  rent_price: 'rent price',
  security_deposit: 'security deposit',
  rent_advance: 'rent advance',
  association_dues: 'association dues',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
  parking_spaces: 'parking',
  floor_area: 'floor area',
  lot_area: 'lot area',
  availability_date: 'available date',
  lease_term: 'lease term',
  description: 'description',
  remarks: 'remarks',
  contact_id: 'contact',
  property_id: 'building',
}
function fieldLabel(col: string): string {
  return FIELD_LABELS[col] || col.replace(/_/g, ' ')
}
const listingUpdateMeta = (m: Record<string, any>): string | null => {
  const changes = m?.changes
  if (!changes || typeof changes !== 'object') return null
  const fields = Object.keys(changes)
  if (fields.length === 0) return null
  if (fields.length <= 3) {
    return fields.map(fieldLabel).join(', ') + ' changed'
  }
  return `${fields.length} fields changed: ${fields.slice(0, 3).map(fieldLabel).join(', ')}, …`
}

export const EVENT_CONFIG: Record<string, EventConfig> = {
  // Contacts
  'contact.created':         { label: 'Created contact',   color: 'green',  icon: '👤', meta: fullNameMeta },
  'contact.updated':         { label: 'Updated contact',   color: 'blue',   icon: '✏️' },
  'contact.deleted':         { label: 'Deleted contact',   color: 'red',    icon: '🗑️' },

  // Listings
  'listing.created':         { label: 'Created listing',   color: 'green',  icon: '🏠', meta: titleMeta },
  'listing.updated':         { label: 'Updated listing',   color: 'blue',   icon: '✏️', meta: listingUpdateMeta },
  'listing.remarks_updated': { label: 'Updated remarks',   color: 'blue',   icon: '📝' },
  'listing.archived':        { label: 'Archived listing',  color: 'gray',   icon: '📦' },
  'listing.unarchived':      { label: 'Reactivated listing', color: 'green', icon: '✨' },
  'listing.cloned':          { label: 'Cloned listing',    color: 'purple', icon: '📑' },
  'listing.soft_deleted':    { label: 'Deleted listing',   color: 'red',    icon: '🗑️' },

  // Documents
  'document.uploaded':       { label: 'Uploaded document', color: 'purple', icon: '📄', meta: fileMeta },
  'document.deleted':        { label: 'Deleted document',  color: 'red',    icon: '🗑️', meta: fileMeta },

  // Reconciliation
  'listing.legacy_reconciled': {
    label: 'Reconciled creator',
    color: 'sky',
    icon: '🧹',
    meta: (m) =>
      m?.target_column && m?.legacy_value
        ? `${m.target_column}: "${m.legacy_value}"`
        : null,
  },

  // Collaboration network
  'listing.shared': {
    label: 'Shared listing',
    color: 'sky',
    icon: '🤝',
    meta: (m) =>
      m?.share_role
        ? `as ${m.share_role}`
        : null,
  },
  'listing.share_accepted': {
    label: 'Share accepted',
    color: 'green',
    icon: '✅',
  },
  'listing.share_revoked': {
    label: 'Share revoked',
    color: 'red',
    icon: '🚫',
  },
  'listing.share_expired': {
    label: 'Share expired',
    color: 'gray',
    icon: '⌛',
  },
  'listing.share_updated': {
    label: 'Share updated',
    color: 'blue',
    icon: '✏️',
  },
  'listing.duplicated': {
    label: 'Listing duplicated',
    color: 'purple',
    icon: '📑',
    meta: (m) => {
      if (m?.op === 'source' && m?.copy_listing_id) {
        return `Copy created as #${m.copy_listing_id}`
      }
      if (m?.op === 'copy' && m?.source_listing_id) {
        return `Source: listing #${m.source_listing_id}`
      }
      return null
    },
  },
  'inquiry.forwarded': {
    label: 'Inquiry forwarded',
    color: 'amber',
    icon: '↗️',
  },

  // Trust + Reputation (migration 20260507000018)
  'review.created': {
    label: 'Review posted',
    color: 'amber',
    icon: '⭐',
    meta: (m) =>
      m?.rating ? `${Number(m.rating).toFixed(1)} ★ on ${m.target_type}` : null,
  },
  'review.updated': {
    label: 'Review updated',
    color: 'blue',
    icon: '✏️',
  },
  'review.hidden': {
    label: 'Review hidden by moderator',
    color: 'red',
    icon: '🚫',
    meta: (m) => (m?.reason ? String(m.reason).slice(0, 80) : null),
  },
  'review.unhidden': {
    label: 'Review restored by moderator',
    color: 'green',
    icon: '↩️',
  },
  'review.reported': {
    label: 'Review reported',
    color: 'red',
    icon: '⚠️',
  },
  'verification.listing_submitted': {
    label: 'Listing verification submitted',
    color: 'blue',
    icon: '🛡️',
  },
  'verification.listing_approved': {
    label: 'Listing verified',
    color: 'green',
    icon: '✅',
  },
  'verification.listing_rejected': {
    label: 'Listing verification rejected',
    color: 'red',
    icon: '🚫',
  },
  'verification.building_submitted': {
    label: 'Building verification submitted',
    color: 'blue',
    icon: '🛡️',
  },
  'verification.building_approved': {
    label: 'Building verified',
    color: 'green',
    icon: '✅',
  },
  'verification.building_rejected': {
    label: 'Building verification rejected',
    color: 'red',
    icon: '🚫',
  },

  // Deals + viewings + commissions (mig 20260507000021)
  'deal.created': {
    label: 'Deal created',
    color: 'green',
    icon: '🤝',
    meta: (m) => (m?.stage_key ? `stage: ${m.stage_key}` : null),
  },
  'deal.stage_changed': {
    label: 'Deal stage changed',
    color: 'blue',
    icon: '➡️',
    meta: (m) => (m?.new_stage ? `→ ${m.new_stage}` : null),
  },
  'deal.participant_added': {
    label: 'Participant added',
    color: 'sky',
    icon: '👥',
    meta: (m) => (m?.role ? `as ${m.role}` : null),
  },
  'deal.participant_removed': {
    label: 'Participant removed',
    color: 'gray',
    icon: '➖',
  },
  'deal.closed_won': {
    label: 'Deal closed (won)',
    color: 'green',
    icon: '🏆',
  },
  'deal.closed_lost': {
    label: 'Deal closed (lost)',
    color: 'gray',
    icon: '🪦',
  },
  'deal.reopened': {
    label: 'Deal re-opened',
    color: 'amber',
    icon: '↩️',
  },
  'viewing.scheduled': {
    label: 'Viewing scheduled',
    color: 'sky',
    icon: '📅',
    meta: (m) => {
      if (!m?.scheduled_at) return null
      try {
        return new Date(m.scheduled_at).toLocaleString()
      } catch {
        return null
      }
    },
  },
  'viewing.completed': {
    label: 'Viewing completed',
    color: 'green',
    icon: '✅',
  },
  'viewing.cancelled': {
    label: 'Viewing cancelled',
    color: 'gray',
    icon: '❌',
  },
  'viewing.no_show': {
    label: 'Viewing — no show',
    color: 'red',
    icon: '🕳️',
  },
  'commission.created': {
    label: 'Commission recorded',
    color: 'amber',
    icon: '💰',
  },
  'commission.updated': {
    label: 'Commission updated',
    color: 'amber',
    icon: '✏️',
  },
  'commission.paid': {
    label: 'Commission paid',
    color: 'green',
    icon: '💵',
  },
}

// Reusable diff helpers for the listing-history drawer.
export function listingChangedFields(metadata: Record<string, any> | null | undefined): string[] {
  const c = metadata?.changes
  if (!c || typeof c !== 'object') return []
  return Object.keys(c)
}
export function listingFieldLabel(col: string): string {
  return fieldLabel(col)
}

// Tailwind class lookup. Kept here (not in the component) so other UIs
// can surface the same color-coded dots — sidebar, dashboard, etc.
export const COLOR_DOT: Record<TimelineColor, string> = {
  green:  'bg-success',
  blue:   'bg-primary',
  purple: 'bg-primary',
  red:    'bg-destructive',
  orange: 'bg-warning',
  amber:  'bg-warning',
  sky:    'bg-primary',
  gray:   'bg-muted',
}

export function configFor(action: string): EventConfig {
  if (EVENT_CONFIG[action]) return EVENT_CONFIG[action]
  // Derive a reasonable label from `entity.verb` when we have nothing.
  const [entity, verb] = action.split('.')
  const niceVerb = (verb ?? action).replace(/_/g, ' ')
  const niceEntity = entity ? entity.charAt(0).toUpperCase() + entity.slice(1) : 'Event'
  return { label: `${niceEntity}: ${niceVerb}`, color: 'gray' }
}
