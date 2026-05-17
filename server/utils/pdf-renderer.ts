// Server-side PDF renderer via Puppeteer.
//
// We render an HTML string, not a URL — the broker auth context
// can't follow Puppeteer into a child Chromium tab. Instead, we
// build the HTML server-side from the same draft data the DOCX
// renderer uses, then ask Puppeteer to render-to-PDF.
//
// Why server-side over client-side (browser print-to-PDF):
//   1. Consistent fonts across machines (Chromium ships its own)
//   2. Reliable page breaks + headers/footers
//   3. Hash for tamper-evidence (caller can compute a SHA-256 over
//      the bytes after rendering)
//
// Cold-start cost: Chromium is ~200MB and Puppeteer launches it on
// first use of the function. We cache the browser handle in module
// scope so subsequent renders reuse it; Vercel will recycle it on
// instance shutdown.

import type { Browser } from 'puppeteer'
import { findDocumentType } from '../../app/utils/documentTypes'
import { findDocumentSkeleton, type DocumentSkeleton, type SkeletonParty } from '../../app/utils/documentSkeletons'
import { aiMarkdownToHtml } from '../../app/utils/aiMarkdown'
import type { SignaturePlaceholder } from '../../app/utils/signaturePlaceholders'
import type { DraftForExport } from './docx-renderer'

let browserPromise: Promise<Browser> | null = null

async function getBrowser(opts: {
  headless: boolean
  extraArgs: string[]
}): Promise<Browser> {
  if (browserPromise) return browserPromise
  const puppeteerSpecifier = 'puppeteer'
  const { default: puppeteer } = await import(/* @vite-ignore */ puppeteerSpecifier)

  const browser = puppeteer.launch({
    headless: opts.headless,
    // Default args make the browser run leaner inside containerized
    // serverless environments. The admin can append more via the
    // platform_settings.pdf_render config.
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      ...opts.extraArgs,
    ],
  })
  browserPromise = browser
  return browser
}

/** Escape an arbitrary string for safe HTML text-node insertion.
 *  We use this for everything coming out of draft.data — the editor
 *  doesn't sanitize on the way in, and we don't want a <script> in
 *  an AI body to execute when Puppeteer renders the page. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function bodyToHtml(body: string): string {
  // Parse AI-generated markdown (headings, bold, italic, lists,
  // blockquotes, hr) into safe HTML. The same parser feeds the
  // editor preview + the DOCX renderer so all three surfaces stay
  // visually consistent. The parser HTML-escapes every span before
  // emitting tags — body text can't smuggle a <script>.
  return aiMarkdownToHtml(body)
}

/** Render a single signer row. */
function signerHtml(label: string, nameLabel: string, signedAt?: string | null): string {
  const sigLine = signedAt
    ? `<div class="sig-signed">Signed: ${esc(new Date(signedAt).toLocaleString())}</div>`
    : `<div class="sig-line">_____________________________________</div>`
  return `
    <div class="sig-block">
      <div class="sig-label">${esc(label.toUpperCase())}:</div>
      ${sigLine}
      <div class="sig-id"><strong>${esc(nameLabel)}:</strong> __________________________________</div>
      <div class="sig-id"><strong>Address:</strong> _______________________________</div>
      <div class="sig-id"><strong>Date:</strong> __________________________________</div>
    </div>`
}

/** Signature block — uses the skeleton's canonical party roles when
 *  no eSign placeholders are configured. So a Lease prints LESSOR /
 *  LESSEE labels and a Deed of Sale prints VENDOR / VENDEE. */
function signatureBlockHtml(
  placeholders: SignaturePlaceholder[],
  skeleton: DocumentSkeleton,
): string {
  type Slot = { label: string; nameLabel: string; signed_at?: string | null }
  const slots: Slot[] = placeholders.length > 0
    ? placeholders.map((p) => {
        const role = p.party_role.replace(/_/g, ' ').toUpperCase()
        const merged = p.label.toUpperCase() === role ? p.label : `${p.label} (${role})`
        return { label: merged, nameLabel: 'Name', signed_at: p.signed_at }
      })
    : skeleton.parties.map((r: SkeletonParty) => ({
        label: r.label,
        nameLabel: r.name_label || 'Printed name',
      }))
  if (slots.length === 0) return ''
  const rows = slots.map((s) => signerHtml(s.label, s.nameLabel, s.signed_at)).join('\n')
  return `
    <section class="signatures">
      <h2>SIGNED IN THE PRESENCE OF:</h2>
      ${rows}
    </section>`
}

function witnessBlockHtml(count: number): string {
  if (count <= 0) return ''
  const labels = Array.from({ length: count }, (_, i) => `Witness ${i + 1}`)
  const rows = labels
    .map((label) => `
      <div class="sig-block">
        <div class="sig-label">${esc(label.toUpperCase())}:</div>
        <div class="sig-line">_____________________________________</div>
        <div class="sig-id"><strong>Printed name:</strong> __________________________</div>
      </div>`)
    .join('\n')
  return `
    <section class="witnesses">
      <h2>WITNESSES:</h2>
      ${rows}
    </section>`
}

/** Spouse consent — Family Code Art. 96 / 124. */
function spouseConsentBlockHtml(): string {
  return `
    <section class="signatures spouse-consent">
      <h2>SPOUSE'S CONFORMITY</h2>
      <p>I, the spouse of the above-named party, hereby give my CONFORMITY and CONSENT to the foregoing instrument insofar as it affects our conjugal/community property under Articles 96 and 124 of the Family Code of the Philippines.</p>
      ${signerHtml('SPOUSE', 'Printed name', null)}
    </section>`
}

function acknowledgmentHtml(): string {
  // Canonical Philippine 2004 Rules on Notarial Practice acknowledgment.
  // Rendered on its own page before the notary's signature so the
  // export is registry-ready. Affiant identifiers stay blank for
  // the notary public to fill at oath time.
  return `
    <section class="notary-block">
      <h2>ACKNOWLEDGMENT</h2>
      <table class="notary-jurisdiction">
        <tr><td><strong>REPUBLIC OF THE PHILIPPINES</strong></td><td>)</td></tr>
        <tr><td><strong>CITY/PROVINCE OF ____________________</strong></td><td>) S.S.</td></tr>
      </table>
      <p>BEFORE ME, a Notary Public for and in the above jurisdiction, personally appeared the parties named in this instrument, who proved their identities to me through competent evidence of identity, and acknowledged that the foregoing instrument is their free and voluntary act and deed.</p>
      <p>This instrument, consisting of ____ page(s), refers to a real-estate transaction and has been signed by the parties and their witnesses on each and every page hereof.</p>
      <p>WITNESS MY HAND AND SEAL on this ____ day of ____________________, 20____ at ____________________, Philippines.</p>
      <div class="notary-sig">
        <div class="sig-line">__________________________________</div>
        <div class="sig-label">NOTARY PUBLIC</div>
      </div>
      <div class="notary-doc-page">
        <div>Doc. No. _____;</div>
        <div>Page No. _____;</div>
        <div>Book No. _____;</div>
        <div>Series of 20___.</div>
      </div>
    </section>`
}

function buildHtml(draft: DraftForExport, paperFormat: string): string {
  const data = (draft.data ?? {}) as Record<string, unknown>
  const aiBody = typeof data.ai_body === 'string' ? (data.ai_body as string) : ''
  const placeholders = Array.isArray(data._signature_placeholders)
    ? (data._signature_placeholders as SignaturePlaceholder[])
    : []
  const docType = findDocumentType(draft.doc_type_key)
  const skeleton = findDocumentSkeleton(draft.doc_type_key)

  const bodyHtml = aiBody
    ? bodyToHtml(aiBody)
    : Object.entries(data)
        .filter(([k]) => !k.startsWith('_') && k !== 'ai_body')
        .map(([k, v]) => `<p><strong>${esc(humanizeKey(k))}:</strong> ${esc(String(v ?? ''))}</p>`)
        .join('\n')

  // Skip the structured signature/witness/notary blocks when the AI
  // body already wrote its own — keys off the canonical headings the
  // prompt asks for. Same pattern as the DOCX renderer.
  const aiHasSignatures      = /^##\s+(SIGNATURES|SIGNATURE PAGE|SIGNED IN THE PRESENCE OF)/im.test(aiBody)
  const aiHasWitnesses       = /^##\s+WITNESSES/im.test(aiBody)
  const aiHasAcknowledgment  = /^##\s+ACKNOWLEDG(M|E)?MENT/im.test(aiBody)

  // Recital — opening "This Agreement is entered into..." paragraph
  // for the doc type. Skipped when the AI body already provides one
  // (heuristic: starts with a heading or mentions a party label
  // within the first 600 chars).
  const aiHasOwnRecital = aiBody && (
    /^#{1,3}\s/m.test(aiBody.slice(0, 200))
    || skeleton.parties.some((p: SkeletonParty) =>
      aiBody.slice(0, 600).includes(p.label),
    )
  )
  const recitalHtml = (skeleton.recital && !aiHasOwnRecital)
    ? `<p class="recital">${esc(skeleton.recital)}</p>`
    : ''

  // Always emit the structured signature block — the skeleton
  // supplies canonical role labels per doc type even without
  // eSign placeholders.
  const sigHtml = !aiHasSignatures
    ? signatureBlockHtml(placeholders, skeleton)
    : ''
  // Spouse consent — when the doc type or skeleton flags it.
  const spouseConsentHtml =
    ((docType?.requires_spouse_consent || skeleton.has_spouse_consent_block)
      && !aiHasSignatures)
      ? spouseConsentBlockHtml()
      : ''
  // Witness count comes from the doc type registry; 0 means no block.
  const witnessHtml  = (docType && docType.requires_witnesses > 0 && !aiHasWitnesses)
    ? witnessBlockHtml(docType.requires_witnesses)
    : ''
  const notaryBlock  = (docType?.requires_notary && !aiHasAcknowledgment)
    ? acknowledgmentHtml()
    : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(draft.title || docType?.name || 'Document')}</title>
<style>
  /* Page geometry: 1in top/right/bottom + 1.5in left for the binding
     gutter. Standard PH legal printing convention; matches Word's
     equivalent setting in the DOCX export. */
  @page {
    size: ${paperFormat};
    margin: 1in 1in 1in 1.5in;
  }
  body {
    font-family: 'Times New Roman', Georgia, serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #000;
    margin: 0;
    padding: 0;
    text-align: justify;
  }
  /* Headings — all serif Times so the document reads as one consistent
     formal contract. H1 = document title (centered uppercase, 16pt
     bold); H2 = numbered section header (centered uppercase, 13pt
     bold); H3 = sub-section (left, 12pt bold). */
  h1 {
    text-align: center;
    font-size: 16pt;
    letter-spacing: 0.06em;
    margin: 0 0 0.5em 0;
    font-weight: bold;
    text-transform: uppercase;
    line-height: 1.3;
  }
  h2 {
    text-align: center;
    font-size: 13pt;
    letter-spacing: 0.04em;
    margin: 1.6em 0 0.5em 0;
    font-weight: bold;
    text-transform: uppercase;
    line-height: 1.3;
  }
  h3 {
    font-size: 12pt;
    margin: 1.1em 0 0.3em 0;
    font-weight: bold;
    line-height: 1.3;
  }
  .doc-type {
    text-align: center;
    font-style: italic;
    color: #555;
    margin-bottom: 2.2em;
    font-size: 11pt;
  }
  /* Opening recital paragraph — the "This Agreement is entered into
     ..." paragraph that appears right under the title on legal forms.
     Same justified body type as paragraphs but without first-line
     indent (it's the cover paragraph). */
  .recital {
    text-indent: 0;
    margin: 0 0 1.5em 0;
  }
  /* Spouse consent — slightly distinct from the main signature block
     so the conformity paragraph reads as the consent reason. */
  .spouse-consent { margin-top: 2em; }
  .spouse-consent p { text-indent: 0.5in; margin: 0.4em 0 1em 0; }
  /* Paragraphs: justified with 0.5in first-line indent (legal
     typography convention). First paragraph after a heading drops
     the indent. */
  p {
    margin: 0 0 0.6em 0;
    orphans: 2;
    widows: 2;
    text-indent: 0.5in;
  }
  h1 + p, h2 + p, h3 + p { text-indent: 0; }
  /* Numbered + bulleted lists — hanging indent, left-aligned items.
     The first-line-indent on the body text doesn't apply to list
     items because they sit inside ol/ul, not p. */
  ol, ul {
    margin: 0.5em 0 1em 0.5in;
    padding: 0;
    text-align: left;
  }
  li { margin: 0.3em 0; padding-left: 0.25in; }
  blockquote {
    margin: 0.7em 0.5in;
    font-style: italic;
    color: #444;
  }
  hr {
    border: 0;
    border-top: 1px solid #999;
    margin: 1.5em 0;
  }
  strong { font-weight: bold; }
  em { font-style: italic; }

  /* Signature section — kept on a single page when possible. Each
     signer is a distinct block with role label + blank signature
     line + identifier rows underneath. */
  .signatures, .witnesses {
    margin-top: 2.5em;
    page-break-inside: avoid;
  }
  .signatures h2, .witnesses h2 {
    text-align: center;
    letter-spacing: 0.06em;
  }
  .sig-block {
    margin: 1.4em 0;
    page-break-inside: avoid;
  }
  .sig-label {
    font-weight: bold;
    margin-bottom: 0.6em;
    letter-spacing: 0.02em;
  }
  .sig-line {
    margin: 0.3em 0 0.3em 0;
    color: #000;
    letter-spacing: -1px;
  }
  .sig-signed {
    margin: 0.3em 0;
    color: #166534;
    font-weight: bold;
  }
  .sig-id {
    margin: 0.25em 0;
    color: #000;
  }

  /* Acknowledgment / Notary page — registry-ready PH 2004 Notarial
     Practice form. Always starts on its own page. */
  .notary-block {
    page-break-before: always;
    margin-top: 0;
  }
  .notary-block h2 {
    text-align: center;
    letter-spacing: 0.1em;
    margin-bottom: 1.5em;
    font-size: 13pt;
  }
  .notary-jurisdiction {
    width: auto;
    border: none;
    border-collapse: collapse;
    margin: 0 0 1.5em 0;
  }
  .notary-jurisdiction td {
    padding: 0.1em 0.4em;
    vertical-align: top;
    border: none;
  }
  .notary-block p {
    text-indent: 0.5in;
    margin: 0.6em 0;
  }
  .notary-sig {
    margin-top: 2em;
    margin-left: 50%;
    text-align: left;
  }
  .notary-sig .sig-line {
    margin-bottom: 0.3em;
  }
  .notary-sig .sig-label {
    font-weight: bold;
    text-align: center;
    margin-left: -1em;
  }
  .notary-doc-page {
    margin-top: 2.5em;
  }
  .notary-doc-page div {
    margin: 0.2em 0;
  }
</style>
</head>
<body>
<h1 class="title">${esc((skeleton.title || draft.title || docType?.name || 'Document').toUpperCase())}</h1>
${(docType && docType.name !== (skeleton.title || draft.title || docType?.name || 'Document').toUpperCase())
  ? `<p class="doc-type">${esc(docType.name)}</p>` : ''}
${recitalHtml}
${bodyHtml}
${sigHtml}
${spouseConsentHtml}
${witnessHtml}
${notaryBlock}
</body>
</html>`
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Render a draft to a PDF Buffer using Puppeteer. */
export async function renderDraftToPdf(
  draft: DraftForExport,
  config: {
    headless?: boolean
    timeout_ms?: number
    extra_args?: string[]
    paper_format?: 'Letter' | 'A4' | 'Legal'
    margin_mm?: number
  } = {},
): Promise<Buffer> {
  const browser = await getBrowser({
    headless: config.headless ?? true,
    extraArgs: config.extra_args ?? [],
  })

  const page = await browser.newPage()
  try {
    page.setDefaultTimeout(config.timeout_ms ?? 30_000)
    const html = buildHtml(draft, config.paper_format ?? 'Letter')
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdf = await page.pdf({
      format: config.paper_format ?? 'Letter',
      printBackground: true,
      margin: {
        top:    `${config.margin_mm ?? 12}mm`,
        right:  `${config.margin_mm ?? 12}mm`,
        bottom: `${config.margin_mm ?? 12}mm`,
        left:   `${config.margin_mm ?? 12}mm`,
      },
    })
    return Buffer.from(pdf)
  } finally {
    await page.close().catch(() => undefined)
  }
}
