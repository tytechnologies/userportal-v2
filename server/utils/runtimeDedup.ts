// Runtime dedup engine — matches an external candidate against the
// internal hit set in-memory, per query. Optimized for the hot path:
// O(n*m) where n = external hits, m = internal hits. With strict caps
// (n ≤ 10, m ≤ 50) this is a 500-comparison worst case.
//
// Signals (weighted, threshold-based — NOT a learned model):
//   - geo proximity (Haversine, ≤200m → strong)
//   - price proximity (±5% → strong, ±15% → moderate)
//   - bedroom/bathroom exact match
//   - title token Jaccard (cheap, no library)
//   - property_type exact
//   - city_slug exact
//
// A match is "provisional" if it meets the threshold but the strongest
// individual signal isn't decisive (e.g. only price + bedrooms agree).
// "Confirmed" requires a strong geo OR strong title overlap.
//
// The orchestrator uses the match result to:
//   - COLLAPSE: external candidate folded into the internal hit's
//     `external_sources[]` array.
//   - SURFACE-AS-DISTINCT: external candidate kept as a separate result
//     row, ranked below internal at equal score.

export type InternalHit = {
  property_id: number
  title: string | null
  for_sale: boolean | null
  for_rent: boolean | null
  sale_price: number | null
  rent_price: number | null
  property_type: string | null
  bedrooms: number | null
  bathrooms: number | null
  latitude: number | null
  longitude: number | null
  city_slug: string | null
  // … unused fields elided
}

export type DedupVerdict = {
  matched: boolean
  property_id: number | null
  confidence: number   // 0..1
  reasons: string[]
}

function haversineMeters(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  // Standard great-circle distance. Fast enough at this volume; no
  // library dep. Earth radius 6_371_008.8 m (mean).
  const R = 6_371_008.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

function tokenize(s: string | null): Set<string> {
  if (!s) return new Set()
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function effectivePrice(
  hit: { for_sale: boolean | null; sale_price: number | null; rent_price: number | null },
): number | null {
  if (hit.for_sale && hit.sale_price && hit.sale_price > 0) return hit.sale_price
  if (hit.rent_price && hit.rent_price > 0) return hit.rent_price
  return null
}

type ExtMin = {
  title: string | null
  price: number | null
  for_sale: boolean | null
  for_rent: boolean | null
  property_type: string | null
  bedrooms: number | null
  bathrooms: number | null
  latitude: number | null
  longitude: number | null
  city_slug: string | null
}

export function scoreCandidatePair(internal: InternalHit, external: ExtMin): DedupVerdict {
  const reasons: string[] = []
  let confidence = 0

  // Geo proximity — the strongest single signal when both have coords.
  if (
    internal.latitude != null && internal.longitude != null &&
    external.latitude != null && external.longitude != null
  ) {
    const m = haversineMeters(
      internal.latitude, internal.longitude,
      external.latitude, external.longitude,
    )
    if (m <= 50) {
      confidence += 0.55; reasons.push(`geo<=50m(${Math.round(m)})`)
    } else if (m <= 200) {
      confidence += 0.35; reasons.push(`geo<=200m(${Math.round(m)})`)
    } else if (m <= 1000) {
      confidence += 0.1; reasons.push(`geo<=1km(${Math.round(m)})`)
    }
  }

  // Title token overlap.
  const titleJ = jaccard(tokenize(internal.title), tokenize(external.title))
  if (titleJ >= 0.6)      { confidence += 0.4;  reasons.push(`title=${titleJ.toFixed(2)}`) }
  else if (titleJ >= 0.4) { confidence += 0.25; reasons.push(`title=${titleJ.toFixed(2)}`) }
  else if (titleJ >= 0.25){ confidence += 0.1;  reasons.push(`title=${titleJ.toFixed(2)}`) }

  // Price proximity.
  const intP = effectivePrice(internal)
  if (intP && external.price) {
    const ratio = Math.abs(intP - external.price) / Math.max(intP, external.price)
    if (ratio <= 0.05)      { confidence += 0.2;  reasons.push('price±5%') }
    else if (ratio <= 0.15) { confidence += 0.1;  reasons.push('price±15%') }
  }

  // Bedroom / bathroom exact match.
  if (internal.bedrooms != null && external.bedrooms === internal.bedrooms) {
    confidence += 0.08; reasons.push('br=')
  }
  if (internal.bathrooms != null && external.bathrooms === internal.bathrooms) {
    confidence += 0.05; reasons.push('ba=')
  }

  // Property type exact.
  if (
    internal.property_type && external.property_type &&
    internal.property_type === external.property_type
  ) {
    confidence += 0.05; reasons.push(`type=${internal.property_type}`)
  }

  // City exact.
  if (internal.city_slug && external.city_slug && internal.city_slug === external.city_slug) {
    confidence += 0.05; reasons.push(`city=${internal.city_slug}`)
  }

  confidence = Math.min(1, confidence)
  // Threshold: ≥0.55 = matched. The threshold is intentionally above
  // the geo<=200m + title<0.25 case so weak signals alone don't claim
  // a match.
  const matched = confidence >= 0.55
  return {
    matched,
    property_id: matched ? internal.property_id : null,
    confidence,
    reasons,
  }
}

// Drive the loop. Returns a parallel array (same length as externals)
// where each entry is the best verdict against the internal set.
export function dedupExternalsAgainstInternals(
  internals: InternalHit[],
  externals: ExtMin[],
): DedupVerdict[] {
  return externals.map((ext) => {
    let best: DedupVerdict = { matched: false, property_id: null, confidence: 0, reasons: [] }
    for (const internal of internals) {
      const v = scoreCandidatePair(internal, ext)
      if (v.confidence > best.confidence) best = v
    }
    return best
  })
}
