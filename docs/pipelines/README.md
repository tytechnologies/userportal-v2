# Pipeline operations guides

Operational reference cards for every async / batched / cross-service
flow in the userportal + website ecosystem. Each guide is structured
the same way so you can pattern-match across them:

1. **Overview** — what the pipeline does, in one paragraph.
2. **Components** — tables, RPCs, endpoints, cron, env vars.
3. **Operate** — how to enable, configure, monitor.
4. **Smoke** — copy-pasteable verification steps.
5. **Failure modes** — what breaks and how to debug.
6. **Open work** — known gaps / deferred improvements.

If you're touching a pipeline, start here. If a pipeline isn't
listed, it doesn't have a guide yet — add one.

## Index

### Search & marketplace
- [hybrid-live-search.md](hybrid-live-search.md) — Zillow-style internal+external orchestrator
- [aggregation-ingest.md](aggregation-ingest.md) — listings_raw → normalized → listings
- [search-indexing.md](search-indexing.md) — Typesense write side + cutover
- [marketing-ticker.md](marketing-ticker.md) — live banner below the website nav
- [listing-syndication.md](listing-syndication.md) — outbound JSON feeds

### CRM / lead flow
- [lead-routing.md](lead-routing.md) — rules-first inquiry assignment
- [saved-search-digest.md](saved-search-digest.md) — daily email digests
- [inquiry-pipeline.md](inquiry-pipeline.md) — public form → CRM
- [image-upload.md](image-upload.md) — wizard → S3 → gallery

### Property management cron
- [late-fee-cron.md](late-fee-cron.md) — 04:00 UTC past-due assessment
- [tenant-statement-aggregation.md](tenant-statement-aggregation.md) — 05:00 UTC tenant statements
- [owner-statement-aggregation.md](owner-statement-aggregation.md) — owner-side statements + PDF
- [inspection-workflow.md](inspection-workflow.md) — inspections + tenant signing + damages

### Onboarding
- [self-serve-brokerage-onboarding.md](self-serve-brokerage-onboarding.md) — broker org bootstrap

## Conventions

- **Migrations** are referenced by their YYYYMMDDXXXXXX prefix.
- **Endpoint paths** are relative to the portal (`http://localhost:3002`)
  or website (`http://localhost:3001`) depending on where they live.
- **Env vars** ALL-CAPS, set in `.env`. See `.env.example` for the full list.
- **Internal auth** uses the `x-internal-secret` header matching
  `INTERNAL_CRON_SECRET`. Use the same value across portal env, website
  env, and `internal_config.digest_cron_secret`.
- **Smoke commands** use PowerShell-friendly `curl` syntax. macOS / Linux
  is interchangeable.

## When something breaks

1. **Logs first.** `pnpm dev` console for Nitro errors; Supabase
   dashboard logs for RPC/RLS issues; `cron.job_run_details` for
   scheduled jobs.
2. **The `degraded` marker.** Most pipelines return a `degraded: true`
   or `degraded: { reason }` field on soft-failure. Search the response
   body before assuming everything is fine.
3. **Reproduce with smoke.** Each guide's smoke section is the
   "is this even wired" test. If the smoke fails, the operational
   chain is broken — fix that first before chasing the user-facing
   bug.
