# Owner statement aggregation

Owner-side mirror of the tenant statement pipeline. Aggregates rent collected, maintenance expenses, vendor payments, and commissions into a per-owner statement. PDF rendered server-side.

## Components

### Migration
- `20260508000006_owner_statement_aggregation.sql` — `owner_statement_policies` + `owner_statements` tables + `generate_owner_statements()` function + cron schedule.

### Tables
| Table | Purpose |
|---|---|
| `owner_statement_policies` | Cadence + scope (per-owner / per-property) |
| `owner_statements` | Generated row: owner_id, period_start..end, gross_collected, expenses_total, commissions_total, net_remit |

### Function
- `generate_owner_statements()` — SECURITY DEFINER. Idempotent on `(owner_id, period_start)`.

### PDF
- `server/utils/pdf/renderOwnerStatementPdf.ts` — pdf-lib utility.
- `GET /api/admin/owner-statements/[id]/pdf` — PDF stream.

### Cron
- `generate_owner_statements_monthly` — `0 6 1 * *` UTC (first of each month, 06:00 UTC).

### Endpoints
- `GET /api/admin/owner-statements` — list.
- `GET /api/admin/owner-statements/[id]` — detail.
- `GET /api/admin/owner-statements/[id]/pdf` — PDF.

## Operate

### Create a policy

```sql
INSERT INTO public.owner_statement_policies (
  scope_kind, scope_id,
  cadence,
  remit_account_kind        -- 'bank_transfer' | 'check' | 'crypto' (none implemented today; metadata only)
)
VALUES ('owner', <owner_id>, 'monthly', 'bank_transfer');
```

### Manual fire

```sql
SELECT * FROM public.generate_owner_statements();
```

### Distribution

Statements aren't auto-emailed. Admin downloads the PDF via the page link and forwards manually (or sends via Resend through the admin UI's "send" button — not yet wired).

## Smoke

```sql
-- 1. Cron registered
SELECT jobname, schedule FROM cron.job WHERE jobname = 'generate_owner_statements_monthly';

-- 2. Policies present
SELECT scope_kind, cadence FROM owner_statement_policies;

-- 3. Manual fire
SELECT * FROM public.generate_owner_statements();
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Zero statements generated | Policy `cadence` not matching today | OK; first of month only |
| net_remit negative | Owner's expenses exceeded gross — usually fine | Validate the source data; review with operator |
| PDF blank line items | jsonb shape mismatch | Bump pdf-lib renderer version |

## Open work

- **Email delivery** — admin UI button to send the PDF as attachment via Resend. Today: manual download.
- **Owner-portal access** — read-only tenant-portal style invitation for owners isn't yet wired.
- **Multi-property roll-up** — currently per-owner, all properties. Per-property break-out would help large portfolios.

## Related guides

- [tenant-statement-aggregation.md](tenant-statement-aggregation.md) — tenant-side mirror
