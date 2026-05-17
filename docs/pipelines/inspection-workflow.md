# Inspection workflow

Move-in / move-out / periodic property inspections. Operator schedules an inspection, records findings (with photos), the tenant signs digitally, and any damage findings convert to a property charge against the security deposit.

## Components

### Migration
- `20260508000007_inspections.sql` — `inspections` + `inspection_findings` tables + 3 RPCs.

### Tables
| Table | Purpose |
|---|---|
| `inspections` | One row per scheduled inspection: `(lease_id, kind, scheduled_for, completed_at, tenant_signed_at, signature_blob)` |
| `inspection_findings` | One row per finding: `(inspection_id, area, condition, severity, photos jsonb, charge_amount, charged_at)` |

### RPCs
- `complete_inspection(p_inspection_id, p_findings jsonb)` — admin marks the inspection complete with structured findings.
- `tenant_sign_inspection(p_inspection_id, p_signature_blob, p_signed_by_name)` — tenant-portal endpoint records the e-signature.
- `charge_damages_to_security_deposit(p_inspection_id)` — operator action; iterates findings with `severity='damage'`, inserts `property_charges`, marks `charged_at`.

### Endpoints
- `GET /api/admin/inspections` — list.
- `POST /api/admin/inspections` — create.
- `PATCH /api/admin/inspections/[id]` — update (e.g. reschedule).
- `POST /api/admin/inspections/[id]/complete` — admin completion wrapper around `complete_inspection`.
- `POST /api/admin/inspections/[id]/charge-damages` — wrapper around `charge_damages_to_security_deposit`.
- `POST /api/tenant/inspections/[id]/sign` — tenant-side signing (gated by tenant portal token).

### Pages
- `/admin/inspections` — list + filter + detail.
- Tenant portal sign-link uses a one-time token (see [[tenant-portal-invitations]]).

## Operate

### Schedule an inspection

From the lease detail page or `/admin/inspections`:
1. Pick lease + kind (`move_in` / `move_out` / `periodic`).
2. Pick a scheduled_for datetime.
3. Save. `inspections` row created in `scheduled` state.

### Conduct + complete

1. On-site, operator records findings (area, condition, severity, optional photos).
2. Click **Complete**. RPC `complete_inspection` writes `findings` rows + sets `completed_at`.

### Tenant signs

1. Operator clicks **Send for tenant signature** in the UI.
2. System emails a one-time signing link (tenant portal token).
3. Tenant clicks, reviews findings, draws/types signature, submits.
4. `tenant_signed_at` + `signature_blob` populated.

### Charge damages

After signing:
1. Click **Charge damages**. RPC iterates findings where `severity='damage'`, creates `property_charges` rows against the lease's security deposit, sets `charged_at` on each finding.
2. Charges flow into the next tenant statement.

## Smoke

```sql
-- 1. Tables exist
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name IN ('inspections','inspection_findings');

-- 2. RPCs callable
\df+ public.complete_inspection
\df+ public.tenant_sign_inspection
\df+ public.charge_damages_to_security_deposit

-- 3. Create + complete a smoke inspection
INSERT INTO public.inspections (lease_id, kind, scheduled_for)
VALUES (<lease_id>, 'periodic', now())
RETURNING id;

-- Use the id above:
SELECT public.complete_inspection(
  '<insp_id>'::uuid,
  '[{"area":"Kitchen","condition":"good","severity":"none"}]'::jsonb
);
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Tenant signing link 401 | Token expired or wrong | Generate a fresh invitation |
| `charge_damages` returns 0 charges | No findings with `severity='damage'` | Working as designed |
| Photo URLs broken | S3 signed URL expired | Re-upload OR change signed-URL TTL on the generator |
| Same finding charged twice | Re-firing `charge_damages` after a prior partial commit | The RPC checks `charged_at IS NULL` first, so this shouldn't happen — if it does, file as a bug |

## Open work

- **Photo annotation** — operator draws on photos to mark damage. Today: photos are just attachments.
- **Auto-dispute window** — tenant has N days to dispute after signing; not enforced today.
- **Multi-tenant signing** — for shared leases, only the primary signs today.

## Related guides

- [tenant-statement-aggregation.md](tenant-statement-aggregation.md) — receives the damage charges
