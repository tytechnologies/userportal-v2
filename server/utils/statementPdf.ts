// Statement PDF renderer.
//
// Two output shapes:
//   renderTenantStatementPdf  — period charges + payments; balance due
//   renderOwnerStatementPdf   — period income / expenses / withholding;
//                               net disbursement
//
// Built on pdf-lib (already in package.json — used by document_drafts).
// Returns Uint8Array; the endpoint sets Content-Type +
// Content-Disposition.

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib'

// Bottom margin reserved for the page footer (centered timestamp +
// statement_no). Anything within FOOTER_RESERVE of the bottom needs
// to flow to a new page.
const FOOTER_RESERVE = 56

// ---------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------

type LineItem = {
  kind?: string
  description?: string
  charge_no?: string
  work_order_no?: string
  amount_minor?: number
  paid_minor?: number
  unit_id?: string
  period_start?: string | null
  due_at?: string | null
  paid_at?: string | null
  completed_at?: string | null
  total_minor?: number
}

export type TenantStatementInput = {
  statement: {
    statement_no: string
    period_start: string
    period_end: string
    currency: string
    rent_billed_minor: number
    other_charges_minor: number
    payments_received_minor: number
    balance_due_minor: number
    line_items: LineItem[]
    status: string
    issued_at: string | null
    due_at: string | null
    paid_at: string | null
    voided_at: string | null
    void_reason: string | null
    metadata: Record<string, unknown>
    created_at: string
  }
  lease: {
    id: string
    unit_id: string
    rent_minor: number
    currency: string
  } | null
  tenant: {
    name: string | null
    email: string | null
    user_id: string | null
  } | null
  unit: {
    unit_number: string | null
    building_id: string | null
  } | null
}

export type OwnerStatementInput = {
  statement: {
    statement_no: string
    period_start: string
    period_end: string
    currency: string
    rent_collected_minor: number
    dues_collected_minor: number
    expenses_minor: number
    management_fee_minor: number
    tax_withheld_minor: number
    net_disbursement_minor: number
    line_items: LineItem[]
    status: string
    issued_at: string | null
    disbursed_at: string | null
    voided_at: string | null
    void_reason: string | null
    metadata: Record<string, unknown>
    created_at: string
  }
  owner: {
    name: string | null
    email: string | null
    tax_id: string | null
  } | null
}

// ---------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------

// Letter size 612 x 792 with 48pt margins. Roomy enough for branding +
// table while still fitting most statements on one page.
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN_X = 48
const MARGIN_Y = 56

const C_TEXT = rgb(0.11, 0.13, 0.18) // ink
const C_MUTED = rgb(0.45, 0.49, 0.55) // muted-foreground
const C_RULE = rgb(0.88, 0.88, 0.92) // border
const C_PRIMARY = rgb(0.16, 0.32, 0.55) // editorial navy
const C_DESTRUCT = rgb(0.79, 0.16, 0.16)
const C_SUCCESS = rgb(0.13, 0.55, 0.34)

type Cursor = { y: number }

function fmtMinor(minor: number, currency = 'PHP'): string {
  const major = (minor || 0) / 100
  try {
    return new Intl.NumberFormat('en-PH', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(major)
  } catch {
    return `${currency} ${major.toFixed(2)}`
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-PH', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

function statusColor(status: string): ReturnType<typeof rgb> {
  switch (status) {
    case 'paid':
    case 'disbursed':
    case 'tenant_signed':
      return C_SUCCESS
    case 'overdue':
    case 'void':
      return C_DESTRUCT
    case 'issued':
      return C_PRIMARY
    default:
      return C_MUTED
  }
}

// Page-flow primitives. Multi-page support uses these to add a new
// page when the current cursor doesn't have room for the next block.
//
// `flowState` lets the renderer track the current page + a list of all
// pages emitted, so the footer can show "Page N of M" on each.

type FlowState = {
  doc: PDFDocument
  fonts: { regular: PDFFont; bold: PDFFont }
  page: PDFPage
  pages: PDFPage[]
  cursor: Cursor
  // Set of (title, subtitle, statementNo) so the continuation header
  // can repeat the brand mark + identifier.
  brandTitle: string
  brandSubtitle: string
  statementNo: string
}

function newFlow(
  doc: PDFDocument,
  fonts: { regular: PDFFont; bold: PDFFont },
  brandTitle: string,
  brandSubtitle: string,
  statementNo: string,
): FlowState {
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  return {
    doc,
    fonts,
    page,
    pages: [page],
    cursor: { y: PAGE_HEIGHT - MARGIN_Y },
    brandTitle,
    brandSubtitle,
    statementNo,
  }
}

function flowToNewPage(state: FlowState, requiredHeight: number): void {
  // If there's enough room on the current page, no-op.
  if (state.cursor.y - requiredHeight >= FOOTER_RESERVE) return

  const page = state.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  state.page = page
  state.pages.push(page)
  state.cursor.y = PAGE_HEIGHT - MARGIN_Y

  // Continuation header — small "Continued from page N" label so the
  // operator can correlate spilled tables.
  const label = `${state.brandTitle} — continued (statement ${state.statementNo})`
  page.drawText(label, {
    x: MARGIN_X,
    y: state.cursor.y,
    size: 9,
    font: state.fonts.regular,
    color: C_MUTED,
  })
  state.cursor.y -= 14
  drawRule(page, state.cursor)
}

function drawHeader(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  title: string,
  subtitle: string,
  cursor: Cursor,
): void {
  page.drawText('Housing Interactive', {
    x: MARGIN_X,
    y: cursor.y,
    size: 10,
    font: fonts.bold,
    color: C_PRIMARY,
  })
  cursor.y -= 24
  page.drawText(title, {
    x: MARGIN_X,
    y: cursor.y,
    size: 22,
    font: fonts.bold,
    color: C_TEXT,
  })
  cursor.y -= 16
  page.drawText(subtitle, {
    x: MARGIN_X,
    y: cursor.y,
    size: 11,
    font: fonts.regular,
    color: C_MUTED,
  })
  cursor.y -= 18
}

function drawRule(page: PDFPage, cursor: Cursor, color = C_RULE, lineWidth = 0.5): void {
  page.drawLine({
    start: { x: MARGIN_X, y: cursor.y },
    end: { x: PAGE_WIDTH - MARGIN_X, y: cursor.y },
    thickness: lineWidth,
    color,
  })
  cursor.y -= 14
}

function drawKvTwoCol(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  rows: Array<[string, string]>,
  cursor: Cursor,
): void {
  // Two-column layout: each column is half the writable width.
  const colWidth = (PAGE_WIDTH - 2 * MARGIN_X) / 2
  for (let i = 0; i < rows.length; i += 2) {
    const left = rows[i]
    const right = rows[i + 1]
    if (left) drawKvPair(page, fonts, left, MARGIN_X, cursor.y)
    if (right) drawKvPair(page, fonts, right, MARGIN_X + colWidth, cursor.y)
    cursor.y -= 26
  }
}

function drawKvPair(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  pair: [string, string],
  x: number,
  y: number,
): void {
  page.drawText(pair[0].toUpperCase(), {
    x,
    y,
    size: 8,
    font: fonts.bold,
    color: C_MUTED,
  })
  page.drawText(pair[1] || '—', {
    x,
    y: y - 12,
    size: 11,
    font: fonts.regular,
    color: C_TEXT,
  })
}

function drawTotalsRow(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  label: string,
  value: string,
  cursor: Cursor,
  opts: { bold?: boolean; emphasize?: boolean; tone?: 'normal' | 'positive' | 'negative' } = {},
): void {
  const labelFont = opts.bold ? fonts.bold : fonts.regular
  const valueFont = opts.emphasize ? fonts.bold : opts.bold ? fonts.bold : fonts.regular
  const labelSize = opts.emphasize ? 12 : 10
  const valueSize = opts.emphasize ? 13 : 11
  const valueColor =
    opts.tone === 'negative' ? C_DESTRUCT : opts.tone === 'positive' ? C_SUCCESS : C_TEXT

  page.drawText(label, {
    x: MARGIN_X,
    y: cursor.y,
    size: labelSize,
    font: labelFont,
    color: opts.emphasize ? C_TEXT : C_MUTED,
  })
  // Right-align the value.
  const valueWidth = valueFont.widthOfTextAtSize(value, valueSize)
  page.drawText(value, {
    x: PAGE_WIDTH - MARGIN_X - valueWidth,
    y: cursor.y,
    size: valueSize,
    font: valueFont,
    color: valueColor,
  })
  cursor.y -= opts.emphasize ? 22 : 16
}

// Truncate text to the available column width. pdf-lib doesn't word
// wrap; we cut at characters and append an ellipsis. Adequate for
// statement line items where descriptions are typically short.
function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (!text) return ''
  const w = font.widthOfTextAtSize(text, size)
  if (w <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = ((lo + hi) >> 1) + 1
    const trial = text.slice(0, mid) + '…'
    if (font.widthOfTextAtSize(trial, size) > maxWidth) hi = mid - 1
    else lo = mid
  }
  return text.slice(0, lo) + '…'
}

// Multi-page line-item table. Handles the per-row page-break check so
// long statements flow onto continuation pages without truncating.
// Re-renders the table header on each new page so partner-side
// readers don't lose column context after a break.
function drawLineItemTableFlowed(
  state: FlowState,
  rows: Array<{ description: string; meta?: string; amount: string; tone?: 'normal' | 'positive' | 'negative' }>,
  currency: string,
): void {
  const colDescX = MARGIN_X
  const colMetaX = MARGIN_X
  const colAmountRight = PAGE_WIDTH - MARGIN_X
  const descWidth = (PAGE_WIDTH - 2 * MARGIN_X) * 0.7

  const drawHeaderRow = () => {
    state.page.drawText('DESCRIPTION', {
      x: colDescX,
      y: state.cursor.y,
      size: 8,
      font: state.fonts.bold,
      color: C_MUTED,
    })
    const amtHdr = `AMOUNT (${currency})`
    state.page.drawText(amtHdr, {
      x: colAmountRight - state.fonts.bold.widthOfTextAtSize(amtHdr, 8),
      y: state.cursor.y,
      size: 8,
      font: state.fonts.bold,
      color: C_MUTED,
    })
    state.cursor.y -= 8
    drawRule(state.page, state.cursor)
  }

  // Reserve enough room for header + rule. Minimum row is 16pt;
  // typical with meta is 24pt. Pre-flow if even the header + a row
  // wouldn't fit.
  flowToNewPage(state, 8 + 14 + 16)
  drawHeaderRow()

  if (rows.length === 0) {
    state.page.drawText('No line items recorded for this period.', {
      x: MARGIN_X,
      y: state.cursor.y,
      size: 10,
      font: state.fonts.regular,
      color: C_MUTED,
    })
    state.cursor.y -= 18
    return
  }

  for (const row of rows) {
    const rowHeight = row.meta ? 24 : 16
    // If this row + its meta line wouldn't fit, flow + repeat the header.
    if (state.cursor.y - rowHeight < FOOTER_RESERVE) {
      flowToNewPage(state, 8 + 14 + rowHeight)
      drawHeaderRow()
    }

    const trunc = truncate(row.description, state.fonts.regular, 10, descWidth)
    state.page.drawText(trunc, {
      x: colDescX,
      y: state.cursor.y,
      size: 10,
      font: state.fonts.regular,
      color: C_TEXT,
    })
    if (row.meta) {
      const metaTrunc = truncate(row.meta, state.fonts.regular, 8, descWidth)
      state.page.drawText(metaTrunc, {
        x: colMetaX,
        y: state.cursor.y - 11,
        size: 8,
        font: state.fonts.regular,
        color: C_MUTED,
      })
    }
    const valueColor =
      row.tone === 'negative' ? C_DESTRUCT : row.tone === 'positive' ? C_SUCCESS : C_TEXT
    state.page.drawText(row.amount, {
      x: colAmountRight - state.fonts.regular.widthOfTextAtSize(row.amount, 10),
      y: state.cursor.y,
      size: 10,
      font: state.fonts.regular,
      color: valueColor,
    })
    state.cursor.y -= rowHeight
  }
}

// Iterate every page in the flow state and stamp the per-page footer
// with "Page N of M · Generated … · Statement <no>".
function drawFootersAll(state: FlowState): void {
  const total = state.pages.length
  for (let i = 0; i < total; i++) {
    const page = state.pages[i]!
    const text = `Page ${i + 1} of ${total} · Generated ${new Date().toISOString()} · Statement ${state.statementNo} · Housing Interactive PH`
    const w = state.fonts.regular.widthOfTextAtSize(text, 8)
    page.drawText(text, {
      x: (PAGE_WIDTH - w) / 2,
      y: 28,
      size: 8,
      font: state.fonts.regular,
      color: C_MUTED,
    })
  }
}

// ---------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------

export async function renderTenantStatementPdf(input: TenantStatementInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  }

  const { statement, lease, tenant, unit } = input

  // FlowState handles multi-page reflow. drawLineItemTableFlowed +
  // pre-totals flowToNewPage cover the two unbounded sections.
  const state = newFlow(
    doc,
    fonts,
    'Tenant Statement',
    `${statement.statement_no} · ${fmtDate(statement.period_start)} – ${fmtDate(statement.period_end)}`,
    statement.statement_no,
  )

  drawHeader(
    state.page,
    fonts,
    `Tenant Statement`,
    `${statement.statement_no} · ${fmtDate(statement.period_start)} – ${fmtDate(statement.period_end)}`,
    state.cursor,
  )

  // Status badge as text.
  const statusLabel = `Status: ${statement.status.toUpperCase()}`
  state.page.drawText(statusLabel, {
    x: MARGIN_X,
    y: state.cursor.y,
    size: 10,
    font: fonts.bold,
    color: statusColor(statement.status),
  })
  state.cursor.y -= 22

  drawRule(state.page, state.cursor)

  // Identity / context block.
  drawKvTwoCol(
    state.page,
    fonts,
    [
      ['Tenant', tenant?.name ?? tenant?.email ?? '—'],
      ['Unit', unit?.unit_number ? `Unit ${unit.unit_number}` : '—'],
      ['Issued', fmtDate(statement.issued_at)],
      ['Due', fmtDate(statement.due_at)],
      ['Currency', statement.currency],
      ['Status', statement.status],
    ],
    state.cursor,
  )
  state.cursor.y -= 6
  drawRule(state.page, state.cursor)

  // Line items (multi-page-aware).
  const lineRows: Parameters<typeof drawLineItemTableFlowed>[1] = []
  for (const li of statement.line_items ?? []) {
    if (!li) continue
    const desc = li.description ?? li.kind ?? 'Charge'
    const meta = [li.charge_no, li.period_start, li.due_at]
      .filter(Boolean)
      .map((v) =>
        typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v as string) : String(v),
      )
      .join(' · ')
    const amount = fmtMinor(Number(li.amount_minor ?? li.total_minor ?? 0), statement.currency)
    lineRows.push({ description: desc, meta: meta || undefined, amount })
  }
  drawLineItemTableFlowed(state, lineRows, statement.currency)
  state.cursor.y -= 6
  drawRule(state.page, state.cursor)

  // Totals — reserve enough room for the entire block (5 rows × ~16pt
  // + 2 rules + the emphasized line ≈ 110pt) before drawing.
  flowToNewPage(state, 110)
  drawTotalsRow(
    state.page,
    fonts,
    'Rent billed',
    fmtMinor(statement.rent_billed_minor, statement.currency),
    state.cursor,
  )
  drawTotalsRow(
    state.page,
    fonts,
    'Other charges',
    fmtMinor(statement.other_charges_minor, statement.currency),
    state.cursor,
  )
  drawTotalsRow(
    state.page,
    fonts,
    'Payments received',
    `(${fmtMinor(statement.payments_received_minor, statement.currency)})`,
    state.cursor,
    { tone: 'positive' },
  )
  state.cursor.y -= 4
  drawRule(state.page, state.cursor, C_TEXT, 0.8)
  drawTotalsRow(
    state.page,
    fonts,
    'Balance due',
    fmtMinor(statement.balance_due_minor, statement.currency),
    state.cursor,
    {
      bold: true,
      emphasize: true,
      tone: statement.balance_due_minor > 0 ? 'negative' : 'positive',
    },
  )
  drawRule(state.page, state.cursor, C_TEXT, 0.8)

  // Void notice if applicable.
  if (statement.status === 'void' && statement.void_reason) {
    flowToNewPage(state, 40)
    state.cursor.y -= 8
    state.page.drawText('VOIDED', {
      x: MARGIN_X,
      y: state.cursor.y,
      size: 11,
      font: fonts.bold,
      color: C_DESTRUCT,
    })
    state.cursor.y -= 14
    state.page.drawText(
      `Reason: ${truncate(statement.void_reason, fonts.regular, 10, PAGE_WIDTH - 2 * MARGIN_X)}`,
      { x: MARGIN_X, y: state.cursor.y, size: 10, font: fonts.regular, color: C_MUTED },
    )
  }

  drawFootersAll(state)
  return doc.save()
}

export async function renderOwnerStatementPdf(input: OwnerStatementInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  }
  const { statement, owner } = input

  const state = newFlow(
    doc,
    fonts,
    'Owner Statement',
    `${statement.statement_no} · ${fmtDate(statement.period_start)} – ${fmtDate(statement.period_end)}`,
    statement.statement_no,
  )

  drawHeader(
    state.page,
    fonts,
    `Owner Statement`,
    `${statement.statement_no} · ${fmtDate(statement.period_start)} – ${fmtDate(statement.period_end)}`,
    state.cursor,
  )

  state.page.drawText(`Status: ${statement.status.toUpperCase()}`, {
    x: MARGIN_X,
    y: state.cursor.y,
    size: 10,
    font: fonts.bold,
    color: statusColor(statement.status),
  })
  state.cursor.y -= 22

  drawRule(state.page, state.cursor)

  drawKvTwoCol(
    state.page,
    fonts,
    [
      ['Owner', owner?.name ?? owner?.email ?? '—'],
      ['BIR TIN', owner?.tax_id ?? '—'],
      ['Issued', fmtDate(statement.issued_at)],
      ['Disbursed', fmtDate(statement.disbursed_at)],
      ['Currency', statement.currency],
      ['Status', statement.status],
    ],
    state.cursor,
  )
  state.cursor.y -= 6
  drawRule(state.page, state.cursor)

  // Line items section header.
  state.page.drawText('PERIOD ACTIVITY', {
    x: MARGIN_X,
    y: state.cursor.y,
    size: 9,
    font: fonts.bold,
    color: C_MUTED,
  })
  state.cursor.y -= 12

  const ownerLineRows: Parameters<typeof drawLineItemTableFlowed>[1] = []
  for (const li of statement.line_items ?? []) {
    if (!li) continue
    const kind = li.kind ?? ''
    const desc = li.description ?? (kind ? kind.replace('_', ' ') : 'Activity')
    const meta = [li.charge_no, li.work_order_no, li.paid_at, li.completed_at]
      .filter(Boolean)
      .map((v) =>
        typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v as string) : String(v),
      )
      .join(' · ')
    const amountMinor = Number(li.amount_minor ?? li.total_minor ?? 0)
    const tone: 'normal' | 'positive' | 'negative' =
      kind.startsWith('expense') || kind === 'tax_withheld' || kind === 'management_fee'
        ? 'negative'
        : 'positive'
    const formatted = fmtMinor(amountMinor, statement.currency)
    ownerLineRows.push({
      description: desc,
      meta: meta || undefined,
      amount: tone === 'negative' ? `(${formatted})` : formatted,
      tone,
    })
  }
  drawLineItemTableFlowed(state, ownerLineRows, statement.currency)
  state.cursor.y -= 6
  drawRule(state.page, state.cursor)

  // Totals block: 5 line rows + 2 rules + emphasized net ≈ 130pt.
  flowToNewPage(state, 130)
  drawTotalsRow(
    state.page,
    fonts,
    'Rent collected',
    fmtMinor(statement.rent_collected_minor, statement.currency),
    state.cursor,
    { tone: 'positive' },
  )
  drawTotalsRow(
    state.page,
    fonts,
    'Dues collected',
    fmtMinor(statement.dues_collected_minor, statement.currency),
    state.cursor,
    { tone: 'positive' },
  )
  drawTotalsRow(
    state.page,
    fonts,
    'Expenses',
    `(${fmtMinor(statement.expenses_minor, statement.currency)})`,
    state.cursor,
    { tone: 'negative' },
  )
  drawTotalsRow(
    state.page,
    fonts,
    'Management fee',
    `(${fmtMinor(statement.management_fee_minor, statement.currency)})`,
    state.cursor,
    { tone: 'negative' },
  )
  drawTotalsRow(
    state.page,
    fonts,
    'Tax withheld',
    `(${fmtMinor(statement.tax_withheld_minor, statement.currency)})`,
    state.cursor,
    { tone: 'negative' },
  )
  state.cursor.y -= 4
  drawRule(state.page, state.cursor, C_TEXT, 0.8)
  drawTotalsRow(
    state.page,
    fonts,
    'Net disbursement',
    fmtMinor(statement.net_disbursement_minor, statement.currency),
    state.cursor,
    {
      bold: true,
      emphasize: true,
      tone: statement.net_disbursement_minor >= 0 ? 'positive' : 'negative',
    },
  )
  drawRule(state.page, state.cursor, C_TEXT, 0.8)

  if (statement.status === 'void' && statement.void_reason) {
    flowToNewPage(state, 40)
    state.cursor.y -= 8
    state.page.drawText('VOIDED', {
      x: MARGIN_X,
      y: state.cursor.y,
      size: 11,
      font: fonts.bold,
      color: C_DESTRUCT,
    })
    state.cursor.y -= 14
    state.page.drawText(
      `Reason: ${truncate(statement.void_reason, fonts.regular, 10, PAGE_WIDTH - 2 * MARGIN_X)}`,
      { x: MARGIN_X, y: state.cursor.y, size: 10, font: fonts.regular, color: C_MUTED },
    )
  }

  drawFootersAll(state)
  return doc.save()
}
