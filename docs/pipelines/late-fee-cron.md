# Late-fee assessment cron

Daily at 04:00 UTC, `assess_past_due_charges()` scans all active leases, finds property charges past their grace period, and inserts `late_fee_assessments` rows. The tenant statement aggregator (05:00 UTC) then rolls these into the tenant's monthly statement.

## Components

### Migration
- `20260508000004_late_fee_assessment.sql` — `late_fee_policies` + `late_fee_assessments` tables + `assess_past_due_charges()` function + pg_cron schedule.

### Tables
| Table | Purpose |
|---|---|
| `late_fee_policies` | Per-property or org-wide rule: grace_days, fee_kind (flat / percentage), amount, max_amount |
| `late_fee_assessments` | One row per assessed late fee: charge_id, assessed_amount, policy_id, assessed_on |

### Function
- `assess_past_due_charges()` — SECURITY DEFINER, service_role. Idempotent on `(charge_id, assessed_on)` so re-running same day is safe.

### Cron job
- `assess_past_due_charges_daily` — `0 4 * * *` UTC.

## Operate

### Configure a policy

```sql
INSERT INTO public.late_fee_policies (
  scope_kind, scope_id,         -- 'property' + property_id, OR 'organization' + org_id
  grace_days,                   -- e.g. 5
  fee_kind,                     -- 'flat' | 'percentage'
  amount,                       -- 500 (₱) for flat, OR 0.05 (5%) for percentage
  max_amount                    -- cap; NULL = no cap
)
VALUES ('property', <prop_id>, 5, 'flat', 500, NULL);
```

Policies are evaluated narrowest-scope-first: property-scoped > org-scoped.

### Manual fire

```sql
SELECT * FROM public.assess_past_due_charges();
-- Returns: (charges_evaluated, late_fees_inserted)
```

### Watch
- Cron runs: `SELECT * FROM cron.job_run_details WHERE jobname='assess_past_due_charges_daily' ORDER BY start_time DESC LIMIT 5;`
- Recent assessments: `SELECT count(*) FROM late_fee_assessments WHERE assessed_on >= current_date - 7;`

## Smoke

```sql
-- 1. Cron registered
SELECT jobname, schedule FROM cron.job WHERE jobname = 'assess_past_due_charges_daily';

-- 2. Policy registered
SELECT scope_kind, scope_id, grace_days, fee_kind, amount FROM late_fee_policies;

-- 3. Manual fire on a test date
SELECT * FROM public.assess_past_due_charges();
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Late fees never assessed | No policy configured for the property/org | Insert a `late_fee_policies` row |
| Same fee assessed twice | Bug in idempotency key (rare) | Manual delete; investigate the `(charge_id, assessed_on)` unique constraint |
| Fee = 0 | `amount` column 0 in the policy | Update the policy |
| Cron status `failed` | RPC threw — check the return_message | Most likely an FK violation; inspect the offending lease/charge |

## Open work

- **Notification on assessment** — currently silent. Future: email the tenant a notice when a late fee fires.
- **Waive workflow** — operator UI to mark an assessment as waived (logical delete with audit trail).

## Related guides

- [tenant-statement-aggregation.md](tenant-statement-aggregation.md) — consumes the assessments
