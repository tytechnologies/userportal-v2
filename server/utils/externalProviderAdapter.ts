// External provider adapter — converts raw Tavily (and future provider)
// payloads into the normalized `ExternalCandidate` shape that the hybrid
// orchestrator merges with internal results.
//
// Adapter contract:
//   1. NEVER trust upstream — every field validated/coerced.
//   2. NEVER expose raw_content fields to the user (PII/scraper bait).
//   3. Reject hits with too few signals to rank meaningfully.
//   4. parse_confidence is a 0..1 self-assessment — the orchestrator
//      uses it to demote low-confidence hits below internal results.
//
// New adapters: add a function with the same signature and register it
// in `adapterFor()`.

import type { TavilySearchResult } from './tavily'

export type ExternalCandidate = {
  // Provenance
  provider_slug: string
  source_url: string
  source_domain: string
  // Normalized listing fields (null = couldn't parse)
  title: string | null
  price: number | null
  currency: string
  for_sale: boolean | null
  for_rent: boolean | null
  property_type: string | null
  bedrooms: number | null
  bathrooms: number | null
  floor_area: number | null
  lot_area: number | null
  address: string | null
  city_slug: string | null
  barangay_slug: string | null
  latitude: number | null
  longitude: number | null
  thumbnail_url: string | null
  description: string | null
  // Adapter's self-assessment of parse quality (0..1).
  parse_confidence: number
  // Raw payload (kept server-side for forensics; never surfaced to anon).
  raw_payload: Record<string, unknown>
}

// --- field extractors -----------------------------------------------

const PRICE_RE = /(?:₱|php|p)\s*([\d,]+(?:\.\d+)?)\s*(m|million|k|thousand|b|billion)?/i
const PRICE_RANGE_RE = /([\d,]+(?:\.\d+)?)\s*-\s*([\d,]+(?:\.\d+)?)/
const BEDROOM_RE = /(\d+)\s*(?:bed(?:room)?s?|br\b|bedrooms?)/i
const BATHROOM_RE = /(\d+)\s*(?:bath(?:room)?s?|ba\b)/i
const AREA_RE = /(\d+(?:\.\d+)?)\s*(?:sqm|m²|sq\.?\s*m|square\s+meter)/i

function extractPrice(text: string): number | null {
  const range = PRICE_RANGE_RE.exec(text)
  if (range) {
    // Use the lower bound — listings are typically priced "starting at".
    const n = Number(range[1].replace(/,/g, ''))
    if (Number.isFinite(n) && n > 0) return n
  }
  const m = PRICE_RE.exec(text)
  if (!m) return null
  let n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  const mult = (m[2] || '').toLowerCase()
  if (mult === 'm' || mult === 'million') n *= 1_000_000
  else if (mult === 'b' || mult === 'billion') n *= 1_000_000_000
  else if (mult === 'k' || mult === 'thousand') n *= 1_000
  // PH listings under ₱10,000 are almost certainly junk — skip.
  return n >= 10_000 ? n : null
}

function extractInt(text: string, re: RegExp): number | null {
  const m = re.exec(text)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : null
}

function extractFloat(text: string, re: RegExp): number | null {
  const m = re.exec(text)
  if (!m) return null
  const n = parseFloat(m[1])
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : null
}

function detectTransactionType(text: string): {
  for_sale: boolean | null
  for_rent: boolean | null
} {
  const t = text.toLowerCase()
  const sale = /(for\s*sale|buy|preselling|rfo|ready\s+for\s+occupanc)/i.test(t)
  const rent = /(for\s*rent|rent(al)?|lease|monthly)/i.test(t)
  if (sale && !rent) return { for_sale: true, for_rent: false }
  if (rent && !sale) return { for_sale: false, for_rent: true }
  if (sale && rent) return { for_sale: true, for_rent: true }
  return { for_sale: null, for_rent: null }
}

// Minimal property-type recognizer. Maps the most common PH-market
// strings onto canonical slugs that the platform already uses.
function detectPropertyType(text: string): string | null {
  const t = text.toLowerCase()
  if (/condo(minium)?\b/.test(t))     return 'condo'
  if (/townhouse|town\s*home/.test(t)) return 'townhouse'
  if (/(house\s+and\s+lot|h\s*&\s*l|single\s+family|detached)/.test(t)) return 'house'
  if (/\boffice\b|commercial\s+space/.test(t)) return 'office'
  if (/\blot\b|parcel/.test(t))       return 'lot'
  if (/warehouse|industrial/.test(t)) return 'warehouse'
  if (/\bapartment\b|studio/.test(t)) return 'apartment'
  return null
}

// City slug detector — only fires for cities we know the site indexes.
// (Defensive: returning a slug we don't have a city_id for would create
// dead filter chips. The adapter stays conservative.)
const PH_CITY_SLUGS = [
  'makati','taguig','bgc','quezon-city','manila','pasig','mandaluyong',
  'pasay','paranaque','las-pinas','muntinlupa','marikina','san-juan',
  'cebu-city','mandaue','davao','baguio','tagaytay','antipolo',
]
function detectCitySlug(text: string): string | null {
  const t = text.toLowerCase()
  for (const slug of PH_CITY_SLUGS) {
    const pat = slug.replace(/-/g, '[-\\s]?')
    if (new RegExp(`\\b${pat}\\b`).test(t)) return slug
  }
  return null
}

function safeUrl(u: string): { url: string; domain: string } | null {
  try {
    const parsed = new URL(u)
    if (!/^https?:$/.test(parsed.protocol)) return null
    return { url: parsed.toString(), domain: parsed.hostname.toLowerCase() }
  } catch {
    return null
  }
}

// --- adapters -------------------------------------------------------

export function adaptTavilyResult(
  raw: TavilySearchResult,
  providerSlug: string,
  /**
   * Optional pre-resolved thumbnail URL — typically the i-th entry
   * from Tavily's top-level `images` array (when the caller passed
   * `include_images: true`). Tavily returns images by query
   * relevance, not per-result, so the association is best-effort.
   * If unset, the card falls back to the placeholder.
   */
  thumbnailUrl?: string | null,
): ExternalCandidate | null {
  const url = safeUrl(raw?.url || '')
  if (!url) return null

  const title = (raw.title || '').trim().slice(0, 240) || null
  const blob = `${raw.title || ''} ${raw.content || ''}`

  const price = extractPrice(blob)
  const bedrooms = extractInt(blob, BEDROOM_RE)
  const bathrooms = extractInt(blob, BATHROOM_RE)
  const floor_area = extractFloat(blob, AREA_RE)
  const txn = detectTransactionType(blob)
  const property_type = detectPropertyType(blob)
  const city_slug = detectCitySlug(blob)

  // parse_confidence — start at 0.3 for a bare title+URL hit. Each
  // recognized field nudges it up. Cap at 0.85 (we never claim parity
  // with internal data).
  let conf = 0.3
  if (price != null) conf += 0.18
  if (bedrooms != null) conf += 0.08
  if (bathrooms != null) conf += 0.05
  if (floor_area != null) conf += 0.05
  if (property_type) conf += 0.06
  if (city_slug) conf += 0.08
  if (txn.for_sale || txn.for_rent) conf += 0.05
  conf = Math.min(0.85, Math.max(0, conf))

  // Reject hits with neither title nor price — those are unrankable.
  if (!title && price == null) return null

  return {
    provider_slug: providerSlug,
    source_url: url.url,
    source_domain: url.domain,
    title,
    price,
    currency: 'PHP',
    for_sale: txn.for_sale,
    for_rent: txn.for_rent,
    property_type,
    bedrooms,
    bathrooms,
    floor_area,
    lot_area: null,
    address: null,
    city_slug,
    barangay_slug: null,
    latitude: null,
    longitude: null,
    thumbnail_url: thumbnailUrl && /^https?:/.test(thumbnailUrl)
      ? thumbnailUrl
      : null,
    description: (raw.content || '').slice(0, 600) || null,
    parse_confidence: conf,
    raw_payload: {
      score: raw.score ?? null,
      published_date: raw.published_date ?? null,
    },
  }
}
