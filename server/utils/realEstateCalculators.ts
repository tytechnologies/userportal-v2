// Philippine real-estate calculators.
//
// Pure functions, zero side effects, fully deterministic. Operates on
// MAJOR UNITS (PHP, not centavos) since these are advisory tools used
// in client meetings, not ledger entries. The PM stack continues to
// use minor units everywhere it touches money.
//
// Default rates match BIR / LGU practice as of 2026-05-08:
//   DST          1.5% of (selling price OR zonal/fair-market value, whichever is higher)
//   CGT          6%   of (selling price OR zonal/fair-market value, whichever is higher)
//   Transfer     0.5–0.75% of selling price (LGU-dependent; default 0.75%)
//   VAT          12%  of commission income
//   Creditable   5% (under VAT threshold) or 10% (over) WHT on commission
//
// Each calculator accepts overrides so operators in transitional
// periods can dial in custom rates. If BIR reforms a rate, change a
// default constant — call sites stay the same.

// ---------------------------------------------------------------------
// Shared types + helpers
// ---------------------------------------------------------------------

export type Currency = 'PHP'

export type DstInput = {
  selling_price: number
  zonal_or_fair_value?: number
  /** override default 0.015 (1.5%). */
  rate?: number
}

export type CgtInput = {
  selling_price: number
  zonal_or_fair_value?: number
  /** override default 0.06 (6%). */
  rate?: number
}

export type TransferTaxInput = {
  selling_price: number
  /** override default 0.0075 (0.75%). LGUs differ — Quezon City 0.50%, Makati 0.75%, etc. */
  rate?: number
}

export type MortgageInput = {
  /** Loan principal (post-down-payment). */
  principal: number
  /** Annual nominal rate as decimal — 0.075 for 7.5%. */
  annual_rate: number
  /** Term in years. */
  term_years: number
}

export type AmortizationInput = MortgageInput & {
  /** Cap the schedule to first N rows (defaults to full term). */
  max_rows?: number
}

export type RoiInput = {
  /** Sum of monthly rent over the period. */
  annual_rental_income: number
  /** Annual operating expenses (mgmt fee + dues + maintenance + tax). */
  annual_operating_expenses: number
  /** Property purchase price (or fair value at acquisition). */
  property_value: number
}

export type CommissionTaxInput = {
  /** Gross commission (typically 3–5% of selling price for sale, or 1 month's rent for lease). */
  commission_amount: number
  /** Whether the broker is VAT-registered. Default true (most active brokers). */
  vat_registered?: boolean
  /** Whether the client deducts creditable WHT. Default true. */
  withholding_applies?: boolean
}

export type Breakdown = Array<{ label: string; amount: number }>

const DST_RATE = 0.015
const CGT_RATE = 0.06
const TRANSFER_RATE = 0.0075
const VAT_RATE = 0.12
const WHT_RATE_VAT = 0.05 // creditable WHT for VAT-registered brokers
const WHT_RATE_NON_VAT = 0.1 // higher rate for non-VAT brokers

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------
// DST — Documentary Stamp Tax
// ---------------------------------------------------------------------

export function dst(input: DstInput): { tax: number; basis: number; rate: number; breakdown: Breakdown } {
  if (!Number.isFinite(input.selling_price) || input.selling_price < 0) {
    throw new Error('selling_price must be a non-negative number')
  }
  const rate = input.rate ?? DST_RATE
  // BIR rule: tax base = HIGHER of selling price or zonal/fair value.
  const basis = Math.max(input.selling_price, input.zonal_or_fair_value ?? 0)
  const tax = round2(basis * rate)
  return {
    tax,
    basis,
    rate,
    breakdown: [
      { label: 'Selling price', amount: round2(input.selling_price) },
      { label: 'Zonal / fair value', amount: round2(input.zonal_or_fair_value ?? 0) },
      { label: 'Tax base (higher of the two)', amount: round2(basis) },
      { label: `DST @ ${(rate * 100).toFixed(2)}%`, amount: tax },
    ],
  }
}

// ---------------------------------------------------------------------
// CGT — Capital Gains Tax
// ---------------------------------------------------------------------

export function cgt(input: CgtInput): { tax: number; basis: number; rate: number; breakdown: Breakdown } {
  if (!Number.isFinite(input.selling_price) || input.selling_price < 0) {
    throw new Error('selling_price must be a non-negative number')
  }
  const rate = input.rate ?? CGT_RATE
  const basis = Math.max(input.selling_price, input.zonal_or_fair_value ?? 0)
  const tax = round2(basis * rate)
  return {
    tax,
    basis,
    rate,
    breakdown: [
      { label: 'Selling price', amount: round2(input.selling_price) },
      { label: 'Zonal / fair value', amount: round2(input.zonal_or_fair_value ?? 0) },
      { label: 'Tax base (higher of the two)', amount: round2(basis) },
      { label: `CGT @ ${(rate * 100).toFixed(2)}%`, amount: tax },
    ],
  }
}

// ---------------------------------------------------------------------
// Transfer Tax (LGU)
// ---------------------------------------------------------------------

export function transferTax(
  input: TransferTaxInput,
): { tax: number; basis: number; rate: number; breakdown: Breakdown } {
  if (!Number.isFinite(input.selling_price) || input.selling_price < 0) {
    throw new Error('selling_price must be a non-negative number')
  }
  const rate = input.rate ?? TRANSFER_RATE
  const tax = round2(input.selling_price * rate)
  return {
    tax,
    basis: round2(input.selling_price),
    rate,
    breakdown: [
      { label: 'Selling price', amount: round2(input.selling_price) },
      { label: `Transfer tax @ ${(rate * 100).toFixed(3)}%`, amount: tax },
    ],
  }
}

// ---------------------------------------------------------------------
// Mortgage — monthly payment (P&I)
// ---------------------------------------------------------------------

export function mortgage(
  input: MortgageInput,
): { monthly_payment: number; total_paid: number; total_interest: number; n_months: number } {
  if (!Number.isFinite(input.principal) || input.principal <= 0) {
    throw new Error('principal must be > 0')
  }
  if (!Number.isFinite(input.annual_rate) || input.annual_rate < 0) {
    throw new Error('annual_rate must be >= 0')
  }
  if (!Number.isFinite(input.term_years) || input.term_years <= 0) {
    throw new Error('term_years must be > 0')
  }
  const n = Math.round(input.term_years * 12)
  const r = input.annual_rate / 12
  // Standard amortization formula. r=0 short-circuit avoids division
  // by zero (no-interest loan = principal / n).
  const monthly =
    r === 0
      ? input.principal / n
      : (input.principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
  const total = monthly * n
  return {
    monthly_payment: round2(monthly),
    total_paid: round2(total),
    total_interest: round2(total - input.principal),
    n_months: n,
  }
}

// ---------------------------------------------------------------------
// Amortization schedule
// ---------------------------------------------------------------------

export type AmortizationRow = {
  month: number
  payment: number
  interest: number
  principal: number
  balance: number
}

export function amortization(input: AmortizationInput): {
  rows: AmortizationRow[]
  monthly_payment: number
  total_paid: number
  total_interest: number
  truncated: boolean
} {
  const m = mortgage(input)
  const r = input.annual_rate / 12
  const cap = input.max_rows ?? m.n_months
  let balance = input.principal
  const rows: AmortizationRow[] = []
  for (let i = 1; i <= m.n_months && rows.length < cap; i++) {
    const interest = round2(balance * r)
    let principal = round2(m.monthly_payment - interest)
    // Final-row rounding: pay whatever's left so balance lands at 0.
    if (i === m.n_months) {
      principal = round2(balance)
    }
    balance = round2(balance - principal)
    if (balance < 0) balance = 0
    rows.push({
      month: i,
      payment: round2(interest + principal),
      interest,
      principal,
      balance,
    })
  }
  return {
    rows,
    monthly_payment: m.monthly_payment,
    total_paid: m.total_paid,
    total_interest: m.total_interest,
    truncated: rows.length < m.n_months,
  }
}

// ---------------------------------------------------------------------
// ROI / Cap Rate
// ---------------------------------------------------------------------

export function roi(
  input: RoiInput,
): {
  noi: number
  cap_rate: number
  cap_rate_pct: number
  gross_yield: number
  gross_yield_pct: number
  breakdown: Breakdown
} {
  if (!Number.isFinite(input.property_value) || input.property_value <= 0) {
    throw new Error('property_value must be > 0')
  }
  const income = Math.max(0, input.annual_rental_income)
  const expenses = Math.max(0, input.annual_operating_expenses)
  const noi = round2(income - expenses)
  const cap = noi / input.property_value
  const gross = income / input.property_value
  return {
    noi,
    cap_rate: cap,
    cap_rate_pct: round2(cap * 100),
    gross_yield: gross,
    gross_yield_pct: round2(gross * 100),
    breakdown: [
      { label: 'Annual rental income', amount: round2(income) },
      { label: 'Annual operating expenses', amount: round2(expenses) },
      { label: 'Net operating income (NOI)', amount: noi },
      { label: 'Property value', amount: round2(input.property_value) },
      { label: 'Cap rate', amount: round2(cap * 100) },
      { label: 'Gross rental yield', amount: round2(gross * 100) },
    ],
  }
}

// ---------------------------------------------------------------------
// Commission tax support — VAT + creditable WHT
// ---------------------------------------------------------------------

export function commissionTax(
  input: CommissionTaxInput,
): {
  gross: number
  vat: number
  wht: number
  net_received: number
  breakdown: Breakdown
} {
  if (!Number.isFinite(input.commission_amount) || input.commission_amount < 0) {
    throw new Error('commission_amount must be a non-negative number')
  }
  const vatRegistered = input.vat_registered ?? true
  const whtApplies = input.withholding_applies ?? true

  // VAT-registered brokers add 12% VAT on top of their commission;
  // the client pays gross+VAT to the broker, who remits the 12%.
  const gross = round2(input.commission_amount)
  const vat = vatRegistered ? round2(gross * VAT_RATE) : 0

  // Creditable WHT is withheld by the client on the GROSS commission
  // (excluding VAT). 5% for VAT-registered brokers, 10% otherwise.
  const whtRate = vatRegistered ? WHT_RATE_VAT : WHT_RATE_NON_VAT
  const wht = whtApplies ? round2(gross * whtRate) : 0

  // Net received = (gross + VAT) − WHT. Broker remits VAT separately
  // and uses WHT receipts as creditable income tax payments.
  const netReceived = round2(gross + vat - wht)

  const breakdown: Breakdown = [
    { label: 'Gross commission', amount: gross },
  ]
  if (vatRegistered) {
    breakdown.push({ label: `VAT (output) @ ${(VAT_RATE * 100).toFixed(0)}%`, amount: vat })
    breakdown.push({ label: 'Total billed to client', amount: round2(gross + vat) })
  }
  if (whtApplies) {
    breakdown.push({
      label: `Creditable WHT @ ${(whtRate * 100).toFixed(0)}%${vatRegistered ? ' (VAT-registered)' : ' (non-VAT)'}`,
      amount: -wht,
    })
  }
  breakdown.push({ label: 'Net received by broker', amount: netReceived })

  return { gross, vat, wht, net_received: netReceived, breakdown }
}

// ---------------------------------------------------------------------
// All-in transaction estimate (DST + CGT + transfer tax + commission)
// ---------------------------------------------------------------------

export type AllInInput = {
  selling_price: number
  zonal_or_fair_value?: number
  /** Commission as a fraction of selling price. e.g. 0.05 for 5%. */
  commission_rate?: number
  /** Override the default LGU transfer tax rate. */
  transfer_rate?: number
  /** Override the default DST rate. */
  dst_rate?: number
  /** Override the default CGT rate. */
  cgt_rate?: number
}

export function allInTransactionEstimate(input: AllInInput): {
  selling_price: number
  total_taxes: number
  commission: number
  net_to_seller: number
  breakdown: Breakdown
} {
  const dstResult = dst({
    selling_price: input.selling_price,
    zonal_or_fair_value: input.zonal_or_fair_value,
    rate: input.dst_rate,
  })
  const cgtResult = cgt({
    selling_price: input.selling_price,
    zonal_or_fair_value: input.zonal_or_fair_value,
    rate: input.cgt_rate,
  })
  const ttResult = transferTax({
    selling_price: input.selling_price,
    rate: input.transfer_rate,
  })
  const commission = round2(input.selling_price * (input.commission_rate ?? 0.05))
  const totalTaxes = round2(dstResult.tax + cgtResult.tax + ttResult.tax)
  // Convention: in PH, the SELLER typically shoulders CGT + half-DST
  // but practice varies wildly. This estimate sums everything for a
  // gross "all-in transaction cost" view; operators decide who pays
  // what in their listing agreement.
  const netToSeller = round2(input.selling_price - totalTaxes - commission)

  return {
    selling_price: round2(input.selling_price),
    total_taxes: totalTaxes,
    commission,
    net_to_seller: netToSeller,
    breakdown: [
      { label: 'Selling price', amount: round2(input.selling_price) },
      { label: 'DST', amount: dstResult.tax },
      { label: 'CGT', amount: cgtResult.tax },
      { label: 'Transfer tax (LGU)', amount: ttResult.tax },
      { label: 'Total taxes', amount: totalTaxes },
      { label: `Commission @ ${((input.commission_rate ?? 0.05) * 100).toFixed(2)}%`, amount: commission },
      { label: 'Net to seller (gross of any holdbacks)', amount: netToSeller },
    ],
  }
}
