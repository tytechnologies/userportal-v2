/**
 * Tiny markdown parser tailored for AI-generated legal-document
 * bodies. Returns a block tree the editor preview, the DOCX
 * renderer, and the PDF renderer all consume so the styling stays
 * consistent across surfaces.
 *
 * Why not a full markdown library: we ship `docx` for Word output
 * and Puppeteer for PDF — the markdown surface we accept is small
 * (headings, bold, italic, numbered/bulleted lists, paragraphs, hr)
 * and the alternative pulls another 50–200 KB into both bundles.
 *
 * Supported syntax:
 *   # H1     ## H2     ### H3      (heading levels above 3 collapse to H3)
 *   **bold**       *italic*        within paragraphs and list items
 *   - bullet       * bullet        unordered list (mixable bullets)
 *   1. item        2. item         ordered list (any digit + dot)
 *   ---  ***                       horizontal rule
 *   > line                         blockquote (single level)
 *   blank line                     paragraph break
 *   single newline                 soft line break inside the same block
 *
 * Anything else passes through as plain text. The parser is
 * intentionally forgiving — AI output is not guaranteed to be valid
 * markdown.
 */

export type Span = {
  text: string
  bold?: boolean
  italic?: boolean
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'list'; ordered: boolean; items: Span[][] }
  | { type: 'quote'; spans: Span[] }
  | { type: 'rule' }

const HEADING_RE = /^(#{1,6})\s+(.+)$/
const RULE_RE    = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE_RE   = /^>\s?(.*)$/
const ULIST_RE   = /^[-*]\s+(.+)$/
const OLIST_RE   = /^\d+\.\s+(.+)$/

/** Parse a single line into Span runs honoring **bold** + *italic*.
 *  Plain-text fallback when no tokens match. */
export function parseSpans(input: string): Span[] {
  if (!input) return []
  const out: Span[] = []
  // Walk the string and pull out **...** then *...* greedy-non-overlap.
  // We don't support nested emphasis; the AI rarely produces it and
  // the legal-doc surface doesn't need it.
  let i = 0
  let buf = ''
  const flushBuf = (style?: { bold?: boolean; italic?: boolean }) => {
    if (!buf) return
    out.push({ text: buf, ...(style ?? {}) })
    buf = ''
  }
  while (i < input.length) {
    if (input[i] === '*' && input[i + 1] === '*') {
      // bold span: find closing **
      const end = input.indexOf('**', i + 2)
      if (end > i + 2) {
        flushBuf()
        out.push({ text: input.slice(i + 2, end), bold: true })
        i = end + 2
        continue
      }
    }
    if (input[i] === '*') {
      // italic span: find closing *
      const end = input.indexOf('*', i + 1)
      if (end > i + 1) {
        flushBuf()
        out.push({ text: input.slice(i + 1, end), italic: true })
        i = end + 1
        continue
      }
    }
    buf += input[i]
    i += 1
  }
  flushBuf()
  // Coalesce adjacent same-style runs to keep the output compact.
  return coalesce(out)
}

function coalesce(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && !!last.bold === !!s.bold && !!last.italic === !!s.italic) {
      last.text += s.text
    } else {
      out.push({ ...s })
    }
  }
  return out
}

/** Parse an AI-generated markdown body into a list of structural
 *  blocks. Empty input → []. */
export function parseAiMarkdown(input: string): Block[] {
  if (!input) return []
  // Normalize CRLF → LF so the line splits behave consistently.
  const text = input.replace(/\r\n?/g, '\n').trim()
  const lines = text.split('\n')
  const blocks: Block[] = []

  let i = 0
  while (i < lines.length) {
    const raw = lines[i] as string
    const line = raw.trim()

    // Skip blank lines between blocks.
    if (line === '') {
      i += 1
      continue
    }

    // Horizontal rule.
    if (RULE_RE.test(line)) {
      blocks.push({ type: 'rule' })
      i += 1
      continue
    }

    // Heading. Levels above 3 cap at H3 because docx + our PDF CSS
    // only style three levels meaningfully.
    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      const hashes = headingMatch[1] as string
      const level = Math.min(hashes.length, 3) as 1 | 2 | 3
      blocks.push({
        type: 'heading',
        level,
        spans: parseSpans(headingMatch[2] as string),
      })
      i += 1
      continue
    }

    // Blockquote — single line for now; multi-line quotes coalesce
    // into one block by reading ahead while lines start with `>`.
    if (QUOTE_RE.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length) {
        const m = QUOTE_RE.exec((lines[i] as string).trim())
        if (!m) break
        quoteLines.push(m[1] as string)
        i += 1
      }
      blocks.push({
        type: 'quote',
        spans: parseSpans(quoteLines.join(' ')),
      })
      continue
    }

    // Unordered list — read forward while consecutive lines match.
    if (ULIST_RE.test(line)) {
      const items: Span[][] = []
      while (i < lines.length) {
        const m = ULIST_RE.exec((lines[i] as string).trim())
        if (!m) break
        items.push(parseSpans(m[1] as string))
        i += 1
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    // Ordered list.
    if (OLIST_RE.test(line)) {
      const items: Span[][] = []
      while (i < lines.length) {
        const m = OLIST_RE.exec((lines[i] as string).trim())
        if (!m) break
        items.push(parseSpans(m[1] as string))
        i += 1
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    // Paragraph: collect consecutive non-blank lines until next
    // blank or block-starting line. Soft-newlines inside a paragraph
    // turn into spaces so wrapped legal text reads naturally.
    const paraLines: string[] = []
    while (i < lines.length) {
      const next = (lines[i] as string).trim()
      if (
        next === ''
        || HEADING_RE.test(next)
        || RULE_RE.test(next)
        || QUOTE_RE.test(next)
        || ULIST_RE.test(next)
        || OLIST_RE.test(next)
      ) break
      paraLines.push(next)
      i += 1
    }
    blocks.push({
      type: 'paragraph',
      spans: parseSpans(paraLines.join(' ')),
    })
  }
  return blocks
}

/** Escape an arbitrary string for safe HTML text-node insertion. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function spansToHtml(spans: Span[]): string {
  return spans
    .map((s) => {
      let html = escHtml(s.text)
      if (s.italic) html = `<em>${html}</em>`
      if (s.bold)   html = `<strong>${html}</strong>`
      return html
    })
    .join('')
}

/** Render a block tree to safe HTML. Used by the editor preview AND
 *  the PDF renderer (which feeds the HTML to Puppeteer). The CSS
 *  styling lives in the consumer; this emitter outputs semantic
 *  HTML only. */
export function renderAiMarkdownHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'rule') return '<hr>'
      if (b.type === 'heading') {
        return `<h${b.level}>${spansToHtml(b.spans)}</h${b.level}>`
      }
      if (b.type === 'quote') {
        return `<blockquote>${spansToHtml(b.spans)}</blockquote>`
      }
      if (b.type === 'list') {
        const tag = b.ordered ? 'ol' : 'ul'
        const items = b.items.map((i) => `<li>${spansToHtml(i)}</li>`).join('')
        return `<${tag}>${items}</${tag}>`
      }
      // paragraph
      return `<p>${spansToHtml(b.spans)}</p>`
    })
    .join('\n')
}

/** Convenience: parse + render in one call. */
export function aiMarkdownToHtml(input: string): string {
  return renderAiMarkdownHtml(parseAiMarkdown(input))
}
