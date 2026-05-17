/**
 * Deterministic document validation engine.
 *
 * NOT an AI surface. Every rule here is a pure function returning a
 * structured Issue. The AI assistant (when shipped) consumes these
 * rules' output to *explain* problems in plain English / Tagalog —
 * it never overrides or invents legal validations.
 *
 * Why deterministic: legal correctness needs reproducibility.
 * "Did we collect spouse consent?" is yes/no, not negotiable. Brokers
 * are accountable for what the form says; the AI is accountable for
 * how clearly it's explained.
 *
 * Coverage (per the doc-system spec):
 *   1.  TIN formatting        (PH 9 or 12-digit hyphenated)
 *   2.  PH addresses          (street, barangay, city; non-empty)
 *   3.  title numbers         (TCT/CCT/OCT prefix + numeric)
 *   4.  lot numbers           (positive integer; optional sub-lot suffix)
 *   5.  dates                 (ISO; not in the past for prospective contracts)
 *   6.  witness requirements  (count >= doc_type.requires_witnesses)
 *   7.  spouse consent        (consent block when doc_type.requires_spouse_consent)
 *   8.  signatures            (each named party has a signature placeholder)
 *   9.  notarial placeholders (notary block present when requires_notary)
 *   10. duplicate entities    (same TIN or same name twice on a document)
 *   11. required attachments  (per-doc_type list)
 *   12. invalid percentages   (commission splits sum to ≤100, non-negative)
 *   13. missing initials      (each party has an initials field)
 *   14. incomplete parties    (full_name + address + role at minimum)
 */

import { findDocumentType, type DocumentTypeKey } from './documentTypes'

// ============================================================
// Issue model
// ============================================================

export type IssueLevel = 'error' | 'warning' | 'info'
export type IssueCode =
  | 'invalid_tin'
  | 'invalid_address'
  | 'invalid_title_number'
  | 'invalid_lot_number'
  | 'invalid_date'
  | 'date_in_past'
  | 'insufficient_witnesses'
  | 'missing_spouse_consent'
  | 'missing_signature'
  | 'missing_notarial_block'
  | 'duplicate_entity'
  | 'missing_attachment'
  | 'invalid_percentage'
  | 'percentages_exceed_total'
  | 'missing_initials'
  | 'incomplete_party'

export type Issue = {
  level:   IssueLevel
  code:    IssueCode
  /** Dot-path into the document data this issue points at, e.g.
   *  'parties[1].tin' or 'commission.splits[0].pct'. UI uses this
   *  to scroll-to-and-highlight. */
  path:    string
  message: string
}

// ============================================================
// Party / Entity types — what the validator expects
// ============================================================

export type PartyRole =
  | 'seller' | 'buyer' | 'lessor' | 'lessee' | 'principal' | 'agent'
  | 'broker' | 'witness' | 'notary' | 'spouse_consenter' | 'other'

export type Party = {
  full_name?: string | null
  role?: PartyRole | null
  /** PH TIN in 9- or 12-digit hyphenated form: 123-456-789 or 123-456-789-000 */
  tin?: string | null
  /** Single-line. Nuanced PH structure can be modeled later — v1 just
   *  asserts non-empty street + barangay + city. */
  address?: string | null
  /** Object form when present. Either address or address_parts is OK. */
  address_parts?: { street?: string; barangay?: string; city?: string; province?: string } | null
  has_signature?: boolean
  has_initials?: boolean
  /** For seller/buyer: relevant when requires_spouse_consent. */
  is_married?: boolean | null
  spouse_consented?: boolean | null
}

export type DocumentForValidation = {
  doc_type_key: DocumentTypeKey | string | null | undefined
  parties?: Party[]
  /** PH title numbers — 'TCT-12345', 'CCT-987654', 'OCT-5'. Leniently accepts 'T-' / 'C-' too. */
  title_number?: string | null
  lot_number?: string | null
  /** ISO date for primary execution / start. Prospective contracts
   *  expect this to be today or later; validator only flags past
   *  dates as warnings (back-dating happens with reservation receipts). */
  effective_date?: string | null
  /** Commission-document-specific. Splits per role/recipient as
   *  percentages of the total commission. Validator checks they
   *  are non-negative and sum to ≤100. */
  commission_splits?: Array<{ recipient?: string; pct?: number | string | null }>
  /** Required attachments — passed-in declared by the wizard / form.
   *  Validator just checks "all required keys present" against the
   *  doc-type's expected list. */
  attachments?: Record<string, unknown>
  /** True if the document body includes a notary public block — set
   *  by the editor when a recognized "ACKNOWLEDGMENT" / "JURAT"
   *  template insert is present. */
  has_notarial_block?: boolean
}

// ============================================================
// Per-rule helpers
// ============================================================

/** PH TIN: 9 digits (legacy individuals) or 12 digits (with branch
 *  code). Common form is hyphenated; we accept both with and without
 *  hyphens. Reject anything else. */
const TIN_RE = /^(\d{3}-\d{3}-\d{3}(-\d{3,5})?|\d{9}|\d{12,14})$/

export function validateTin(value: string | null | undefined): boolean {
  if (!value) return false
  return TIN_RE.test(value.trim())
}

/** PH title number: TCT/CCT/OCT prefix (or T-/C-/O-) followed by digits,
 *  optionally with hyphens. Examples: TCT-12345, CCT-987654-0001, T-50. */
const TITLE_RE = /^(TCT|CCT|OCT|T|C|O)[-\s]?\d{1,8}([-\s]?\d{1,6})?$/i

export function validateTitleNumber(value: string | null | undefined): boolean {
  if (!value) return false
  return TITLE_RE.test(value.trim())
}

/** Lot number: positive integer, optionally followed by a sub-lot
 *  suffix like '-A' or '/2'. Reject 0 / negative / leading zeros. */
const LOT_RE = /^[1-9]\d{0,5}([-/][A-Z0-9]{1,4})?$/i

export function validateLotNumber(value: string | null | undefined): boolean {
  if (!value) return false
  return LOT_RE.test(value.trim())
}

export function validateAddress(p: Party): boolean {
  if (p.address && p.address.trim().split(/[, ]+/).length >= 2) return true
  const a = p.address_parts
  if (!a) return false
  return Boolean(a.street?.trim() && a.barangay?.trim() && a.city?.trim())
}

// ============================================================
// Main validator
// ============================================================

export function validateDocument(doc: DocumentForValidation): Issue[] {
  const issues: Issue[] = []
  const def = findDocumentType(doc.doc_type_key as string)
  const parties = doc.parties ?? []

  // 14. Incomplete parties — full_name + role at minimum.
  parties.forEach((p, i) => {
    if (!p.full_name?.trim()) {
      issues.push({
        level: 'error',
        code: 'incomplete_party',
        path: `parties[${i}].full_name`,
        message: `Party ${i + 1} is missing a full name.`,
      })
    }
    if (!p.role) {
      issues.push({
        level: 'error',
        code: 'incomplete_party',
        path: `parties[${i}].role`,
        message: `Party ${i + 1} (${p.full_name || 'unnamed'}) is missing a role.`,
      })
    }
  })

  // 1. TIN formatting (when supplied; not all parties carry a TIN).
  parties.forEach((p, i) => {
    if (p.tin && !validateTin(p.tin)) {
      issues.push({
        level: 'error',
        code: 'invalid_tin',
        path: `parties[${i}].tin`,
        message: `TIN for ${p.full_name || `party ${i + 1}`} doesn't look like a Philippine TIN (e.g. 123-456-789 or 123-456-789-000).`,
      })
    }
  })

  // 2. Address present + minimally structured.
  parties.forEach((p, i) => {
    // Witnesses + notaries don't always need a recorded address;
    // skip address check for those roles.
    if (p.role === 'witness' || p.role === 'notary') return
    if (p.address || p.address_parts) {
      if (!validateAddress(p)) {
        issues.push({
          level: 'warning',
          code: 'invalid_address',
          path: `parties[${i}].address`,
          message: `Address for ${p.full_name || `party ${i + 1}`} looks incomplete (need at least street, barangay, city).`,
        })
      }
    }
  })

  // 3-4. Title + lot numbers when present.
  if (doc.title_number !== undefined && doc.title_number !== null && doc.title_number !== '') {
    if (!validateTitleNumber(doc.title_number)) {
      issues.push({
        level: 'error',
        code: 'invalid_title_number',
        path: 'title_number',
        message: `Title number "${doc.title_number}" doesn't match PH format (TCT/CCT/OCT-NNNN).`,
      })
    }
  }
  if (doc.lot_number !== undefined && doc.lot_number !== null && doc.lot_number !== '') {
    if (!validateLotNumber(doc.lot_number)) {
      issues.push({
        level: 'error',
        code: 'invalid_lot_number',
        path: 'lot_number',
        message: `Lot number "${doc.lot_number}" must be a positive integer (with optional sub-lot suffix like -A).`,
      })
    }
  }

  // 5. Dates.
  if (doc.effective_date) {
    const t = Date.parse(doc.effective_date)
    if (Number.isNaN(t)) {
      issues.push({
        level: 'error',
        code: 'invalid_date',
        path: 'effective_date',
        message: 'Effective date isn\'t a valid date.',
      })
    } else if (t < Date.now() - 24 * 60 * 60 * 1000) {
      // Past-date is a warning, not error — backdating is a real
      // operational case (e.g. reservation receipts).
      issues.push({
        level: 'warning',
        code: 'date_in_past',
        path: 'effective_date',
        message: 'Effective date is in the past — confirm if this is intentional (back-dating).',
      })
    }
  }

  // 6. Witness count.
  if (def && def.requires_witnesses > 0) {
    const witnesses = parties.filter((p) => p.role === 'witness')
    if (witnesses.length < def.requires_witnesses) {
      issues.push({
        level: 'error',
        code: 'insufficient_witnesses',
        path: 'parties',
        message: `${def.name} requires ${def.requires_witnesses} witness(es); only ${witnesses.length} listed.`,
      })
    }
  }

  // 7. Spouse consent — flag when a married seller/principal has not
  //    yet recorded their spouse's consent and the doc-type needs it.
  if (def && def.requires_spouse_consent) {
    const subjects = parties.filter(
      (p) => p.role === 'seller' || p.role === 'principal' || p.role === 'lessor',
    )
    subjects.forEach((p, idx) => {
      if (p.is_married === true && p.spouse_consented !== true) {
        issues.push({
          level: 'error',
          code: 'missing_spouse_consent',
          path: `parties[${idx}].spouse_consented`,
          message: `${def.name} requires spouse consent for married parties; ${p.full_name || `party ${idx + 1}`} hasn't recorded it.`,
        })
      }
    })
  }

  // 8. Signatures.
  parties.forEach((p, i) => {
    // Witnesses + notaries always need signatures; skip the
    // observer-style 'other' role unless explicitly named on a sig.
    if (p.role === 'other') return
    if (p.has_signature !== true) {
      issues.push({
        level: 'warning',
        code: 'missing_signature',
        path: `parties[${i}].has_signature`,
        message: `${p.full_name || `Party ${i + 1}`} (${p.role || 'unknown role'}) doesn't have a signature placeholder.`,
      })
    }
  })

  // 9. Notarial block.
  if (def && def.requires_notary && doc.has_notarial_block !== true) {
    issues.push({
      level: 'error',
      code: 'missing_notarial_block',
      path: 'has_notarial_block',
      message: `${def.name} must be notarized; the document is missing the acknowledgment / jurat block.`,
    })
  }

  // 10. Duplicate entities (same TIN or same exact name twice).
  const seenTins = new Map<string, number>()
  const seenNames = new Map<string, number>()
  parties.forEach((p, i) => {
    if (p.tin) {
      const key = p.tin.replace(/[-\s]/g, '')
      if (seenTins.has(key)) {
        issues.push({
          level: 'warning',
          code: 'duplicate_entity',
          path: `parties[${i}].tin`,
          message: `TIN ${p.tin} appears on two parties (rows ${seenTins.get(key)! + 1} and ${i + 1}).`,
        })
      } else {
        seenTins.set(key, i)
      }
    }
    if (p.full_name) {
      const key = p.full_name.trim().toLowerCase()
      if (seenNames.has(key)) {
        issues.push({
          level: 'info',
          code: 'duplicate_entity',
          path: `parties[${i}].full_name`,
          message: `"${p.full_name}" appears twice — confirm it isn't an accidental duplicate.`,
        })
      } else {
        seenNames.set(key, i)
      }
    }
  })

  // 11. Required attachments — see per-doc-type list. Add to this
  //     map as new types come online; absence means no required
  //     attachments and the rule is a no-op.
  const attachmentRequirements: Partial<Record<string, string[]>> = {
    deed_of_absolute_sale:     ['valid_id_seller', 'valid_id_buyer', 'tax_clearance', 'title_copy'],
    contract_to_sell:          ['valid_id_seller', 'valid_id_buyer'],
    special_power_of_attorney: ['valid_id_principal', 'valid_id_attorney'],
    turnover_document:         ['unit_inspection_checklist'],
  }
  if (def) {
    const required = attachmentRequirements[def.key] ?? []
    const present = doc.attachments ?? {}
    for (const key of required) {
      if (!(key in present) || present[key] === null || present[key] === '') {
        issues.push({
          level: 'error',
          code: 'missing_attachment',
          path: `attachments.${key}`,
          message: `${def.name} requires the "${key.replace(/_/g, ' ')}" attachment.`,
        })
      }
    }
  }

  // 12. Commission percentages — non-negative, individually ≤100,
  //     sum ≤100. Numeric strings are tolerated.
  if (doc.commission_splits) {
    let total = 0
    doc.commission_splits.forEach((s, i) => {
      const n = Number(s.pct)
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        issues.push({
          level: 'error',
          code: 'invalid_percentage',
          path: `commission_splits[${i}].pct`,
          message: `Commission split #${i + 1} must be a percentage between 0 and 100.`,
        })
      } else {
        total += n
      }
    })
    if (total > 100.0001) {
      issues.push({
        level: 'error',
        code: 'percentages_exceed_total',
        path: 'commission_splits',
        message: `Commission splits sum to ${total.toFixed(2)}% — must be ≤100%.`,
      })
    }
  }

  // 13. Missing initials — every signing party should have an
  //     initials field on multi-page contracts. Skip notaries +
  //     witnesses since their roles are signature-specific.
  parties.forEach((p, i) => {
    if (p.role === 'witness' || p.role === 'notary' || p.role === 'other') return
    if (p.has_initials !== true) {
      issues.push({
        level: 'info',
        code: 'missing_initials',
        path: `parties[${i}].has_initials`,
        message: `${p.full_name || `Party ${i + 1}`} doesn't have an initials field — recommended for multi-page contracts.`,
      })
    }
  })

  return issues
}

/** Convenience: split issues by level. UIs almost always render the
 *  three buckets distinctly (red errors, amber warnings, slate info). */
export function groupIssues(issues: Issue[]): Record<IssueLevel, Issue[]> {
  const out: Record<IssueLevel, Issue[]> = { error: [], warning: [], info: [] }
  for (const issue of issues) out[issue.level].push(issue)
  return out
}
