/**
 * Per-document-type structural skeleton.
 *
 * The typography (Times New Roman / 12pt / 1.5 / justified) is the
 * SAME on every doc; the *structure* — what party roles to label, how
 * many witnesses, whether a spouse-consent block is needed, what the
 * introductory recital reads like — varies by canonical type.
 *
 * This module is the single source of truth for those structural
 * answers. Both the DOCX renderer and the PDF renderer read from it
 * so AI-generated drafts, templated drafts, and freeform exports all
 * close with the right roles + witness count + acknowledgment for
 * the document type the broker chose.
 *
 * Adding a new doc type:
 *   1. Add the row to documentTypes.ts (the canonical registry).
 *   2. Add a skeleton entry below if the defaults don't fit the type.
 *      Most types fall into one of the parties templates already
 *      enumerated; only outliers need a custom entry.
 */

import type { DocumentTypeKey } from './documentTypes'

/** A single party role on a document. The label is uppercase + bold
 *  in the rendered signature block. `name_label` is the data-row
 *  label that appears under the signature line (e.g. "Printed name"
 *  vs "Corporate name" vs "Affiant"). */
export type SkeletonParty = {
  label: string
  /** What appears under the signature line. Defaults to "Printed name". */
  name_label?: string
}

/** Structural metadata for a document type. */
export type DocumentSkeleton = {
  /** Title shown centered uppercase at the top of the document.
   *  Falls back to the doc type's `name` if undefined. */
  title?: string
  /** Canonical party roles in the order they appear on the signature
   *  page. `[LESSOR, LESSEE]` for a lease, `[VENDOR, VENDEE]` for a
   *  deed of sale, `[PRINCIPAL, AGENT]` for an SPA, etc. */
  parties: SkeletonParty[]
  /** Optional intro recital paragraph shown right after the title.
   *  Read like "This Agreement is made and entered into between
   *  ____ ('LESSOR') and ____ ('LESSEE')..." Already-formal AI
   *  output usually supplies its own recitals; this is the fallback
   *  for templated drafts where `data` is just key/value pairs. */
  recital?: string
  /** When true, the renderer appends a Spouse Consent block before
   *  the witnesses. Required for deeds of conjugal property + SPA
   *  (Family Code Art. 96 / Art. 124 — a spouse must consent to
   *  acts of administration / disposition over conjugal property). */
  has_spouse_consent_block?: boolean
}

const SKELETONS: Partial<Record<DocumentTypeKey, DocumentSkeleton>> = {
  // ---- Sale ---------------------------------------------------------
  deed_of_absolute_sale: {
    parties: [
      { label: 'VENDOR' },
      { label: 'VENDEE' },
    ],
    recital:
      "This DEED OF ABSOLUTE SALE is made and entered into by and between the parties named below, who hereby covenant and agree as follows:",
    has_spouse_consent_block: true,
  },
  contract_to_sell: {
    parties: [
      { label: 'SELLER' },
      { label: 'BUYER' },
    ],
    recital:
      "This CONTRACT TO SELL is entered into by and between the SELLER and BUYER named below. The parties hereby covenant and agree as follows:",
  },

  // ---- Lease / Rental ----------------------------------------------
  lease_agreement: {
    parties: [
      { label: 'LESSOR' },
      { label: 'LESSEE' },
    ],
    recital:
      "This LEASE AGREEMENT is made and entered into by and between the parties named below, who hereby agree to the terms and conditions set forth herein:",
  },
  rental_agreement: {
    parties: [
      { label: 'LANDLORD' },
      { label: 'TENANT' },
    ],
    recital:
      "This RENTAL AGREEMENT is entered into by the parties named below, who hereby agree to the terms and conditions set forth herein:",
  },

  // ---- Agency ------------------------------------------------------
  authority_to_sell: {
    parties: [
      { label: 'OWNER' },
      { label: 'BROKER' },
    ],
    recital:
      "This AUTHORITY TO SELL is granted by the OWNER named below to the BROKER named below, on the following terms and conditions:",
  },
  exclusive_listing_agreement: {
    parties: [
      { label: 'OWNER' },
      { label: 'BROKER' },
    ],
    recital:
      "This EXCLUSIVE LISTING AGREEMENT is entered into by the OWNER and the BROKER named below, granting the BROKER exclusive marketing rights on the following terms:",
  },

  // ---- Reservation / Commission / Management -----------------------
  reservation_agreement: {
    parties: [
      { label: 'SELLER' },
      { label: 'BUYER' },
    ],
    recital:
      "This RESERVATION AGREEMENT records the BUYER's reservation of the unit / property described below, on the following terms:",
  },
  broker_commission_agreement: {
    parties: [
      { label: 'LISTING BROKER' },
      { label: 'SELLING BROKER' },
    ],
    recital:
      "This BROKER COMMISSION AGREEMENT defines the commission structure between the LISTING BROKER and the SELLING BROKER named below:",
  },
  property_management_agreement: {
    parties: [
      { label: 'OWNER' },
      { label: 'PROPERTY MANAGER' },
    ],
    recital:
      "This PROPERTY MANAGEMENT AGREEMENT is entered into by the OWNER and the PROPERTY MANAGER named below, on the following terms and scope of authority:",
  },

  // ---- SPA ---------------------------------------------------------
  special_power_of_attorney: {
    title: 'SPECIAL POWER OF ATTORNEY',
    parties: [
      { label: 'PRINCIPAL', name_label: 'Affiant' },
      { label: 'ATTORNEY-IN-FACT' },
    ],
    recital:
      "KNOW ALL MEN BY THESE PRESENTS: That I, the PRINCIPAL named below, do hereby APPOINT, NAME, and CONSTITUTE the person named below as my true and lawful Attorney-in-Fact, granting unto him/her the powers and authority specified hereunder:",
    has_spouse_consent_block: true,
  },

  // ---- Receipts / Disclosures / Turnover ---------------------------
  acknowledgement_receipt: {
    title: 'ACKNOWLEDGMENT RECEIPT',
    parties: [
      { label: 'RECEIVED BY' },
    ],
    recital:
      "This ACKNOWLEDGMENT RECEIPT confirms receipt of the items / amounts described below:",
  },
  disclosure_statement: {
    parties: [
      { label: 'DECLARANT' },
    ],
    recital:
      "The undersigned DECLARANT, under oath, hereby discloses the following material facts concerning the property described below:",
  },
  turnover_document: {
    parties: [
      { label: 'TURNED OVER BY' },
      { label: 'RECEIVED BY' },
    ],
    recital:
      "This TURNOVER DOCUMENT records the formal turnover of the property described below from the party indicated as TURNED OVER BY to the party indicated as RECEIVED BY.",
  },

  // ---- Movement (move-in / move-out) -------------------------------
  move_in_form: {
    parties: [
      { label: 'TENANT' },
      { label: 'LANDLORD / AGENT' },
    ],
    recital:
      "This MOVE-IN FORM records the inspection and condition of the property as of the date of the TENANT's move-in:",
  },
  move_out_form: {
    parties: [
      { label: 'TENANT' },
      { label: 'LANDLORD / AGENT' },
    ],
    recital:
      "This MOVE-OUT FORM records the inspection and condition of the property as of the date of the TENANT's move-out:",
  },

  // ---- HOA / Notice / Demand / Extension ---------------------------
  hoa_form: {
    parties: [
      { label: 'HOMEOWNER' },
      { label: 'HOA REPRESENTATIVE' },
    ],
  },
  tenant_notice: {
    title: 'NOTICE TO TENANT',
    parties: [
      { label: 'LANDLORD' },
    ],
    recital:
      "TO: The TENANT named below. PLEASE TAKE NOTICE of the matters set forth herein.",
  },
  demand_letter: {
    title: 'DEMAND LETTER',
    parties: [
      { label: 'CLAIMANT' },
    ],
    recital:
      "Through counsel / through the undersigned, formal DEMAND is hereby made upon the addressee for the matters set forth herein.",
  },
  extension_agreement: {
    parties: [
      { label: 'PARTY A' },
      { label: 'PARTY B' },
    ],
    recital:
      "This EXTENSION AGREEMENT extends the term of the underlying contract referenced below, on the same terms and conditions, with the modifications stated herein:",
  },
}

const DEFAULT_SKELETON: DocumentSkeleton = {
  parties: [
    { label: 'PARTY A' },
    { label: 'PARTY B' },
  ],
}

/** Look up the structural skeleton for a doc type. Falls back to a
 *  generic two-party template when the key isn't recognized — this is
 *  the right call so an unknown type still exports as a structured
 *  contract, just with generic labels. */
export function findDocumentSkeleton(
  key: string | null | undefined,
): DocumentSkeleton {
  if (!key) return DEFAULT_SKELETON
  return SKELETONS[key as DocumentTypeKey] ?? DEFAULT_SKELETON
}
