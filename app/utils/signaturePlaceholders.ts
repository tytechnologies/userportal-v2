/**
 * Signature placeholder model.
 *
 * Lives on `document_drafts.data._signature_placeholders` as a JSONB
 * array. No migration needed — the data column is already JSONB and
 * existing drafts without the array just see no signature blocks.
 *
 * Why JSONB rather than a dedicated table: a draft's signature
 * placeholders are tightly coupled to its body content (party ordering,
 * page anchors, label customization). Splitting into a side table
 * would require coordinated reads/writes for every save. JSONB
 * keeps the placeholders in lockstep with the rest of the draft.
 *
 * Vendor e-signing (Phase 3) will add a separate `signed_evidence`
 * pointer per placeholder — a URL to the signature image, a
 * cryptographic signature blob, and the audit trail. v1 just tracks
 * the placement + a manual `signed_at` timestamp the broker stamps
 * after the document is signed offline.
 */

export type SignaturePlaceholder = {
  /** UUID-like client-generated id. Stable across edits so the
   *  vendor integration in Phase 3 can match its evidence rows. */
  id: string
  /** Display label shown next to the signature line. */
  label: string
  /** Which party role this signature belongs to. Mirrors the validator
   *  role enum so issues like "buyer signed but seller didn't" surface
   *  through the validation engine. */
  party_role: 'seller' | 'buyer' | 'lessor' | 'lessee' | 'principal' | 'agent'
                | 'broker' | 'witness' | 'notary' | 'spouse_consenter' | 'other'
  /** Optional anchor coordinates for an overlay-on-PDF render. Null
   *  for AI-body drafts which use inline {{sig:label}} placeholders. */
  page: number | null
  x:    number | null
  y:    number | null
  /** Manual signed-at timestamp. Set when the broker confirms the
   *  document was signed offline. Vendor integration will overwrite
   *  with the cryptographic timestamp. */
  signed_at: string | null
  /** Manual signed-by user id when the signature was applied
   *  through the platform (e.g. a broker accepting their own copy). */
  signed_by_user_id: string | null
}

const ROLE_LABEL: Record<SignaturePlaceholder['party_role'], string> = {
  seller:           'Seller',
  buyer:            'Buyer',
  lessor:           'Lessor',
  lessee:           'Lessee',
  principal:        'Principal',
  agent:            'Agent',
  broker:           'Broker',
  witness:          'Witness',
  notary:           'Notary',
  spouse_consenter: 'Spouse (consenter)',
  other:            'Other',
}

export function roleLabel(role: SignaturePlaceholder['party_role']): string {
  return ROLE_LABEL[role] ?? role
}

/** Read placeholders out of a draft's data blob. Returns [] for any
 *  shape that isn't a valid array (defensive — the JSONB schema isn't
 *  enforced server-side). */
export function readPlaceholders(data: unknown): SignaturePlaceholder[] {
  if (!data || typeof data !== 'object') return []
  const raw = (data as Record<string, unknown>)._signature_placeholders
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (p): p is SignaturePlaceholder =>
      !!p && typeof p === 'object' && typeof (p as any).id === 'string',
  )
}

/** Write placeholders back into a data blob, returning a new object so
 *  Vue reactivity doesn't miss the change. */
export function writePlaceholders(
  data: unknown,
  placeholders: SignaturePlaceholder[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...((data && typeof data === 'object') ? (data as Record<string, unknown>) : {}),
  }
  next._signature_placeholders = placeholders
  return next
}

/** Generate a fresh placeholder. Random ID is short enough to keep
 *  JSONB compact but unique enough that two simultaneous edits don't
 *  collide for a single draft. */
export function newPlaceholder(
  partial: Partial<SignaturePlaceholder> = {},
): SignaturePlaceholder {
  return {
    id: 'sig_' + Math.random().toString(36).slice(2, 10),
    label: partial.label || roleLabel(partial.party_role || 'other'),
    party_role: partial.party_role || 'other',
    page: partial.page ?? null,
    x: partial.x ?? null,
    y: partial.y ?? null,
    signed_at: partial.signed_at ?? null,
    signed_by_user_id: partial.signed_by_user_id ?? null,
  }
}

/** Build the inline placeholder marker the AI body editor recognizes.
 *  Format: `{{sig:label}}` — the editor scrolls to the first such
 *  marker when the user clicks a placeholder row. */
export function inlineMarker(p: SignaturePlaceholder): string {
  return `{{sig:${p.label}}}`
}
