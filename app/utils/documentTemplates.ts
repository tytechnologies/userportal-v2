// Registry of editable document templates.
//
// Each template defines a background image (PNG/JPG/SVG sitting in
// /public) and a list of fields with absolute pixel positions. The
// DocumentEditor component:
//   - paints the background at its natural size,
//   - overlays one input per field at the configured (x, y),
//   - persists the field values into document_drafts.data as JSONB.
//
// Adding a new template:
//   1. Drop the background image into /public/templates/<name>.png.
//   2. Eyeball the input positions in your image editor — write x/y
//      in pixels relative to the image's top-left.
//   3. Add an entry below.
//
// Field key naming is keyed into `data` JSONB and surfaced in the print
// CSS as `[data-field="<key>"]`, so keep keys snake_case and stable.

export type FieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'textarea'
  | 'email'
  | 'tel'
  /** Click-to-sign: editor renders a tile that opens SignatureModal;
   *  the PNG lands in draft.data._signatures.<key>.path. */
  | 'signature'

export type FieldValidation = {
  required?: boolean
  minLength?: number
  maxLength?: number
  /** Regex source (no slashes / flags). Passed straight to new RegExp. */
  pattern?: string
  /** Inclusive numeric bounds for type='number'. */
  min?: number
  max?: number
  /** Override the default per-rule message. */
  message?: string
}

export type DocumentTemplateField = {
  key: string
  type: FieldType
  /** Pixel offset from the background's top-left corner. */
  x: number
  y: number
  /** Optional rendered width in px. Defaults to 200. */
  width?: number
  /** Optional rendered height in px. Defaults to 28 for inputs, 80 for textareas. */
  height?: number
  /** Placeholder text shown when the field is empty. */
  placeholder?: string
  /** UI label for the field summary panel. Defaults to a humanized key. */
  label?: string
  /** Validation rules applied by validateField() and the editor's pre-save check. */
  validation?: FieldValidation
}

export type DocumentTemplate = {
  id: string
  name: string
  description?: string
  /** Path under /public, e.g. /templates/lease.png. */
  background: string
  /** Natural width / height of the background, used for layout sizing. */
  width: number
  height: number
  fields: DocumentTemplateField[]
}

// Single sample template — enough to validate the editor end-to-end.
// More templates land here as they're authored.
export const documentTemplates: DocumentTemplate[] = [
  {
    id: 'lease_agreement',
    name: 'Lease Agreement',
    description:
      'Quick fillable lease form. Outputs a JSONB record; print it from the editor for a hard copy.',
    background: '/templates/lease.png',
    width: 816,  // 8.5" @ 96 DPI
    height: 1056, // 11" @ 96 DPI
    fields: [
      { key: 'tenant_name',   type: 'text',     x: 120, y: 220, width: 300, label: 'Tenant name',
        validation: { required: true, maxLength: 120 } },
      { key: 'landlord_name', type: 'text',     x: 120, y: 260, width: 300, label: 'Landlord name',
        validation: { required: true, maxLength: 120 } },
      { key: 'property_address', type: 'text',  x: 120, y: 300, width: 500, label: 'Property address',
        validation: { required: true, maxLength: 240 } },
      { key: 'rent',          type: 'number',   x: 300, y: 360, width: 160, label: 'Monthly rent (₱)',
        validation: { required: true, min: 0, max: 100_000_000 } },
      { key: 'start_date',    type: 'date',     x: 150, y: 420, width: 180, label: 'Start date',
        validation: { required: true } },
      { key: 'end_date',      type: 'date',     x: 400, y: 420, width: 180, label: 'End date' },
      { key: 'notes',         type: 'textarea', x: 120, y: 500, width: 600, height: 160, label: 'Notes',
        validation: { maxLength: 2000 } },
    ],
  },
]

export function findTemplate(id: string | null | undefined): DocumentTemplate | null {
  if (!id) return null
  return documentTemplates.find((t) => t.id === id) ?? null
}

/** Humanize a snake_case key for use as a fallback label. */
export function humanizeFieldKey(key: string): string {
  return key
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

// =====================================================================
// Validation
// =====================================================================
//
// validateField(field, raw) returns the first failing rule's message, or
// null when the value is acceptable. validateAll(template, data) returns
// a map of { [field.key]: messageOrNull } so the editor can render
// per-field errors and decide whether to block save.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Permissive E.164-ish: optional +, 7–20 digits with optional separators.
const PHONE_RE = /^\+?[\d\s().-]{7,24}$/

export function validateTemplateField(
  field: DocumentTemplateField,
  raw: unknown,
): string | null {
  const v = field.validation ?? {}

  // Signature fields don't carry a textual value — their "filled-ness"
  // is the presence of a path in data._signatures.<key>. The editor
  // hands us the path as `raw` for these fields; missing = unsigned.
  if (field.type === 'signature') {
    if (v.required && (!raw || (typeof raw === 'string' && raw.trim() === ''))) {
      return v.message ?? `${field.label ?? humanizeFieldKey(field.key)} requires a signature.`
    }
    return null
  }

  // Normalize to a string for length checks; keep the raw value for the
  // numeric branch so '12.5' stays useful.
  const str = raw === null || raw === undefined ? '' : String(raw).trim()

  if (v.required && str === '') {
    return v.message ?? `${field.label ?? humanizeFieldKey(field.key)} is required.`
  }
  // After the required check, an empty optional field passes everything.
  if (str === '') return null

  if (v.minLength !== undefined && str.length < v.minLength) {
    return v.message ?? `Must be at least ${v.minLength} characters.`
  }
  if (v.maxLength !== undefined && str.length > v.maxLength) {
    return v.message ?? `Must be at most ${v.maxLength} characters.`
  }

  if (field.type === 'email' && !EMAIL_RE.test(str)) {
    return v.message ?? 'Enter a valid email address.'
  }
  if (field.type === 'tel' && !PHONE_RE.test(str)) {
    return v.message ?? 'Enter a valid phone number.'
  }

  if (field.type === 'number') {
    const n = Number(str)
    if (Number.isNaN(n)) return v.message ?? 'Must be a number.'
    if (v.min !== undefined && n < v.min) {
      return v.message ?? `Must be at least ${v.min}.`
    }
    if (v.max !== undefined && n > v.max) {
      return v.message ?? `Must be at most ${v.max}.`
    }
  }

  if (v.pattern) {
    try {
      const re = new RegExp(v.pattern)
      if (!re.test(str)) return v.message ?? 'Format is invalid.'
    } catch {
      // Bad pattern in the template registry — log and pass; this is a
      // template-author bug, not a user input bug.
      console.warn('[validateTemplateField] bad regex pattern:', v.pattern)
    }
  }

  return null
}

export type FieldErrors = Record<string, string | null>

export function validateAll(
  template: DocumentTemplate | null,
  data: Record<string, unknown>,
): FieldErrors {
  if (!template) return {}
  const errors: FieldErrors = {}
  for (const f of template.fields) {
    errors[f.key] = validateTemplateField(f, data[f.key])
  }
  return errors
}

/** True iff at least one error message is present in `errors`. */
export function hasAnyError(errors: FieldErrors): boolean {
  for (const k in errors) {
    if (errors[k]) return true
  }
  return false
}
