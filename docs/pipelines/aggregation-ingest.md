# Aggregation ingest pipeline (B-1 → B-5)

The multi-phase rebuild that turned the portal into a property aggregation platform. Canonical entity is `public.properties` (INT PK, from `db-main-reference`). Multiple `listings` rows per property is native. Raw partner payloads land in `listings_raw`, get normalized into `listings_normalized`, and eventually drain into `listings`.

## Components

### Migrations (in apply order)
- `20260510000001` — B-1: `properties.primary_listing_id`, `internal_authoritative`. RPCs `elect_primary_listing_id()`, `merge_listings_into_property()`.
- `20260510000002` — B-2: dedup signals — adds GPS proximity pair-source pass to `find_listing_duplicate_candidates`.
- `20260510000003` — B-2: address-trigram pair-source pass (`properties_street_address_trgm_idx` GIN).
- `20260510000004` — B-2: `archive_stale_source_listings()` body replace — promote-before-archive.
- `20260510000005` — B-3: `listings_raw` + `listings_normalized` + `normalize_listings_raw_batch()`.
- `20260510000006` — B-4: `search_index_queue` + `source_health`. Triggers on properties + listings.
- `20260513000003` — `source_health` recorder.
- `20260513000005` — B-3.1: `apply_normalized_batch()` worker (normalized → listings drain).
- `20260513000006` — `listing_sources.vault_secret_id` for partner ingest secrets.

### Tables
| Table | Purpose |
|---|---|
| `properties` | Canonical entity (INT PK) |
| `listings` | Variant rows — `listings.property_id` is the variant link |
| `listings_raw` | Verbatim partner payloads, idempotent on `(source_id, foreign_id, raw_hash)` |
| `listings_normalized` | Resolved FKs + `match_status` state machine |
| `search_index_queue` | Coalesced upsert/delete ops for the search engine |
| `source_health` | SLO state machine for each ingest source |
| `listing_sources` | Partner registry + vault secret refs |
| `listing_duplicate_candidates` | Dedup detector queue |

### Key RPCs
- `elect_primary_listing_id(p_property_id INT)` — STABLE. Pick the live listing to surface.
- `merge_listings_into_property(p_source_listing_id, p_target_property_id, p_set_primary_to, p_pair_id)` — admin reparent.
- `find_listing_duplicate_candidates(p_only_recent BOOL, p_max INT)` — 3-pass dup detector. Cron-driven.
- `archive_stale_source_listings()` — daily archival sweep + promote-before-archive.
- `normalize_listings_raw_batch(p_max INT)` — drain `listings_raw` → `listings_normalized`.
- `apply_normalized_batch(p_max INT)` — drain `listings_normalized` → `listings`.

### Endpoints (portal)
- `POST /api/admin/listings/ingest` — partner ingest. **Dual-writes** to `listings_raw` AND `listings`. Failure of raw capture does NOT fail the ingest.
- `POST /api/internal/normalize-raw-batch` — cron-driven normalize worker.
- `POST /api/internal/apply-normalized-batch` — cron-driven normalized→listings drain.
- `GET /api/admin/raw-ingest` — raw + normalized queue rollups.

### Admin pages
- `/admin/duplicates` — review queue (3 verdict actions: distinct / merge / reparent).
- `/admin/properties/[id]` — variant table + primary pin + internal-authoritative toggle.
- `/admin/raw-ingest` — B-3 staging visibility.

### Env vars / config
- `INTERNAL_CRON_SECRET` — same secret used by the cron drains.
- `internal_config.portal_base_url` + `digest_cron_secret` — set once so pg_cron can hit the workers.

## Operate

### First-time setup

1. Apply all migrations 510000001 → 510000006 in order, then 513000003 → 513000006.
2. Set `INTERNAL_CRON_SECRET` on portal env.
3. Configure `internal_config`:
   ```sql
   UPDATE public.internal_config
      SET portal_base_url    = '<your portal URL>',
          digest_cron_secret = '<INTERNAL_CRON_SECRET value>'
    WHERE id = 1;
   ```
4. Cron schedules from `20260514000004_pg_cron_internal_workers.sql` activate the workers (5min / 2min).

### Onboard a new partner source

1. Insert a `listing_sources` row with `ingest_secret_vault_ref` pointing at a Supabase Vault secret.
2. Partner POSTs to `/api/admin/listings/ingest` with the secret in the header. The endpoint dual-writes raw + listings.
3. Watch `/admin/raw-ingest` for queue depth + per-source rollup.

### Resolve a duplicate

1. Detector cron fires `find_listing_duplicate_candidates()` periodically.
2. Pairs land in `listing_duplicate_candidates` with confidence + signals.
3. Review at `/admin/duplicates`. Choose:
   - **Distinct** — false positive; closes the candidate.
   - **Merge as same** — closes the candidate; downstream merge into one property via `merge_listings_into_property`.
   - **Reparent variant** — moves the source listing's `property_id`.

## Smoke

```sql
-- 1. Raw → normalized pipeline alive?
SELECT (SELECT count(*) FROM listings_raw)        AS raw_total,
       (SELECT count(*) FROM listings_normalized) AS norm_total,
       (SELECT count(*) FROM listings_normalized
         WHERE match_status='matched_existing_listing') AS matched;

-- 2. Detector run + counts?
SELECT * FROM public.find_listing_duplicate_candidates(true, 100);

-- 3. Cron drain jobs scheduled?
SELECT jobname, schedule, active FROM cron.job
 WHERE jobname IN (
   'normalize_raw_batch_5m',
   'index_search_queue_2m'
 );

-- 4. Recent cron runs (last 10)
SELECT jobname, status, return_message, start_time
  FROM cron.job_run_details
 ORDER BY start_time DESC LIMIT 10;
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Ingest 401 | wrong source secret | Re-rotate via `rotate_listing_source_secret(p_id)` RPC |
| Normalize batch returns 0 rows | All caught up OR raw table empty | OK; check `listings_raw` first |
| Apply-normalized worker fails on FK | property/source FK violation | Look at `listings_normalized.last_error`; usually `created_by` orphan or stale building_id |
| Duplicates table growing unbounded | Detector cron running but operators not reviewing | Stale by design until reviewed. Bulk-mark "distinct" if needed |
| Dedup confidence too low / too high | Signal weights drifted from data shape | Adjust within `find_listing_duplicate_candidates` (the body has the weights inline) |

## Open work

- **Image fingerprinting** for dedup (optional per spec, deferred).
- **Source health rollup wiring** — `source_health` table exists but only the recorder RPC populates it; needs ingest endpoint calling it on each request.
- **Apply-normalized worker cutover** — currently dual-write; the listings-only write path inside `/api/admin/listings/ingest` will be removed once parity is proven.
- **Tavily dedup_hint signal** — budget bucket exists; integration into `find_listing_duplicate_candidates` for borderline 40-60% confidence pairs is unbuilt.

## Related guides

- [search-indexing.md](search-indexing.md) — `search_index_queue` worker
- [hybrid-live-search.md](hybrid-live-search.md) — public surface that consumes the canonical state
