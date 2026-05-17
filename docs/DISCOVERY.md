# Discovery + Ranking — Operator Guide

How the platform's intelligent discovery layer works. Every signal is
deterministic and auditable — no ML, no opaque embeddings.

---

## The data flow

```
listings (table)
  ↓
listing_quality (view, backed by mv_listing_quality_score)   ← refreshed hourly
  ↓
listing_ranking_signals (view)                               ← reads market_ranking_config weights
  ↓
listing_discovery_score (view, computed at read)
  ↓
/api/listings/discover                                       ← endpoint
```

`listing_discovery_score` has one row per active listing and one column per
sort mode (`recommended_score`, `quality_score_sort`, `trusted_score`,
`fastest_moving_score`, `undervalued_score`, `luxury_score`, `newest_score`).

---

## Quality score components

Per-listing 0–100 score, computed by `mv_listing_quality_score`. Components
sum to 100; each capped at its maximum.

| Component | Max | Source |
|---|---|---|
| Images | 20 | `min(image_count, 8) × 2.5` |
| Description | 15 | length-banded: <100 chars = 0, <300 = 5, <300 = 10, ≥300 = 15 |
| Verification | 15 | 15 if `listing_verifications.status = 'verified'`, else 0 |
| Freshness | 10 | `10 × exp(-days / (30 × 1.4427))` — half-life 30d |
| Inquiry responsiveness | 15 | `response_rate_30d × 15`. NULL (no inquiries) → neutral 7.5 |
| Broker trust | 10 | `trust_score / 10` from polymorphic `trust_score` view |
| Price vs. zonal | 10 | `at_market` = 10, `above_market`/`below_market` = 7, else 5 |
| Geographic completeness | 5 | barangay + building = 5, barangay only = 3, city only = 1, none = 0 |

Refresh cadence: hourly at `:15` via `refresh_mv_listing_quality_score()`.

---

## Sort modes (the ranking formulas)

Each is a deterministic function of `listing_ranking_signals` columns:

### `recommended` (default)

```
recommended_score = quality_score
                  × verification_boost     (1.0 default, 1.15 if verified)
                  × broker_trust_boost     (1.0 floor, scales to 1.20 max)
                  × velocity_penalty       (1.0 default, 0.9 if DOM > segment p75)
                  × freshness_score        (exp time decay, half-life 30d)
```

Balanced product. NULL components default to neutral so brand-new listings
appear at neutral position rather than being invisible.

### `highest_quality`

Direct `listing_quality.total_score`. No multipliers.

### `trusted`

```
trusted_score = (broker_trust_boost × 100) + (quality_score / 10)
```

Broker trust dominates; quality is the tie-breaker.

### `fastest_moving`

```
fastest_moving_score = absorption_rate_30d × quality_score
```

Surfaces listings in segments with the highest 30-day absorption.

### `undervalued`

```
undervalued_score = -zonal_premium_ratio × quality_score
```

Negative `zonal_premium_ratio` (i.e., listing priced *below* zonal) becomes
positive after the negation — so undervalued listings rise. Quality acts
as a multiplier so we don't surface low-quality bargains.

### `luxury_priority`

```
luxury_score = pps_pct × verification_boost × broker_trust_boost × 100
```

`pps_pct` is the listing's per-segment price-per-sqm percentile rank (0–1).
Weighted by verification + trust so we surface verified luxury, not
overpriced amateur listings.

### `newest`

`listings.created_at` epoch as a numeric. Pure recency. Deterministic
fallback when none of the intelligent signals matter.

---

## Tunable weights

Weights live in the `market_ranking_config` table (one row, JSONB).
Admins can `UPDATE public.market_ranking_config SET weights = ...` to
retune without a migration.

Default values:

```json
{
  "verification_verified": 1.15,
  "verification_default":  1.00,
  "broker_trust_max":      1.20,
  "broker_trust_floor":    1.00,
  "stale_dom_p75_penalty": 0.90,
  "freshness_half_life_days": 30
}
```

---

## Similar listings

`similar_listings(p_listing_id bigint, p_limit int)` RPC. Weighted match
score by candidate (additive):

| Signal | Weight |
|---|---|
| Same building | +50 |
| Same city | +10 |
| Same property type | +10 |
| Same segment + bedrooms ±1 | +15 |
| Price within ±20% | +10 |
| Same broker (created_by) | +5 |
| Quality score within 15 points | +5 |

Candidates are restricted to the same city by default (cross-city
"similar" rarely makes sense for property search). Returns top-N sorted
by similarity score, with a `match_reasons` text array per row so the UI
can render exactly why each candidate surfaced.

---

## Sparse-data invariants

| Scenario | Behavior |
|---|---|
| New listing (no quality MV row yet) | `coalesce(quality_score, 50)` — neutral position |
| No segment data (single listing in city × type) | `pps_pct` = NULL → 0 score for `luxury_priority` only; other modes unaffected |
| No zonal match | `zonal_premium_ratio` = NULL → `undervalued_score` = 0 (won't surface) |
| No broker trust | `broker_trust_boost` = floor (1.0) |
| No inquiries | `responsiveness` component = neutral 7.5 |
| No verifications | `verification_boost` = 1.0 |

In every case: the score is computable, deterministic, and explainable.

---

## Explainability

`listing_ranking_explanation(p_listing_id)` is admin-only. Returns:

```json
{
  "listing_id": 123,
  "discovery_signals": { /* every column from listing_discovery_score */ },
  "quality_breakdown": { /* every score_* component from listing_quality */ },
  "sort_modes": [
    { "mode_key": "recommended", "display_name": "...", "formula": "...", "score": 67.4 },
    ...
  ]
}
```

Endpoint: `GET /api/listings/:id/ranking-explanation` (admin auth required).

---

## Refresh expectations

| Surface | Cadence | Cron job name |
|---|---|---|
| `mv_listing_quality_score` | hourly at `:15` | `mv_listing_quality_score_refresh` |
| `mv_market_monthly_trends` | daily at 02:00 | `mv_market_monthly_trends_refresh` |
| `governance_drift_log` prune | daily at 03:35 | `governance_drift_log_prune` |

All three integrated with `governance_record_mv_refresh_*` so
`governance_materialized_views.last_refresh_completed_at` stays current.
The `discovery_health` view aggregates this for the ops dashboard.

---

## Operator playbook

**"Why isn't my new listing showing up under Recommended?"**

It is — at neutral. New listings get `quality_score = 50` until the next
hourly MV refresh. Encourage the broker to add images, complete the
description, and request verification — those fill in the actual quality
components within the hour.

**"This listing's score seems wrong."**

Hit `/api/listings/:id/ranking-explanation` (admin only) to see the
component-by-component breakdown. The `quality_breakdown` shows which
components are weak; the `sort_modes` array shows the per-mode score.

**"We need to retune the ranking."**

`UPDATE public.market_ranking_config SET weights = ...`. Changes take
effect on the next read of `listing_discovery_score` (it's a live view,
not a MV). No migration, no deploy.

**"Discovery scores look stale."**

Check `discovery_health.healthy`. If false, look at `quality_last_error` /
`trends_last_error` for the underlying refresh failure. The
`/admin/operations` "Schema governance" panel surfaces this automatically.
