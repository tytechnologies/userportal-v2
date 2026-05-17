// Hybrid ranking — combines the relevance score the internal engine
// returned (Typesense relevance or a synthesized PG-FTS rank) with
// signals that distinguish internal authoritative listings from
// external candidates.
//
// Design constraint from the architecture spec:
//   "Internal listings receive strongest ranking boost."
//   "External listings must NOT dominate internal inventory."
//
// We enforce this via a hard "internal always > external at equal
// natural score" tier in the comparator AND a multiplicative source
// trust factor that maxes out below internal_authoritative=true.

export type RankableInternal = {
  kind: 'internal'
  property_id: number
  internal_authoritative: boolean
  /** Natural relevance from the engine (Typesense text_match or PG ts_rank). */
  base_score: number
  freshness_days: number | null    // days since updated_at; null = unknown
  completeness: number              // 0..1 (photo+coords+prices+specs filled)
  engagement_score: number          // 0..1; cached aggregate (views/saves)
  external_sources: number          // count of external candidates that
                                    // dedup-collapsed into this property
  // Pass-through display payload — opaque to the ranker.
  payload: Record<string, unknown>
}

export type RankableExternal = {
  kind: 'external'
  candidate_id: string
  provider_slug: string
  provider_trust: number            // 0..100 from source_connectors
  base_score: number                // synthesized from query relevance
  parse_confidence: number          // 0..1 from adapter
  freshness_days: number | null
  /** Best dedup match against the internal set. null = distinct. */
  dedup_match: {
    property_id: number
    confidence: number
  } | null
  payload: Record<string, unknown>
}

export type Rankable = RankableInternal | RankableExternal

export type RankedResult = Rankable & { final_score: number }

// Tunable knobs. Kept module-level so ops can adjust via a config push
// (no DB column needed for v1).
const WEIGHTS = {
  internal_authoritative_boost: 1.5,    // multiplicative, applied last
  freshness_decay_days: 30,             // half-life-ish; >60d gets 0
  completeness_weight: 0.25,
  engagement_weight: 0.15,
  external_sources_bonus: 0.05,         // per cross-source corroboration
  external_provider_trust_weight: 0.5,  // scale external provider_trust into [0..0.5]
  parse_confidence_weight: 0.3,         // external only
} as const

function freshnessFactor(days: number | null): number {
  if (days == null) return 0.5
  if (days <= 0) return 1
  if (days >= 60) return 0
  return Math.max(0, 1 - days / WEIGHTS.freshness_decay_days)
}

function scoreInternal(r: RankableInternal): number {
  // Base: engine relevance, normalized into ~[0..1].
  let s = Math.tanh(r.base_score) // smooth into a bounded range
  s += freshnessFactor(r.freshness_days) * 0.15
  s += r.completeness * WEIGHTS.completeness_weight
  s += r.engagement_score * WEIGHTS.engagement_weight
  s += Math.min(0.2, r.external_sources * WEIGHTS.external_sources_bonus)
  if (r.internal_authoritative) s *= WEIGHTS.internal_authoritative_boost
  return s
}

function scoreExternal(r: RankableExternal): number {
  // External candidates start with a cap so they never outscore a
  // typical internal hit at the same base relevance.
  let s = Math.tanh(r.base_score) * 0.85
  s += freshnessFactor(r.freshness_days) * 0.1
  s += (r.provider_trust / 100) * WEIGHTS.external_provider_trust_weight
  s += r.parse_confidence * WEIGHTS.parse_confidence_weight
  // If the candidate dedup-matched an internal property strongly, it
  // doesn't surface as a separate row — that decision is made by the
  // orchestrator BEFORE ranking. But if a low-confidence match still
  // reaches the ranker, lightly down-rank to reduce visible noise.
  if (r.dedup_match && r.dedup_match.confidence >= 0.4) {
    s *= 0.9
  }
  return s
}

export function rankFinal(items: Rankable[]): RankedResult[] {
  const scored: RankedResult[] = items.map((it) => ({
    ...it,
    final_score: it.kind === 'internal' ? scoreInternal(it) : scoreExternal(it),
  }))
  // Hard tier: internal always above external when their natural scores
  // are within ~10% of each other. Prevents a single strong-relevance
  // external from leaping past a slightly weaker internal hit.
  scored.sort((a, b) => {
    if (a.kind !== b.kind) {
      const diff = Math.abs(a.final_score - b.final_score)
      const minScore = Math.min(a.final_score, b.final_score)
      const within10pct = minScore > 0 && diff / minScore < 0.1
      if (within10pct) return a.kind === 'internal' ? -1 : 1
    }
    return b.final_score - a.final_score
  })
  return scored
}
