# Tenant statement aggregation

Daily at 05:00 UTC, `generate_tenant_statements()` runs against every active `tenant_statement_policy`, rolls up the tenant's recent charges + payments + late fees into a `tenant_statements` row, and renders the PDF via `pdf-lib`. Statements appear in the admin shell + (eventually) the tenant portal.

## Components

### Migration
- `20260508000005_tenant_statement_aggregation.sql` — `tenant_statement_policies` + `tenant_statements` tables + `generate_tenant_statements()` function + pg_cron entry.

### Tables
| Table | Purpose |
|---|---|
| `tenant_statement_policies` | When and how often to generate (per-property or per-lease, monthly / bi-monthly) |
| `tenant_statements` | Generated row: tenant_id, lease_id, period_start, period_end, balance_due, line_items jsonb |

### Function
- `generate_tenant_statements()` — SECURITY DEFINER. Idempotent on `(lease_id, period_start)`.

### PDF rendering
- `server/utils/pdf/renderTenantStatementPdf.ts` — pdf-lib utility.
- `GET /api/admin/tenant-statements/[id]/pdf` — streams the rendered PDF.

### Cron job
- `generate_tenant_statements_daily` — `0 5 * * *` UTC.

### Endpoints
- `GET /api/admin/tenant-statements` — list.
- `GET /api/admin/tenant-statements/[id]` — detail.
- `GET /api/admin/tenant-statements/[id]/pdf` — PDF stream.

## Operate

### Create a policy

```sql
INSERT INTO public.tenant_statement_policies (
  scope_kind, scope_id,    -- 'lease' + lease_id, OR 'property' + prop_id, OR 'organization' + org_id
  cadence,                 -- 'monthly' | 'bi_monthly'
  day_of_month,            -- 1..28 (cron triggers at 05:00 UTC, but the policy gates which days fire)
  include_late_fees        -- bool
)
VALUES ('property', <prop_id>, 'monthly', 1, true);
```

### Manual fire

```sql
SELECT * FROM public.generate_tenant_statements();
-- Returns: (statements_inserted, policies_evaluated)
```

### Send statements

The cron generates rows; emailing them is a separate step (today: manual from the admin UI).

## Smoke

```sql
-- 1. Cron registered
SELECT jobname, schedule FROM cron.job WHERE jobname = 'generate_tenant_statements_daily';

-- 2. Policies present
SELECT scope_kind, cadence, day_of_month, include_late_fees FROM tenant_statement_policies;

-- 3. Manual fire
SELECT * FROM public.generate_tenant_statements();

-- 4. PDF render works
-- (Hit /api/admin/tenant-statements/<id>/pdf from a logged-in admin browser tab)
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| No statements generated | Policy `day_of_month` doesn't match today | Working as designed; verify policy |
| Duplicates | Cron run twice; idempotency caught it (row count = 0 second time) | Working as designed |
| PDF rendering 500 | `pdf-lib` font load or layout overflow | Check Nitro logs; the renderer falls back to single-page |
| Late fees missing | `include_late_fees: false` in the policy | Update the policy |
| Balance wrong | Source data inconsistency (charges vs payments) | Reconcile manually; rerun |

## Open work

- **Auto-send** — generated statements aren't auto-emailed yet. Future: an `email_delivered_at` column + a follow-up cron that sends new statements.
- **Tenant portal access** — tenants can't yet view their own statements; gated by [[tenant-portal-invitations]].
- **Multi-currency** — assumes PHP. Pluggable currency formatter is queued.

## Related guides

- [late-fee-cron.md](late-fee-cron.md) — produces the late fees this aggregates
- [owner-statement-aggregation.md](owner-statement-aggregation.md) — sibling pipeline (owner-side)
