# Lead routing

Rule-driven inquiry assignment. When a row lands in `public.inquiries` (via the public website's inquiry form OR direct admin create), a BEFORE INSERT trigger consults `lead_routing_rules` first; if no rule matches, falls back to the legacy snapshot (listing's primary contact). Adminable rules + a preview RPC.

## Components

### Migration
- `20260508000009_lead_routing.sql` — `lead_routing_rules` table, BEFORE INSERT trigger, preview RPC.

### Table
```
lead_routing_rules (
  id uuid PK,
  name text,
  priority int,           -- lower wins
  conditions jsonb,       -- { city_id?, property_type?, for_sale?, for_rent?, contact_designation? }
  action_kind text CHECK IN ('assign_user', 'round_robin_pool'),
  action_payload jsonb,   -- { user_id } OR { pool_user_ids: [uuid, ...] }
  enabled bool,
  created_at, updated_at
)
```

### Trigger
- `inquiries_before_insert_route` — fires before each `public.inquiries` INSERT. Evaluates rules in priority order, sets `inquiries.assigned_user_id` if a rule matches. Falls through to legacy snapshot.

### RPC
- `preview_lead_routing(p_listing_id, p_inquiry_payload)` — returns the rule that WOULD match given the input, without mutating anything. Useful for the admin "test this rule" UI.

### Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/lead-routing-rules` | admin | List |
| POST | `/api/admin/lead-routing-rules` | admin | Create |
| PATCH | `/api/admin/lead-routing-rules/[id]` | admin | Update |
| DELETE | `/api/admin/lead-routing-rules/[id]` | admin | Delete |
| POST | `/api/admin/lead-routing-rules/preview` | admin | Dry-run a hypothetical inquiry |

### Admin page
- `/admin/lead-routing` — rules CRUD + preview. **Exemplar page** for the admin primitive recipe.

### Column naming gotcha
- `inquiries.assigned_user_id` (NOT `assignee_user_id` — that's `tasks`).
- See [[assignee-column-names]] memory for the full map.

## Operate

### Add a rule

From `/admin/lead-routing`:

1. **New rule**.
2. Name it descriptively (e.g. "Makati condos → senior team").
3. Set conditions:
   - `city_id: 1` (Makati)
   - `property_type: 'condo'`
   - `for_sale: true`
4. Pick action:
   - `assign_user` — single user. Payload: `{ user_id: '<uuid>' }`.
   - `round_robin_pool` — rotates among a list. Payload: `{ pool_user_ids: ['<uuid1>', '<uuid2>'] }`.
5. **Priority** — lower wins. Use 10, 20, 30 so you can insert between later.
6. **Enable** and save.

### Test before going live
- **Preview** in the admin UI runs `preview_lead_routing()` against a fake inquiry payload and shows which rule would match.
- Disable a rule by clearing `enabled` — keeps the row for audit but stops it from firing.

### Round-robin state
- The round_robin pool maintains its rotation cursor inside the trigger (in-memory per call; persistent state lives in a tiny `round_robin_state` row keyed by rule_id, created lazily).

## Smoke

```sql
-- 1. Trigger present?
SELECT tgname FROM pg_trigger
 WHERE tgrelid = 'public.inquiries'::regclass
   AND tgname LIKE '%route%';

-- 2. Rules registered?
SELECT name, priority, action_kind, enabled FROM public.lead_routing_rules
 ORDER BY priority;

-- 3. Preview a hypothetical
SELECT * FROM public.preview_lead_routing(
  p_listing_id => <some_listing_id>,
  p_inquiry_payload => '{}'::jsonb
);

-- 4. Real-fire test (will create an inquiry — clean up after):
INSERT INTO public.inquiries (listing_id, sender_name, sender_email, message)
VALUES (<test_listing_id>, 'smoke', 'smoke@test', 'smoke-test')
RETURNING id, assigned_user_id;
-- Then: DELETE FROM public.inquiries WHERE sender_email = 'smoke@test';
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| All inquiries land on the same person | Highest-priority rule too broad | Tighten the rule's conditions or raise priority of a more specific rule |
| `assigned_user_id` always NULL after match | Trigger threw, fell through to legacy, legacy snapshot has no contact_owner_user_id | Check Supabase logs for the trigger error |
| Round-robin uneven | Rules with overlapping conditions firing in unexpected order | Reduce overlap; rule priority should be strict |
| Inquiry write 500 | `created_by` orphan reference | Preflight per [[orphan-created-by]] |

## Open work

- **Schedule windows** — `conditions.active_hours_utc` for time-of-day routing (not yet implemented).
- **Skill / language matching** — rule conditions don't yet read `profiles.languages` or `profiles.specialties`.
- **Audit log** — which rule fired, with what payload, isn't persisted per-inquiry. Add a `lead_routing_audit` table later.

## Related guides

- [inquiry-pipeline.md](inquiry-pipeline.md) — what writes the inquiry row that triggers routing
