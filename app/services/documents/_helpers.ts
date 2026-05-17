// Shared helpers for the document-generator pipeline. One place for the
// patterns every generator used to copy: HTML escaping, the POST to
// /api/documents/generate-docx with a timeout, and the html2pdf option
// preset. Reduces ~60 lines of duplication per generator and gives a
// single point to change behavior (timeout, error handling, etc.).

const ENT: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes a value for safe interpolation into an HTML template. Use this
 * for every user-supplied string before .replace()-ing into the template.
 *
 * Returns '' for null/undefined to avoid the literal "undefined" appearing
 * in generated documents.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ENT[c] ?? c)
}

/** Convenience: applies escapeHtml to every value in a flat object. */
export function escapeAll<T extends Record<string, unknown>>(values: T): Record<keyof T, string> {
  const out = {} as Record<keyof T, string>
  for (const k in values) out[k] = escapeHtml(values[k])
  return out
}

export type GenerateDocxMetadata = {
  /** Cross-entity link — surfaces on contact's unified timeline. */
  contact_id?: number | string | null
  /** Cross-entity link — surfaces on listing's timeline + per-listing inbox. */
  listing_id?: number | string | null
  /** Display fields; show up in /documents dashboard subtitles. */
  client_name?: string | null
  lessor_name?: string | null
  lessee_name?: string | null
  buyer_name?: string | null
  seller_name?: string | null
  owner_name?: string | null
  property_id?: number | string | null
  [key: string]: unknown
}

export type GenerateDocxResult = {
  success: boolean
  fileUrl: string
  message?: string
}

/**
 * POSTs to /api/documents/generate-docx with a 30s timeout. Strips
 * undefined / null metadata values so the server payload stays clean.
 * Throws a descriptive Error on any non-2xx response so the caller
 * can surface a toast.
 */
export async function callGenerateDocx(
  htmlTemplate: string,
  documentName: string,
  metadata: GenerateDocxMetadata = {},
  opts: { timeoutMs?: number } = {},
): Promise<GenerateDocxResult> {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const timeoutMs = opts.timeoutMs ?? 30_000

  // Drop nullish keys — keeps the payload tight and avoids stamping
  // null all over metadata. The server treats missing keys the same as
  // null, so no behavioral change.
  const cleanedMeta: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== undefined && v !== null && v !== '') cleanedMeta[k] = v
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${origin}/api/documents/generate-docx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ htmlTemplate, documentName, metadata: cleanedMeta }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(
        `generate-docx failed (${res.status}): ${errBody || res.statusText}`,
      )
    }
    const json = (await res.json()) as GenerateDocxResult
    if (!json?.fileUrl) throw new Error('Document generated but no file URL returned.')
    return json
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Document generation timed out after ${timeoutMs / 1000}s.`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Triggers a browser download for a server-returned signed URL. Same
 * mechanism every generator should use — single place to fix if
 * download UX changes (e.g. opening a preview pane instead).
 */
export function downloadFromUrl(url: string, filename?: string) {
  if (!url) return
  const a = document.createElement('a')
  a.href = url
  if (filename) a.download = filename
  a.target = '_blank'
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/**
 * Default html2pdf options shared by every generator that still creates
 * a client-side PDF. Most generators no longer need this — the server
 * emits the canonical DOCX — but a few flows (Tax computation, etc.)
 * keep client-side PDF generation.
 */
export function defaultPdfOptions(filename: string) {
  return {
    margin: 10,
    filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      logging: false,
      async: true,
    },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
  }
}
