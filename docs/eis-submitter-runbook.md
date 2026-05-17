# EIS submitter operator runbook

**Worker:** `eis_submitter_tick`
**Endpoint:** `POST /api/internal/eis-submitter-tick`
**Cadence:** every 5–15 minutes (cron-runner of choice)
**Status:** runs in **noop mode** until you complete the steps below

---

## What this worker does

Drains the `eis_submissions` queue. For each row in `status='queued'`,
posts the canonical payload to the BIR Electronic Invoicing System
(EIS) sandbox / production endpoint and records the response.

Status flow:

```
queued → submitted → accepted   (BIR acked)
                  ↘ rejected    (BIR returned error)
queued → cancelled              (operator action via /admin/eis-submissions)
```

Network failures (DNS, timeout, 5xx) leave the row in `queued` for the
next tick to retry — they do **not** auto-reject, so a flaky BIR
sandbox doesn't poison your queue.

---

## Pre-deploy checklist

Run these once per environment (sandbox / production).

### 1. RDO accreditation (one-time, weeks-long)

EIS requires accreditation paperwork with your Revenue District Office.
Once approved, BIR issues:

- **Sandbox endpoint URL** + a sandbox bearer token for end-to-end testing
- **Production endpoint URL** + production bearer token
- A **supplier identity** record: TIN, registered name, registered address

Until accreditation lands, the worker stays in noop mode (see step 4).

### 2. Worker secret

Generate a 32+ character random string. The worker's HTTP entry point
gates on this so only your cron-runner can trigger it:

```bash
# Generate
openssl rand -hex 32

# Set in your deployment env
EIS_WORKER_SECRET=<the random string>
```

### 3. Provider credentials (live mode)

**Option A — environment variables** (preferred for production):

```
EIS_PROVIDER_URL=https://eis.bir.gov.ph/api/v1/invoices
EIS_PROVIDER_TOKEN=<bearer token from BIR>
```

**Option B — admin UI** (preferred for sandbox / per-tenant tweaks):

1. Sign in as an admin
2. Visit `/admin/platform-settings`
3. Fill in **EIS provider** with the URL + token
4. Fill in **EIS supplier** with your TIN, registered name, address
5. Save

The worker reads env first, then falls back to `platform_settings`.
If neither has both URL + token, it stays in **noop mode** — rows are
stamped `submitted` with `metadata.noop_provider=true` so test data is
distinguishable from real submissions.

### 4. Supplier identity (always required)

Even in noop mode, every payload needs supplier TIN + name. Set via:

- Postgres GUCs (highest priority): `app.eis_supplier_tin`, `app.eis_supplier_name`
- OR `platform_settings` key `eis_supplier` (set via `/admin/platform-settings`)

Empty supplier won't crash the submitter but BIR will reject the
payload in live mode.

### 5. Cron schedule

Point your cron-runner at the worker every 5–15 minutes. Examples:

**curl + cron-job.org / EventBridge / Vercel cron:**

```bash
curl -X POST 'https://your-portal.example.com/api/internal/eis-submitter-tick' \
  -H "Authorization: Bearer $EIS_WORKER_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"batch_size": 20}'
```

**Manual one-shot (admin UI):** the `/admin/operations` page has a
**Run now** button per HTTP worker that goes through a server-side
proxy (the secret never leaves the API server).

---

## Verification

After cron is wired up:

1. Visit `/admin/operations` and scroll to **Cron jobs & workers**.
   The `eis_submitter_tick` row should flip from **never_seen** to
   **healthy** within 15 minutes.
2. Visit `/admin/eis-submissions`. Pick an open or paid invoice and
   click **Submit**. The row appears in **Queued** within seconds.
3. Within one cron tick, the row moves to **Submitted** (or **Accepted**
   if BIR acked synchronously). In noop mode it shows the **noop** badge.

---

## Failure modes & recovery

| Symptom | Likely cause | Recovery |
| ------- | ------------ | -------- |
| Worker shows `never_seen` for >30 min | Cron-runner not wired or secret wrong | Re-run the curl from "Cron schedule"; check `EIS_WORKER_SECRET` |
| Worker `overdue` after a healthy period | Cron-runner stopped | Check the runner; re-trigger via Run now button |
| Rows stuck in `queued` forever | Provider unreachable or env not set | Check `/admin/operations` heartbeat payload for the last error; verify `EIS_PROVIDER_URL` is reachable |
| Rows go to `submitted` but never `accepted` | BIR sandbox latency or noop mode | If noop badge is set, wire credentials per step 3. If live, wait or contact BIR |
| Rows go to `rejected` consistently | Bad supplier TIN/name OR malformed payload | Inspect `response_notes` in `/admin/eis-submissions`; fix supplier identity (step 4); cancel + resubmit |
| Operator wants to abandon a stuck row | n/a | Click **Cancel** in `/admin/eis-submissions`. Row moves to `cancelled` (terminal). |

**Do not cancel `accepted` rows** — BIR has acknowledged them. The cancel
endpoint refuses with HTTP 409 to prevent state drift; contact BIR
directly to void.

---

## Why noop mode exists

EIS accreditation takes weeks. Noop mode lets you exercise the entire
pipeline (queue → submit → response → audit log) end-to-end against
sandbox payloads without contacting BIR. Every noop row is tagged
`metadata.noop_provider=true` so audit reviewers can filter them out.

Once accredited and credentials are set, future submissions go live
automatically — no code change.

---

## Trust boundaries

- The submitter runs as `service_role` (no per-user auth). Only the
  cron-runner with the bearer secret can invoke it.
- The freeze trigger on `eis_submissions` makes payload + refs
  immutable once `status='submitted'` or `'accepted'`. Status itself
  can still mutate (queued→submitted→accepted/rejected, or →cancelled),
  but BIR's frozen view of the document is preserved.
- Every tick writes a row to `ops_worker_heartbeats` so operators can
  detect silent failure.
