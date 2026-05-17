# Search indexing (Typesense)

External search engine for fast facet + free-text queries. Properties + listings get coalesced into a `search_index_queue` on write; a cron-driven worker drains the queue into Typesense. Phase 1 (parallel endpoint) is shipped; Phase 2 (full cutover from PG-FTS) is opt-in.

## Components

### Migrations
- `20260510000006_search_index_queue.sql` — queue table + triggers on `properties` and `listings`.

### Tables
- `search_index_queue` — `(id, property_id, op ('upsert'|'delete'), created_at, processed_at)`. Coalescing built-in: a pending row for the same `(property_id, op)` skips re-enqueue.

### Triggers
- `properties_search_index_enqueue` — after UPDATE/INSERT on `properties`.
- `listings_search_index_enqueue` — after UPDATE/INSERT/DELETE on `listings` (enqueues the listing's property_id).

### Portal utility
- `server/utils/typesense.ts` — fetch-based client. `isTypesenseEnabled()` gate. `upsertDocument`, `deleteDocument`, `searchProperties`.

### Worker
- `POST /api/internal/index-search-queue` — drain worker. Batches up to 200 rows in FIFO. When Typesense env is unset, marks rows processed as no-ops (queue stays bounded). Auth: `x-internal-secret`.

### Public endpoints
- `GET /api/public/search-typesense` (website) — parallel search path. Returns `{ disabled: true }` when env unset.
- `GET /api/public/search-hybrid` (website) — orchestrator that consumes search-typesense for the internal arm.

### Admin
- `/admin/search-index` — queue depth + engine status.

### Cron
- `index_search_queue_2m` — `*/2 * * * *` POSTs to the drain worker.

### Env vars
| Var | Side | Purpose |
|---|---|---|
| `TYPESENSE_HOST` | both | `https://your-typesense-host:443` (no trailing slash) |
| `TYPESENSE_API_KEY` | portal | Admin key (writes) |
| `TYPESENSE_SEARCH_API_KEY` | website | Search-only key (reads). Falls back to `TYPESENSE_API_KEY` if unset |

## Operate

### Provision Typesense

Two paths:
- **Self-host** — run the `typesense-server` binary on AWS (per `[[infrastructure]]` memory). Expose 8108 internally; put a reverse proxy in front for TLS.
- **Typesense Cloud** — sign up at https://cloud.typesense.org, create a cluster.

Either way: mint TWO API keys:
- Admin (full RW)
- Search-only (read + restricted to the `listings` collection)

### Bootstrap the index

1. Set env vars on the portal (`TYPESENSE_HOST` + admin key) and website (host + search-only key).
2. Restart both Nitro servers.
3. One-shot backfill seed in Supabase SQL editor:
   ```sql
   INSERT INTO public.search_index_queue (property_id, op)
   SELECT id, 'upsert' FROM public.properties
   ON CONFLICT DO NOTHING;
   ```
4. Wait for the 2-minute cron, or fire the worker manually:
   ```sql
   WITH cfg AS (
     SELECT portal_base_url, digest_cron_secret FROM internal_config WHERE id = 1
   )
   SELECT net.http_post(
     url := cfg.portal_base_url || '/api/internal/index-search-queue',
     headers := jsonb_build_object('content-type','application/json',
                                   'x-internal-secret', cfg.digest_cron_secret),
     body := jsonb_build_object('max', 500)
   ) FROM cfg;
   ```

### Watch the queue

```sql
-- Pending depth
SELECT count(*) FROM search_index_queue WHERE processed_at IS NULL;

-- Recent drain throughput
SELECT date_trunc('hour', processed_at) AS hr, count(*)
  FROM search_index_queue
 WHERE processed_at >= now() - interval '24h'
 GROUP BY 1 ORDER BY 1 DESC;
```

`/admin/search-index` surfaces this too.

## Smoke

```powershell
# 1. Engine reachable?
curl -s -H "X-TYPESENSE-API-KEY: <admin>" https://<typesense-host>/health
# Expect: {"ok":true}

# 2. Drain worker
curl -s -X POST -H "x-internal-secret: <INTERNAL_CRON_SECRET>" `
  -H "content-type: application/json" -d '{\"max\":50}' `
  http://localhost:3002/api/internal/index-search-queue

# 3. Parallel public endpoint
curl -s "http://localhost:3001/api/public/search-typesense?q=condo&for_sale=true" | jq '.engine, .totalCount'
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Queue grows unbounded | Worker not running, OR Typesense unreachable | Check `cron.job_run_details` + Typesense health |
| Queue drains but no results | Document shape mismatch; collection schema drifted | Verify the upsert payload in worker logs |
| `/api/public/search-typesense` returns `disabled` | Website env vars unset | Set `TYPESENSE_HOST` + key on website |
| Worker 401 | INTERNAL_CRON_SECRET mismatch | Confirm same value across portal env + internal_config |
| `502 typesense_search_failed` | Engine error / network | Worker logs the underlying error; caller's fallback (PG-FTS) catches |

## Phase 2 cutover (deferred)

The canonical search page (`/[...slug]`) still uses PG-FTS by default. To cut over to Typesense:

1. Provision Typesense (above).
2. Bootstrap-seed the queue.
3. Enable `?engine=hybrid` URL flag in user-facing entry points (already wired).
4. Watch dashboard latencies for a week. Internal p95 should land <150ms.
5. Flip the default in `pages/[...slug].vue` to call `/api/public/search-typesense` directly when no `engine` param is set. Keep PG-FTS behind `?engine=pg` as the rollback path.

## Open work

- Phase 2 cutover (above).
- `source_id` facet pivot — add to the Typesense schema so the dashboard can filter by partner source.
- Trigram text field for fuzzy free-text on title + address.

## Related guides

- [aggregation-ingest.md](aggregation-ingest.md) — what populates the canonical state the queue listens to
- [hybrid-live-search.md](hybrid-live-search.md) — the consumer of `/api/public/search-typesense`
