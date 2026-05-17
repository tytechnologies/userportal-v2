/**
 * Canonical document-type registry. Mirrors the rows seeded into
 * public.document_types by the Phase-1 migration.
 *
 * The DB row is authoritative for foreign-key integrity (drafts +
 * clauses constrain on `key`); this file is the developer-facing
 * source of truth for UI rendering, fetched once on app boot via
 * GET /api/document-types and cached in a composable.
 *
 * Field meanings:
 *   key        — stable slug, never change. PK in DB.
 *   category   — coarse bucket for filtering UIs.
 *   requires_* — deterministic validators key off these flags so the
 *                wizard / approval workflow can flag missing pieces
 *                before the document is locked.
 *
 * Adding a new type:
 *   1. Add the row here.
 *   2. Add a matching INSERT to the next migration.
 *   3. Re-run pnpm typecheck — nothing structural; the registry is
 *      data, not types.
 */

export type DocumentTypeCategory =
  | 'sale'
  | 'lease'
  | 'rental'
  | 'agency'
  | 'reservation'
  | 'commission'
  | 'management'
  | 'spa'
  | 'acknowledgement'
  | 'disclosure'
  | 'turnover'
  | 'movement'
  | 'hoa'
  | 'notice'
  | 'demand'
  | 'extension'

export type DocumentTypeDef = {
  key: string
  name: string
  category: DocumentTypeCategory
  jurisdiction: 'PH'
  requires_notary: boolean
  requires_witnesses: number
  requires_spouse_consent: boolean
  description: string
}

export const DOCUMENT_TYPES: ReadonlyArray<DocumentTypeDef> = [
  {
    key: 'deed_of_absolute_sale',
    name: 'Deed of Absolute Sale',
    category: 'sale',
    jurisdiction: 'PH',
    requires_notary: true,
    requires_witnesses: 2,
    requires_spouse_consent: true,
    description:
      'Transfers ownership; required for title transfer at the Registry of Deeds.',
  },
  {
    key: 'contract_to_sell',
    name: 'Contract to Sell',
    category: 'sale',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 2,
    requires_spouse_consent: false,
    description:
      'Conditional sale; ownership transfers only on full payment.',
  },
  {
    key: 'lease_agreement',
    name: 'Lease Agreement',
    category: 'lease',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 2,
    requires_spouse_consent: false,
    description: 'Long-term tenancy contract (≥1 year typical).',
  },
  {
    key: 'rental_agreement',
    name: 'Rental Agreement',
    category: 'rental',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 2,
    requires_spouse_consent: false,
    description: 'Short-term or month-to-month rental.',
  },
  {
    key: 'authority_to_sell',
    name: 'Authority to Sell',
    category: 'agency',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description:
      'Owner grants the broker the right to market the property.',
  },
  {
    key: 'exclusive_listing_agreement',
    name: 'Exclusive Listing Agreement',
    category: 'agency',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description: 'Broker has exclusive right to list and sell.',
  },
  {
    key: 'reservation_agreement',
    name: 'Reservation Agreement',
    category: 'reservation',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description:
      'Buyer reserves the unit with a deposit before formal contract.',
  },
  {
    key: 'broker_commission_agreement',
    name: 'Broker Commission Agreement',
    category: 'commission',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description:
      'Defines the commission structure and split between brokers.',
  },
  {
    key: 'property_management_agreement',
    name: 'Property Management Agreement',
    category: 'management',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description:
      'Owner authorizes a property manager to operate the property.',
  },
  {
    key: 'special_power_of_attorney',
    name: 'Special Power of Attorney',
    category: 'spa',
    jurisdiction: 'PH',
    requires_notary: true,
    requires_witnesses: 2,
    requires_spouse_consent: true,
    description:
      "Authorizes another person to act on principal's behalf for specific transactions.",
  },
  {
    key: 'acknowledgement_receipt',
    name: 'Acknowledgment Receipt',
    category: 'acknowledgement',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description: 'Confirms receipt of payment, items, or documents.',
  },
  {
    key: 'disclosure_statement',
    name: 'Disclosure Statement',
    category: 'disclosure',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description:
      'Discloses material facts about the property condition/status.',
  },
  {
    key: 'turnover_document',
    name: 'Turnover Document',
    category: 'turnover',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 1,
    requires_spouse_consent: false,
    description:
      'Records property turnover from developer/seller to buyer.',
  },
  {
    key: 'move_in_form',
    name: 'Move-in Form',
    category: 'movement',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description: 'Inspection + condition record at move-in.',
  },
  {
    key: 'move_out_form',
    name: 'Move-out Form',
    category: 'movement',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description: 'Inspection + condition record at move-out.',
  },
  {
    key: 'hoa_form',
    name: 'HOA Form',
    category: 'hoa',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description:
      'Generic homeowners-association form (membership, dues, rules).',
  },
  {
    key: 'tenant_notice',
    name: 'Tenant Notice',
    category: 'notice',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description:
      'Statutory notice to tenant (renewal, increase, termination).',
  },
  {
    key: 'demand_letter',
    name: 'Demand Letter',
    category: 'demand',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description: 'Formal demand for payment, vacate, or compliance.',
  },
  {
    key: 'extension_agreement',
    name: 'Extension Agreement',
    category: 'extension',
    jurisdiction: 'PH',
    requires_notary: false,
    requires_witnesses: 0,
    requires_spouse_consent: false,
    description: 'Extends the term of an existing lease or contract.',
  },
] as const

export type DocumentTypeKey = (typeof DOCUMENT_TYPES)[number]['key']

const BY_KEY: Record<string, DocumentTypeDef> = Object.fromEntries(
  DOCUMENT_TYPES.map((d) => [d.key, d as DocumentTypeDef]),
)

export function findDocumentType(key: string | null | undefined): DocumentTypeDef | null {
  if (!key) return null
  return BY_KEY[key] ?? null
}

export function documentTypesByCategory(): Record<DocumentTypeCategory, DocumentTypeDef[]> {
  const out = {} as Record<DocumentTypeCategory, DocumentTypeDef[]>
  for (const d of DOCUMENT_TYPES) {
    if (!out[d.category]) out[d.category] = []
    out[d.category].push(d as DocumentTypeDef)
  }
  return out
}
