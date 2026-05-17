// DOCX renderer — turns a draft body + canonical metadata into a
// .docx file using the `docx` library.
//
// Strategy: render plain text bodies (AI-generated, freeform) as a
// formatted Word document with paragraph breaks preserved + a
// signature block at the end built from data._signature_placeholders.
// Template-driven drafts (where draft.template_id is set) get a
// flatter rendering — each field on its own paragraph — until a
// proper templated DOCX path lands in Phase 4.
//
// Output is a Buffer the caller writes to S3 / streams to the
// browser. We don't open file handles in this helper.

// @ts-ignore — `docx` resolves after `pnpm install`; declared in package.json.
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak } from 'docx'
import { findDocumentType, type DocumentTypeDef } from '../../app/utils/documentTypes'
import { findDocumentSkeleton, type DocumentSkeleton, type SkeletonParty } from '../../app/utils/documentSkeletons'
import { parseAiMarkdown, type Block, type Span } from '../../app/utils/aiMarkdown'
import type { SignaturePlaceholder } from '../../app/utils/signaturePlaceholders'

export type DraftForExport = {
  id: string
  title: string | null
  template_id: string | null
  doc_type_key: string | null
  data: Record<string, unknown> | null
  status: string
}

// Philippine law-office typography constants. Applied uniformly to
// every TextRun and Paragraph in the document so AI-generated bodies,
// templated drafts, and signature blocks all read as one consistent
// notarial-grade contract.
//
//   Font:       Times New Roman (the de-facto standard on PH legal forms)
//   Body size:  12pt — docx half-points → 24
//   Line:       1.5 spacing → 360 twips (240 = single, 480 = double)
//   First-line: 0.5in → 720 twips (legal-page indentation convention)
//   Page:       1in top/right/bottom + 1.5in left for binding gutter
const FONT = 'Times New Roman'
const BODY_HALF_PT = 24            // 12pt
const LINE_15 = 360                // 1.5 line spacing in twips
const INDENT_05IN = 720            // 0.5 inch first-line indent
const HANGING_05IN = 360           // 0.25in hanging indent for lists

const PAGE_MARGINS = {
  top:    1440,   // 1.0 inch
  right:  1440,   // 1.0 inch
  bottom: 1440,   // 1.0 inch
  left:   2160,   // 1.5 inch — binding gutter (PH legal printing convention)
}

/** Convert an aiMarkdown Span to a docx TextRun honoring bold/italic.
 *  Every run carries the document-wide font + size so Word renders
 *  the body in Times New Roman 12pt regardless of the broker's local
 *  default. */
function spanToRun(s: Span): TextRun {
  return new TextRun({
    text: s.text,
    bold: !!s.bold,
    italics: !!s.italic,
    font: FONT,
    size: BODY_HALF_PT,
  })
}

/** Render a parsed aiMarkdown Block tree into docx Paragraphs. The
 *  same block tree is rendered to HTML on the editor + PDF side, so
 *  Word output matches what the broker sees in the live preview. */
function blocksToParagraphs(blocks: Block[]): Paragraph[] {
  const out: Paragraph[] = []
  for (const b of blocks) {
    if (b.type === 'rule') {
      // No native HR in docx; substitute a thin separator paragraph.
      out.push(
        new Paragraph({
          children: [new TextRun({
            text: '──────────────────────────────',
            color: '999999', font: FONT, size: BODY_HALF_PT,
          })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 200, line: LINE_15 },
        }),
      )
      continue
    }
    if (b.type === 'heading') {
      // H1 = document title — centered, uppercase, bold.
      // H2 = numbered section header — centered, uppercase, bold.
      // H3 = sub-section — left-aligned, bold (not uppercased).
      const heading =
        b.level === 1 ? HeadingLevel.HEADING_1 :
        b.level === 2 ? HeadingLevel.HEADING_2 :
                        HeadingLevel.HEADING_3
      const align = b.level <= 2 ? AlignmentType.CENTER : AlignmentType.LEFT
      const headingSize = b.level === 1 ? 32 : (b.level === 2 ? 26 : 24)  // 16pt / 13pt / 12pt
      const upperCase = b.level <= 2
      out.push(
        new Paragraph({
          heading,
          alignment: align,
          children: b.spans.map((s) => new TextRun({
            text: upperCase ? s.text.toUpperCase() : s.text,
            bold: true,
            italics: !!s.italic,
            font: FONT,
            size: headingSize,
          })),
          spacing: {
            before: b.level === 1 ? 0 : (b.level === 2 ? 480 : 320),
            after:  b.level === 1 ? 320 : 200,
            line: LINE_15,
          },
        }),
      )
      continue
    }
    if (b.type === 'quote') {
      out.push(
        new Paragraph({
          children: b.spans.map((s) => new TextRun({
            text: s.text,
            italics: true,
            color: '555555',
            font: FONT,
            size: BODY_HALF_PT,
          })),
          indent: { left: 720, right: 720 },
          spacing: { before: 160, after: 160, line: LINE_15 },
          alignment: AlignmentType.JUSTIFIED,
        }),
      )
      continue
    }
    if (b.type === 'list') {
      // Prepend a number / bullet to each item rather than relying on
      // docx's `numbering` reference (which would need a per-document
      // numbering config wired up). This way the Word output matches
      // the rendered preview without extra plumbing.
      b.items.forEach((item, idx) => {
        const marker = b.ordered ? `${idx + 1}. ` : '• '
        out.push(
          new Paragraph({
            children: [
              new TextRun({ text: marker, font: FONT, size: BODY_HALF_PT }),
              ...item.map(spanToRun),
            ],
            indent: { left: INDENT_05IN, hanging: HANGING_05IN },
            spacing: { after: 120, line: LINE_15 },
            alignment: AlignmentType.JUSTIFIED,
          }),
        )
      })
      continue
    }
    // paragraph — justified body with 0.5in first-line indent (legal
    // typography convention; first paragraph after a heading drops
    // the indent automatically since docx applies indent inline, not
    // contextually — we keep the indent on every paragraph and rely
    // on the heading's centered formatting to break the visual flow).
    out.push(
      new Paragraph({
        children: b.spans.map(spanToRun),
        indent: { firstLine: INDENT_05IN },
        spacing: { after: 200, line: LINE_15 },
        alignment: AlignmentType.JUSTIFIED,
      }),
    )
  }
  return out
}

/** Public: parse AI markdown body into docx paragraphs. Falls back
 *  to a plain-text blob if the body has no markdown structure (the
 *  parser still produces one paragraph block per blank-line run). */
function bodyParagraphs(body: string): Paragraph[] {
  return blocksToParagraphs(parseAiMarkdown(body))
}

/** Build a single signer's paragraph stack. The label is uppercased
 *  in the rendered output regardless of the input's case. */
function signerParagraphs(label: string, nameLabel: string, signedAt?: string | null): Paragraph[] {
  const sigLineText = signedAt
    ? `Signed: ${new Date(signedAt).toLocaleString()}`
    : '_____________________________________'
  return [
    new Paragraph({
      children: [new TextRun({
        text: `${label.toUpperCase()}:`, bold: true, font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { before: 360, after: 0, line: LINE_15 },
    }),
    new Paragraph({
      children: [new TextRun({
        text: sigLineText,
        color: signedAt ? '226F54' : '111111',
        bold: !!signedAt,
        font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { before: 240, after: 0, line: LINE_15 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `${nameLabel}: `, bold: true, font: FONT, size: BODY_HALF_PT }),
        new TextRun({ text: '__________________________________', font: FONT, size: BODY_HALF_PT }),
      ],
      spacing: { before: 120, after: 0, line: LINE_15 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Address: ', bold: true, font: FONT, size: BODY_HALF_PT }),
        new TextRun({ text: '_______________________________', font: FONT, size: BODY_HALF_PT }),
      ],
      spacing: { before: 120, after: 0, line: LINE_15 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Date: ', bold: true, font: FONT, size: BODY_HALF_PT }),
        new TextRun({ text: '__________________________________', font: FONT, size: BODY_HALF_PT }),
      ],
      spacing: { before: 120, after: 240, line: LINE_15 },
    }),
  ]
}

/** Signature block — uses the skeleton's canonical party roles when
 *  no eSign placeholders are configured. So a Lease prints LESSOR /
 *  LESSEE labels even before any DocuSign envelope is sent, and a
 *  Deed of Sale prints VENDOR / VENDEE. */
function signatureBlock(
  placeholders: SignaturePlaceholder[],
  skeleton: DocumentSkeleton,
): Paragraph[] {
  // Decide what to render: prefer placeholders (they carry role +
  // signed_at metadata from the eSign workflow), otherwise fall back
  // to the skeleton's static party roles.
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
  if (slots.length === 0) return []

  const out: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: 'SIGNED IN THE PRESENCE OF:', bold: true, font: FONT, size: 24,
      })],
      spacing: { before: 480, after: 240, line: LINE_15 },
    }),
  ]
  for (const s of slots) {
    out.push(...signerParagraphs(s.label, s.nameLabel, s.signed_at))
  }
  return out
}

/** Witness block — renders `count` witness slots. Most PH legal
 *  instruments take 2 witnesses; some (turnover, simple receipts)
 *  take 1; agency / commission docs typically take 0 (no block). */
function witnessBlock(count: number): Paragraph[] {
  if (count <= 0) return []
  const labels = Array.from({ length: count }, (_, i) => `Witness ${i + 1}`)
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: 'WITNESSES:', bold: true, font: FONT, size: 24,
      })],
      spacing: { before: 480, after: 240, line: LINE_15 },
    }),
    ...labels.flatMap((label) => [
      new Paragraph({
        children: [new TextRun({
          text: `${label.toUpperCase()}:`, bold: true, font: FONT, size: BODY_HALF_PT,
        })],
        spacing: { before: 360, after: 0, line: LINE_15 },
      }),
      new Paragraph({
        children: [new TextRun({
          text: '_____________________________________',
          font: FONT, size: BODY_HALF_PT,
        })],
        spacing: { before: 240, after: 0, line: LINE_15 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Printed name: ', bold: true, font: FONT, size: BODY_HALF_PT }),
          new TextRun({ text: '__________________________', font: FONT, size: BODY_HALF_PT }),
        ],
        spacing: { before: 120, after: 240, line: LINE_15 },
      }),
    ]),
  ]
}

/** Spouse consent block — required by Family Code Art. 96 / 124 for
 *  acts of administration / disposition over conjugal property
 *  (deeds of sale of conjugal property, SPAs covering disposition,
 *  etc.). We render a separate signature slot so the spouse signs
 *  alongside the principal, not as a witness. */
function spouseConsentBlock(): Paragraph[] {
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: 'SPOUSE’S CONFORMITY', bold: true, font: FONT, size: 24,
      })],
      spacing: { before: 480, after: 240, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      indent: { firstLine: INDENT_05IN },
      children: [new TextRun({
        text: 'I, the spouse of the above-named party, hereby give my CONFORMITY and CONSENT to the foregoing instrument insofar as it affects our conjugal/community property under Articles 96 and 124 of the Family Code of the Philippines.',
        font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { after: 240, line: LINE_15 },
    }),
    ...signerParagraphs('SPOUSE', 'Printed name', null),
  ]
}

/** Acknowledgment block — canonical Philippine 2004 Rules on
 *  Notarial Practice form. Rendered on its own page before the
 *  notary's signature block so the document is "registry-ready."
 *
 *  This is the boilerplate that every notarized PH instrument
 *  (lease, deed of sale, deed of donation, SPA, etc.) carries; the
 *  affiant identifiers stay blank for the notary public to fill at
 *  oath time. */
function acknowledgmentBlock(): Paragraph[] {
  return [
    new Paragraph({
      children: [new PageBreak()],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: 'ACKNOWLEDGMENT', bold: true, font: FONT, size: 26,
      })],
      spacing: { before: 0, after: 360, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({ text: 'REPUBLIC OF THE PHILIPPINES', bold: true, font: FONT, size: BODY_HALF_PT }),
        new TextRun({ text: '\t\t\t)', font: FONT, size: BODY_HALF_PT }),
      ],
      spacing: { after: 0, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({ text: 'CITY/PROVINCE OF ____________________', bold: true, font: FONT, size: BODY_HALF_PT }),
        new TextRun({ text: '\t) S.S.', font: FONT, size: BODY_HALF_PT }),
      ],
      spacing: { after: 360, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      indent: { firstLine: INDENT_05IN },
      children: [new TextRun({
        text: 'BEFORE ME, a Notary Public for and in the above jurisdiction, personally appeared the parties named in this instrument, who proved their identities to me through competent evidence of identity, and acknowledged that the foregoing instrument is their free and voluntary act and deed.',
        font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { after: 240, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      indent: { firstLine: INDENT_05IN },
      children: [new TextRun({
        text: 'This instrument, consisting of ____ page(s), refers to a real-estate transaction and has been signed by the parties and their witnesses on each and every page hereof.',
        font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { after: 240, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      indent: { firstLine: INDENT_05IN },
      children: [new TextRun({
        text: 'WITNESS MY HAND AND SEAL on this ____ day of ____________________, 20____ at ____________________, Philippines.',
        font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { after: 480, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({
        text: '__________________________________',
        font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { before: 240, after: 0, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({
        text: 'NOTARY PUBLIC',
        bold: true, font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { after: 0, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({
        text: 'Doc. No. _____;', font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { before: 480, after: 0, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({
        text: 'Page No. _____;', font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { after: 0, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({
        text: 'Book No. _____;', font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { after: 0, line: LINE_15 },
    }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({
        text: 'Series of 20___.', font: FONT, size: BODY_HALF_PT,
      })],
      spacing: { after: 240, line: LINE_15 },
    }),
  ]
}

function templateFieldParagraphs(
  data: Record<string, unknown>,
): Paragraph[] {
  // Strip out our internal `_*` fields — _parties, _signature_placeholders,
  // _ai_body, etc. Those render through other code paths.
  const fields = Object.entries(data).filter(([k]) => !k.startsWith('_') && k !== 'ai_body')
  if (fields.length === 0) return []
  return fields.map(([key, value]) =>
    new Paragraph({
      children: [
        new TextRun({ text: humanizeKey(key) + ': ', bold: true, font: FONT, size: BODY_HALF_PT }),
        new TextRun({ text: String(value ?? ''), font: FONT, size: BODY_HALF_PT }),
      ],
      indent: { firstLine: INDENT_05IN },
      spacing: { after: 120, line: LINE_15 },
      alignment: AlignmentType.JUSTIFIED,
    }),
  )
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Render a draft to a DOCX Buffer. The caller decides where the
 *  bytes go (S3 upload, streamed download, etc.). */
export async function renderDraftToDocx(draft: DraftForExport): Promise<Buffer> {
  const data = (draft.data ?? {}) as Record<string, unknown>
  const aiBody = typeof data.ai_body === 'string' ? (data.ai_body as string) : ''
  const placeholders = Array.isArray(data._signature_placeholders)
    ? (data._signature_placeholders as SignaturePlaceholder[])
    : []
  const docType = findDocumentType(draft.doc_type_key)
  const skeleton = findDocumentSkeleton(draft.doc_type_key)

  const sections = []

  // Document title — prefer the skeleton's canonical title (e.g.
  // "DEED OF ABSOLUTE SALE"), fall back to the draft's broker-edited
  // title, then to the doc-type name. Always uppercased + centered.
  const resolvedTitle = (
    skeleton.title || draft.title || docType?.name || 'Document'
  ).toUpperCase()
  const titleChildren: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: resolvedTitle,
        bold: true,
        font: FONT,
        size: 32, // 16pt for title (one step above H1's 16pt — emphasized cover)
      })],
      spacing: { after: 320, line: LINE_15 },
    }),
  ]
  if (docType && docType.name !== resolvedTitle) {
    titleChildren.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: docType.name, italics: true, color: '666666',
          font: FONT, size: BODY_HALF_PT,
        })],
        spacing: { after: 480, line: LINE_15 },
      }),
    )
  }

  // Recital — opening "This Agreement is entered into ..." paragraph
  // for the doc type. We only inject it when the body doesn't already
  // start with a recital of its own (AI bodies tend to write their
  // own; templated drafts don't). Heuristic: skip injection if the AI
  // body's first non-blank line is a heading OR mentions one of the
  // skeleton's party labels in caps within its first 200 chars.
  const aiHasOwnRecital = aiBody && (
    /^#{1,3}\s/m.test(aiBody.slice(0, 200))
    || skeleton.parties.some((p) =>
      aiBody.slice(0, 600).includes(p.label),
    )
  )
  const recitalChildren: Paragraph[] =
    skeleton.recital && !aiHasOwnRecital
      ? [
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            indent: { firstLine: INDENT_05IN },
            children: [new TextRun({
              text: skeleton.recital, font: FONT, size: BODY_HALF_PT,
            })],
            spacing: { after: 240, line: LINE_15 },
          }),
        ]
      : []

  // Body — AI/freeform takes precedence. Otherwise we render the
  // template fields one per paragraph as a fallback.
  const bodyChildren: Paragraph[] = aiBody
    ? bodyParagraphs(aiBody)
    : templateFieldParagraphs(data)

  // Detect whether the AI body already includes its own signature /
  // witness / acknowledgment sections. The prompt asks for them, but
  // we don't want to duplicate when present — keying off the canonical
  // section headings (case-insensitive). When absent, we append a
  // boilerplate block so every exported draft still ships with the
  // right registry-ready structure.
  const aiHasSignatures      = /^##\s+(SIGNATURES|SIGNATURE PAGE|SIGNED IN THE PRESENCE OF)/im.test(aiBody)
  const aiHasWitnesses       = /^##\s+WITNESSES/im.test(aiBody)
  const aiHasAcknowledgment  = /^##\s+ACKNOWLEDG(M|E)?MENT/im.test(aiBody)

  const trailing: Paragraph[] = []

  // Signatures — render unless the AI already wrote its own. We
  // always emit the block now (even without eSign placeholders)
  // because the skeleton supplies canonical role labels per doc
  // type (LESSOR/LESSEE for lease, VENDOR/VENDEE for deed of sale,
  // PRINCIPAL/ATTORNEY-IN-FACT for SPA, etc.).
  if (!aiHasSignatures) {
    trailing.push(...signatureBlock(placeholders, skeleton))
  }

  // Spouse consent — required when the doc type or skeleton flags
  // it (Family Code Art. 96/124). Goes after signatures, before
  // witnesses, so the spouse signs adjacent to the principal.
  if (
    (docType?.requires_spouse_consent || skeleton.has_spouse_consent_block)
    && !aiHasSignatures
  ) {
    trailing.push(...spouseConsentBlock())
  }

  // Witnesses — count comes from the doc type registry. Most types
  // need 2; some need 1 (turnover); some need 0 (agency, demand).
  if (
    docType
    && docType.requires_witnesses > 0
    && !aiHasWitnesses
  ) {
    trailing.push(...witnessBlock(docType.requires_witnesses))
  }

  // Acknowledgment — full PH 2004 Notarial Practice form on its own
  // page. Append unless the AI already supplied one.
  if (docType?.requires_notary && !aiHasAcknowledgment) {
    trailing.push(...acknowledgmentBlock())
  }

  sections.push({
    properties: {
      page: {
        // 1in top/right/bottom + 1.5in left for binding gutter — the
        // PH legal printing convention. Templates in the wizard's
        // print preview use the same margins.
        margin: PAGE_MARGINS,
      },
    },
    children: [
      ...titleChildren,
      ...recitalChildren,
      ...bodyChildren,
      ...trailing,
    ],
  })

  const doc = new Document({
    creator: 'Housing Interactive',
    title: draft.title || docType?.name || 'Document',
    description: docType?.description || undefined,
    sections,
  })

  return await Packer.toBuffer(doc)
}
