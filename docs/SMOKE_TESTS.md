# Smoke Tests — Discovery + Intelligence Layer

Pasteable SQL for the Supabase SQL editor. Each block validates one piece of
the stack shipped in migrations 26–30. All read-only.

If any block returns no rows or an error, the corresponding contract is
broken — file an issue and link to the failing block.

---

## 1. Schema governance — drift across all registered contracts

```sql
SELECT contract_name, status, critical_count, warning_count
  FROM public.governance_check_all_contracts()
 ORDER BY status, contract_name;
```

Expected: every row `status = 'healthy'`, both counts `0`.
A `missing` status means the contract is registered but the underlying
table/view doesn't exist. A `drift` status means columns mismatch.

---

## 2. Discovery view — non-empty + scores populated

```sql
SELECT
  count(*)                                                        AS total_listings,
  count(*) FILTER (WHERE recommended_score IS NOT NULL)           AS with_recommended,
  count(*) FILTER (WHERE quality_score >= 50)                     AS quality_ge_50,
  round(avg(recommended_score)::numeric, 2)                       AS avg_recommended,
  round(min(recommended_score)::numeric, 2)                       AS min_recommended,
  round(max(recommended_score)::numeric, 2)                       AS max_recommended
FROM public.listing_discovery_score;
```

Expected: `total_listings` > 0; `with_recommended` = total; `min` / `max`
spread across a real range (not all the same number).

---

## 3. Quality score distribution

```sql
SELECT
  count(*)                                              AS total,
  count(*) FILTER (WHERE total_score >= 85)             AS excellent,
  count(*) FILTER (WHERE total_score BETWEEN 70 AND 84) AS good,
  count(*) FILTER (WHERE total_score BETWEEN 50 AND 69) AS fair,
  count(*) FILTER (WHERE total_score < 50)              AS needs_work,
  round(avg(total_score)::numeric, 2)                   AS avg_score
FROM public.listing_quality;
```

Expected: distribution roughly bell-curve-shaped. If everything is in one
bucket, weights need tuning.

---

## 4. Similar listings RPC — exercise against a real listing

```sql
WITH source AS (
  SELECT id::bigint AS id
    FROM public.listings
   WHERE is_online = true AND deleted_at IS NULL
   ORDER BY created_at DESC
   LIMIT 1
)
SELECT
  s.listing_id,
  s.similarity_score,
  s.match_reasons
FROM source, public.similar_listings(source.id, 5) s;
```

Expected: 0–5 rows. `similarity_score` between 5 and 100. `match_reasons`
populated (e.g., `{same_city, similar_price}`).

---

## 5. Ranking explanation RPC — admin debug

```sql
SELECT public.listing_ranking_explanation(
  (SELECT id::bigint FROM public.listings
    WHERE is_online = true AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1)
);
```

Expected: a JSONB object with three top-level keys:
`discovery_signals` (per-component score), `quality_breakdown` (image/desc/etc),
`sort_modes` (per-mode score for every active mode).

---

## 6. Pipeline alerts + recommendations — exist after mig 30

```sql
-- Should return 6 columns, 0+ rows.
SELECT count(*) AS active_alerts FROM public.pipeline_alerts;

-- Should return 6 columns, 0+ rows.
SELECT count(*) AS active_recs FROM public.pipeline_recommendations;
```

If either errors with `relation does not exist`, mig 30 didn't apply.

---

## 7. Discovery freshness — MV refresh tracking

```sql
SELECT
  quality_last_refresh,
  trends_last_refresh,
  quality_consecutive_failures,
  healthy,
  discovery_row_count
FROM public.discovery_health;
```

Expected: `healthy = true` once both MVs have run their refresh crons
(quality cron at `:15` hourly, trends at `02:00` nightly). On first install,
both are populated immediately by the `CREATE MATERIALIZED VIEW` itself, but
`last_refresh_completed_at` stays NULL until the first cron-driven refresh.

---

## 8. Sort modes registry — anon-readable

```sql
SELECT mode_key, display_name, score_column, is_default
  FROM public.search_sort_modes
 WHERE enabled = true
 ORDER BY is_default DESC, mode_key;
```

Expected: 7 rows, exactly one with `is_default = true` (`recommended`).

---

## 9. Market intelligence — segment medians

```sql
SELECT
  city_id,
  property_type,
  listing_count,
  median_price,
  median_price_per_sqm
FROM public.market_inventory_summary
ORDER BY listing_count DESC
LIMIT 10;
```

Expected: rows for the top-10 segments by listing count. `median_price` and
`median_price_per_sqm` populated for sale segments.

---

## 10. Saved-search alert types — column exists

```sql
SELECT alert_types, count(*)
  FROM public.saved_search_subscriptions
 GROUP BY alert_types;
```

Expected: most rows have `{match}` (the default). Errors mean mig 29's
`alert_types` column wasn't applied.

---

## How to run

1. Open the Supabase SQL editor for the project.
2. Paste any block.
3. Compare the output to the "Expected" line.

If a block returns unexpected output, the corresponding piece of infrastructure
is broken — start with the contract registry (block 1) to narrow it down.
