# Post-Signing Document Workflow — Design

**Status:** Draft, awaiting user approval before implementation plan
**Date:** 2026-05-12
**Owner:** Tyler
**Target branch:** `launch-readiness-2026-05-08` (or follow-up)

## Problem

After a sale contract is e-signed (or otherwise marked signed), a broker is
responsible for a long sequence of document acquisitions and uploads — BIR
tax computations, the BIR-issued Certificate Authorizing Registration (CAR),
provincial transfer tax payment, surrendering the original Condominium
Certificate of Title (CCT) or Transfer Certificate of Title (TCT) to the
Register of Deeds, obtaining certified true copies of the new title, and
filing for a new tax declaration in the buyer's name.

Today, none of this is tracked in the system. Brokers manage the sequence
informally and either miss steps, lose paperwork, or fail to deliver final
documents to the new owner. Lease/rental deals have a much shorter equivalent
checklist that is also untracked.

## Goal

A per-deal, sequentially-gated upload workflow that:

1. Triggers automatically when a `document_envelope` linked to the deal flips
   to `status='completed'`, **or** manually when a broker clicks
   "Start transfer process" (e.g., for paper signings outside the system).
2. Walks the broker through a strict-ordered list of required documents.
3. Each step requires (a) a document upload and (b) a self-attestation
   checkbox click before the next step unlocks.
4. Different sequences for sale-and-transfer vs. lease/rental.
5. For sale deals, branches between condo (CCT) and house/land (TCT) title
   transfer documents based on a one-time operator choice at start.
6. Workflow definition lives in seeded, admin-editable templates.

## Non-goals (v1)

- Admin UI for editing templates (deferred; v1 uses migrations / a seed
  script for changes).
- Step-revert / mid-step document swap RPCs (deferred; admin abandon +
  restart in v1).
- OCR / automated validation of uploaded BIR receipts.
- Reminder cron / SLA tracking for slow workflows (the deal page already
  surfaces "days in stage").

## Decisions (resolved during brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | What triggers the workflow? | Both — envelope completion (auto) + manual button |
| 2 | Sale vs. lease scope for v1? | Full sale flow + minimal 3-step lease stub |
| 3 | CCT (condo) vs. TCT (land) title docs? | Operator picks once at workflow start |
| 4 | What completes a step? | Upload + broker self-attest checkbox |
| 5 | Workflow definition source? | Seeded table, admin-editable (admin UI deferred) |

## Architecture

Four new tables. Master pair is admin-editable. Per-deal pair is a frozen
snapshot taken at workflow start — so template edits don't disrupt
in-flight deals.

State transitions go exclusively through three `SECURITY DEFINER` RPCs that
piggyback on the existing `deal_can_read` / `deal_can_write` helpers and
write to the existing `activities` table for audit.

### Data Model

#### `workflow_templates` (master, admin-editable)

```sql
id            uuid PRIMARY KEY DEFAULT gen_random_uuid()
key           text UNIQUE NOT NULL          -- 'sale_transfer_v1', 'lease_v1'
title         text NOT NULL
description   text
applies_to    text NOT NULL CHECK (applies_to IN ('sale','lease'))
active        boolean NOT NULL DEFAULT true
created_by    uuid REFERENCES profiles(id) ON DELETE SET NULL
created_at    timestamptz NOT NULL DEFAULT now()
updated_at    timestamptz NOT NULL DEFAULT now()
```

#### `workflow_template_steps` (master, admin-editable)

```sql
id                uuid PRIMARY KEY DEFAULT gen_random_uuid()
template_id       uuid NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE
step_index        int NOT NULL                  -- 1, 2, 3 … strict order
key               text NOT NULL                 -- 'cgt_computation', 'cct_original', …
title             text NOT NULL
description       text                          -- broker-facing instructions
phase             text NOT NULL                 -- 'bir_taxes' | 'transfer_tax' |
                                                --   'title_transfer' | 'tax_declaration' |
                                                --   'lease_documents'
branch            text NOT NULL DEFAULT 'always'
                  CHECK (branch IN ('always','condo_only','land_only'))
attestation_text  text NOT NULL
helper_doc_id     uuid REFERENCES government_documents(id) ON DELETE SET NULL
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
UNIQUE (template_id, step_index)
UNIQUE (template_id, key)
```

#### `deal_workflows` (per-deal snapshot)

```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
deal_id         uuid UNIQUE NOT NULL REFERENCES deals(id) ON DELETE CASCADE
template_id     uuid REFERENCES workflow_templates(id) ON DELETE SET NULL
template_key    text NOT NULL                  -- frozen — survives template renames
title_branch    text CHECK (title_branch IN ('condo','land'))  -- NULL for lease
status          text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','completed','abandoned'))
current_step_id uuid REFERENCES deal_workflow_steps(id) ON DELETE SET NULL
started_via     text NOT NULL CHECK (started_via IN ('envelope_auto','manual'))
envelope_id     uuid REFERENCES document_envelopes(id) ON DELETE SET NULL
started_by      uuid REFERENCES profiles(id) ON DELETE SET NULL
started_at      timestamptz NOT NULL DEFAULT now()
completed_at    timestamptz
abandoned_at    timestamptz
abandon_reason  text
```

#### `deal_workflow_steps` (per-deal snapshot)

```sql
id                      uuid PRIMARY KEY DEFAULT gen_random_uuid()
workflow_id             uuid NOT NULL REFERENCES deal_workflows(id) ON DELETE CASCADE
step_index              int NOT NULL                 -- copied from template
key                     text NOT NULL                -- copied (stable identifier)
title                   text NOT NULL                -- copied (history-stable)
description             text                         -- copied
phase                   text NOT NULL                -- copied
attestation_text        text NOT NULL                -- copied
status                  text NOT NULL DEFAULT 'locked'
                        CHECK (status IN ('locked','active','completed','skipped'))
document_id             uuid REFERENCES documents(id) ON DELETE RESTRICT
attested_at             timestamptz
attested_by             uuid REFERENCES profiles(id) ON DELETE SET NULL
attestation_signature   text                         -- frozen copy of attestation_text at click time
completed_at            timestamptz
skip_reason             text
created_at              timestamptz NOT NULL DEFAULT now()
UNIQUE (workflow_id, step_index)
```

### State Machine

```
workflow:   active ──► completed   (final advance succeeds)
            active ──► abandoned    (deal_workflow_abandon)

step:       locked ──► active       (prior step completed; one at a time)
            active ──► completed    (advance with doc + attestation)
            locked ──► skipped      (at workflow start: branch doesn't apply)
```

Invariant: at any moment, a workflow either is in a terminal state, or has
exactly one step in `status='active'`. `deal_workflows.current_step_id`
points at that step.

### RPCs

All three are `SECURITY DEFINER`, follow the `envelope_*` convention
in `20260507000048_document_envelopes.sql`, and write to `public.activities`
for audit on every transition.

#### `deal_workflow_start(deal_id, template_key, title_branch, started_via, envelope_id) → uuid`

- Permission: `deal_can_write(p_deal_id)` OR `has_permission('deals.write.team')`
- Rejects if a workflow already exists for the deal (UNIQUE FK + explicit check)
- Snapshots every row of `workflow_template_steps` for the matched template into
  `deal_workflow_steps`, copying `title`, `description`, `phase`,
  `attestation_text` verbatim
- For each snapshotted step where `branch` doesn't match `title_branch`,
  sets `status='skipped'` and `skip_reason='title_branch=<branch>; step requires <step.branch>'`
- First step with `status != 'skipped'` → `status='active'`; all others remain `locked`
- Sets `current_step_id` to that first active step's id
- Inserts `activities` row: `kind='deal.workflow_started'`, `subject_table='deals'`,
  `subject_id=deal_id`, metadata
  `{template_key, title_branch, started_via, envelope_id, step_count}`
- Returns the workflow id

#### `deal_workflow_advance(step_id, document_id, attestation_signature) → uuid | NULL`

- Permission: `deal_can_write(workflow.deal_id)`
- `SELECT … FOR UPDATE` on the workflow row to serialize concurrent submits
- Validates:
  - step exists and `step.status='active'`
  - `documents.id = p_document_id` exists and `documents.deal_id = workflow.deal_id`
  - `attestation_signature` is non-empty (the UI sends the step's `attestation_text` verbatim)
- Updates the active step:
  `status='completed'`, `document_id`, `attested_at=now()`,
  `attested_by=auth.uid()`, `attestation_signature`, `completed_at=now()`
- Finds the next step by `step_index > current.step_index` with `status='locked'`,
  skipping any `status='skipped'` rows:
  - **None remaining:** sets workflow `status='completed'`, `current_step_id=NULL`,
    `completed_at=now()`. Inserts `activities` row `kind='deal.workflow_completed'`.
    Returns NULL.
  - **Found:** sets that step `status='active'`, workflow `current_step_id` updated.
    Inserts `activities` row `kind='deal.workflow_step_completed'` with metadata
    `{completed_step_key, next_step_key, step_index}`. Returns next step id.

#### `deal_workflow_abandon(workflow_id, reason) → uuid`

- Permission: `deal_can_write(workflow.deal_id)` OR `has_permission('deal_workflows.abandon')`
- Rejects if workflow is already terminal
- Requires non-empty `reason`
- Sets workflow `status='abandoned'`, `abandoned_at=now()`, `abandon_reason=reason`
- Inserts `activities` row `kind='deal.workflow_abandoned'` with metadata
  `{reason, abandoned_at_step_index, abandoned_at_step_key}`
- Preserves the step snapshot (doesn't delete) — audit-stable
- Returns workflow id

### Why no DB trigger on `document_envelopes`

Considered but rejected: an `AFTER UPDATE` trigger on `document_envelopes`
firing when `status` flips to `completed` and auto-inserting a `deal_workflows`
row.

- The operator still has to pick `title_branch` (condo vs. land) before
  steps can be snapshotted. A trigger would either need to pre-create a
  half-formed workflow row (steps deferred) or guess from
  `listings.property_type` (rejected during brainstorming).
- The UI already needs to render a kickoff card. Having the same card serve
  both the envelope-completion and manual-start cases keeps one code path.

Result: "auto-start on envelope completion" is implemented client-side via
reactive UI subscribing to envelope status. The kickoff card auto-appears
when an envelope linked to the deal flips to `completed` and no workflow
exists. Both auto and manual routes call `deal_workflow_start` with the
appropriate `started_via`.

### Permissions

New entries in `public.permissions`:

| name | description | category |
|---|---|---|
| `workflow_templates.write` | Create/edit/disable workflow templates | `workflow` |
| `workflow_templates.read.all` | Read drafts + disabled templates | `workflow` |
| `deal_workflows.abandon` | Abandon a deal's workflow regardless of participation | `workflow` |

Default role grants:
- `admin` — all three
- `manager` — `workflow_templates.write`, `deal_workflows.abandon`
- `agent` — none beyond the default authenticated SELECT on active templates

### RLS

**Master tables:**

```sql
-- workflow_templates
SELECT to authenticated USING (active = true)
SELECT to authenticated USING (has_permission('workflow_templates.write'))  -- composes (OR)
INSERT / UPDATE / DELETE to authenticated USING/WITH CHECK has_permission('workflow_templates.write')

-- workflow_template_steps
SELECT to authenticated USING (
  EXISTS (SELECT 1 FROM workflow_templates t
          WHERE t.id = template_id
            AND (t.active = true OR has_permission('workflow_templates.write'))))
INSERT / UPDATE / DELETE to authenticated USING/WITH CHECK has_permission('workflow_templates.write')
```

**Per-deal tables:**

```sql
-- deal_workflows
SELECT to authenticated USING (deal_can_read(deal_id))
INSERT / UPDATE / DELETE blocked — RPC-only

-- deal_workflow_steps
SELECT to authenticated USING (
  EXISTS (SELECT 1 FROM deal_workflows w
          WHERE w.id = workflow_id AND deal_can_read(w.deal_id)))
INSERT / UPDATE / DELETE blocked — RPC-only
```

This mirrors the `envelope_audit_events` pattern in
`20260507000048_document_envelopes.sql`: state machine integrity is enforced
by funnelling all writes through `SECURITY DEFINER` RPCs. The bug class fixed
by `20260511000005` and `20260511000006` (trigger function inserts blocked by
caller RLS) is structurally avoided here: the RPCs run as `postgres` and
write the state row + activity row in one transaction.

### `documents` table interaction

Uploads go through the existing documents pipeline. No schema change to
`documents` itself.

- Upload via `/api/documents/upload` with `deal_id` set and
  `document_type='workflow_step_<step.key>'` (e.g.,
  `'workflow_step_cgt_computation'`).
- Existing `documents_select_via_deal` and `documents_insert_via_deal`
  policies (from `20260507000021_deals_pipeline.sql`) already let deal
  participants read/write deal-attached documents.
- `deal_workflow_steps.document_id` is a one-way FK with `ON DELETE RESTRICT`,
  so a doc bound to an attested step can't be silently deleted —
  preserves audit. To remove an attached doc, abandon the workflow first.

### Activity audit

The existing `public.activities` table (from `20260429000006_phase4_rbac_audit.sql`)
has columns `user_id`, `action`, `entity`, `entity_id` (uuid), `metadata`,
`created_at`. RPCs insert one row per transition:

| action | entity / entity_id | When | Metadata |
|---|---|---|---|
| `deal_workflow_started` | `deal` / `deal.id` | RPC `deal_workflow_start` succeeds | `template_key, title_branch, started_via, envelope_id, step_count, workflow_id` |
| `deal_workflow_step_completed` | `deal` / `deal.id` | `deal_workflow_advance` succeeds, more steps remain | `workflow_id, completed_step_key, next_step_key, step_index` |
| `deal_workflow_completed` | `deal` / `deal.id` | `deal_workflow_advance` succeeds, no steps remain | `workflow_id, total_steps_completed, completed_at` |
| `deal_workflow_abandoned` | `deal` / `deal.id` | `deal_workflow_abandon` succeeds | `workflow_id, reason, abandoned_at_step_index, abandoned_at_step_key` |

`action` follows the `verb_noun` convention from existing rows
(`listing_created`, `listing_archived`). `entity` is `'deal'` so workflow
events appear on the deal's existing activity timeline without UI changes.
Since the workflow RPCs are `SECURITY DEFINER` they can either call
`public.log_activity(p_action, p_entity, p_entity_id, p_metadata)` (which
stamps `user_id` from `auth.uid()`) or insert directly. The implementation
plan should call `log_activity` to match existing call sites.

## UI

### Component tree

```
app/pages/deals/[id].vue
  └─ DealWorkflowKickoffCard.vue       (shown when eligible-to-start, no workflow yet)
  └─ DealWorkflowPanel.vue             (shown when workflow active or completed)
        └─ DealWorkflowStepRow.vue * N (one row per step)

app/components/deals/DealsPipelineCard.vue
  └─ small "📋 3/12" progress chip on the kanban tile when workflow active
```

### `DealWorkflowKickoffCard.vue`

Shown on the deal page when:
- `deal_workflows` row does NOT exist for this deal
- AND either: a `document_envelopes` row with `deal_id = this.deal.id` has
  `status='completed'`, OR the operator has clicked "I have a signed
  contract from outside the system."

Contents:
- "🎉 Contract signed!" heading
- One-paragraph explanation of what the workflow tracks
- Radio for title branch (condo / land), shown only for sale templates
- "Start transfer process" button → calls `/api/deals/[id]/workflow/start`

### `DealWorkflowPanel.vue`

Shown when `deal_workflows` row exists.

- Header: progress count (`3 / 12 complete`), branch label, start metadata.
- Vertical stepper listing each step with status visuals:
  - **`completed`**: ✓ + label + completion date. Collapsed; click expands to
    show uploaded doc + attestation row + attested-by line.
  - **`active`**: full upload + attestation + advance affordance. Includes
    optional "Reference" link if `helper_doc_id` is set.
  - **`locked`**: 🔒 + label only, no interaction.
  - **`skipped`**: not rendered (audit-only).
- "Abandon workflow" link in the panel footer for admins/managers; opens a
  confirmation modal that requires a non-empty reason.

The panel subscribes to a Supabase realtime channel on the `deal_workflows`
row so admin actions (abandon, future revert) refresh live.

### Upload mechanics

1. Broker drops a file → client uploads via the existing
   `/api/documents/upload` endpoint with `deal_id` and the step-specific
   `document_type='workflow_step_<step.key>'`.
2. Returned `document_id` is held in component state.
3. Broker checks the attestation box.
4. Component calls `/api/deals/[id]/workflow/advance` with
   `{ step_id, document_id, attestation_signature: step.attestation_text }`.
5. On success, the panel re-fetches and the next step expands. Toast:
   `"<step.title> saved. Next up: <next_step.title>."`

### Notifications (deferred to follow-up)

Optionally, an `AFTER UPDATE` trigger on `document_envelopes` could insert
a `public.notifications` row (kind `'deal.workflow_eligible'`,
`recipient_user_id = deal.buyer_agent_user_id`, `href = '/deals/<id>'`) so
brokers see the bell-icon prompt when they're not on the deal page.

**Not in v1.** Brokers visit the deal page frequently and the kickoff card
appears automatically there via the realtime envelope subscription.
Notifications are a nice-to-have; adding them later is one trigger + one
permission grant and doesn't depend on the v1 schema.

## Seeded Content

Migration `20260512000002_workflow_templates_seed.sql` inserts the two
templates with `INSERT … ON CONFLICT DO NOTHING` so re-apply is idempotent.

### Template `sale_transfer_v1`

16 steps, ordered:

| # | key | branch | phase | title |
|---|---|---|---|---|
| 1 | `cgt_computation` | always | bir_taxes | Computation of Capital Gains Tax (CGT) |
| 2 | `dst_computation` | always | bir_taxes | Computation of Documentary Stamp Tax (DST) |
| 3 | `bir_car_issued` | always | bir_taxes | BIR-issued CAR (Certificate Authorizing Registration) |
| 4 | `transfer_tax_payment` | always | transfer_tax | Transfer Tax computation & payment |
| 5 | `cct_original` | condo_only | title_transfer | Original Copy of CCT |
| 6 | `cct_certified_true_copy` | condo_only | title_transfer | Certified True Copy of CCT |
| 7 | `car_original` | always | title_transfer | Original Copy of Certificate of Authorizing Registration |
| 8 | `car_certified_true_copy` | always | title_transfer | Certified True Copy of Certificate of Authorizing Registration |
| 9 | `tct_filed` | land_only | title_transfer | Transfer of Certificate of Title (TCT) |
| 10 | `property_title` | land_only | title_transfer | Property Title |
| 11 | `title_certified_true_copies` | land_only | title_transfer | Certified True Copies of the Title |
| 12 | `original_documents_transmittal` | always | title_transfer | Transmittal of unit's Original Documents to new Owner |
| 13 | `real_property_declaration` | always | tax_declaration | Original Copy of Declaration of Real Property |
| 14 | `rpt_non_delinquency_certified` | always | tax_declaration | Certified True Copy of Certificate of Non-Delinquency on Real Property Tax |
| 15 | `rpt_receipt_updated` | always | tax_declaration | Original Copy of Updated Real Property Tax Receipt |
| 16 | `new_tax_declaration_buyer` | always | tax_declaration | New Tax Declaration under Buyer's name |

After branch filtering:
- Condo deal: 13 active steps (skips 9, 10, 11)
- Land deal: 14 active steps (skips 5, 6)

Each step's `attestation_text` is `"I confirm this is the correct {title}
for this deal."` (literally substituted at seed time, so it's static text
per step, not a runtime template). Stored in `attestation_signature` verbatim
at attestation click.

`description` is short and factual per step. `helper_doc_id` is NULL in
seed; admin can wire up later via SQL or admin UI.

### Template `lease_v1`

Three steps, `applies_to='lease'`, no branches:

| # | key | phase | title |
|---|---|---|---|
| 1 | `signed_lease_contract` | lease_documents | Signed lease contract (final executed copy) |
| 2 | `tenant_valid_id` | lease_documents | Tenant's valid government ID |
| 3 | `security_deposit_receipt` | lease_documents | Proof of security deposit + advance rent payment |

### Template selection logic

The kickoff card picks the right template based on the deal's listing:

- `listings.for_sale = true` → `sale_transfer_v1`
- `listings.for_rent = true` AND `for_sale = false` → `lease_v1`
- Both true → `sale_transfer_v1` (signing was a sale)

When the workflow starts, the resolved `template.key` is what's stored in
`deal_workflows.template_key`. The `id` may go NULL on template deletion;
the frozen step snapshot in `deal_workflow_steps` is what drives the UI.

### Step text is editable; `key` is immutable

`title`, `description`, `attestation_text`, `phase`, `branch`, and
`step_index` (reorder) are all editable via SQL or future admin UI.
`key` cannot change once a step exists — it appears in
`documents.document_type` strings and in `activities.metadata` and must
remain stable for downstream filters and analytics.

## Migrations

Four migrations, each rollback-safe with a `-- ROLLBACK:` header listing
`DROP …` in reverse-dependency order (same convention as
`20260507000048_document_envelopes.sql`).

```
20260512000001_workflow_templates_tables.sql
  workflow_templates, workflow_template_steps
  permissions, RLS, governance_schema_contracts

20260512000002_workflow_templates_seed.sql
  INSERT … ON CONFLICT DO NOTHING for sale_transfer_v1 + lease_v1

20260512000003_deal_workflows_tables.sql
  deal_workflows, deal_workflow_steps
  RLS (SELECT-only for authenticated; RPC-only writes)
  governance_schema_contracts

20260512000004_deal_workflows_rpcs.sql
  deal_workflow_start / deal_workflow_advance / deal_workflow_abandon
  GRANT EXECUTE … TO authenticated
  NOTIFY pgrst, 'reload schema'
```

Activity rows written by RPCs are **not** rolled back — `public.activities`
is the durable cross-feature audit. Tearing down workflow tables leaves the
deal's history intact (mirrors how `envelope_audit_events` is preserved
separate from envelope cleanup).

## Application Code

```
server/api/deals/[id]/workflow.get.ts          (read workflow + steps)
server/api/deals/[id]/workflow/start.post.ts   (wraps deal_workflow_start)
server/api/deals/[id]/workflow/advance.post.ts (wraps deal_workflow_advance)
server/api/deals/[id]/workflow/abandon.post.ts (wraps deal_workflow_abandon)

app/components/deals/DealWorkflowKickoffCard.vue
app/components/deals/DealWorkflowPanel.vue
app/components/deals/DealWorkflowStepRow.vue
app/pages/deals/[id].vue                        (mount kickoff + panel)
app/components/deals/DealsPipelineCard.vue      (kanban progress chip)
```

Admin CRUD UI for templates is deferred. A `pnpm seed:workflow-template`
script (or direct SQL) covers any step-text edits in v1.

## Edge Cases

| Case | Behavior |
|---|---|
| Two brokers click "Save & continue" at once | `SELECT … FOR UPDATE` on the workflow row in `deal_workflow_advance` serializes. The losing call sees `step.status != 'active'` and returns a friendly error. UI surfaces: "Another teammate just advanced this step." |
| Envelope completes with `deal_id IS NULL` | Kickoff card doesn't auto-show. Manual "Start transfer process" button still works once a deal exists and the broker triggers it. |
| Listing `property_type` changes mid-workflow | No effect. `title_branch` is frozen at start; subsequent listing edits don't migrate in-flight workflows. |
| Template `active=false` flipped mid-workflow | No effect on in-flight deals (they read from the frozen snapshot in `deal_workflow_steps`). New workflows pick a different active template for their `applies_to`. |
| Uploaded document gets deleted from `documents` | `deal_workflow_steps.document_id` is `ON DELETE RESTRICT`. To remove an attached doc, abandon the workflow first. |
| Wrong branch picked at start | Admin abandons the workflow → broker restarts with the correct branch. Uploaded docs persist on the deal; broker can reuse them. |
| Advance API called on a `locked` or `completed` step | RPC validates `step.status='active'`. Rejects with explanatory error. |
| Cross-deal document binding | RPC validates `documents.deal_id = workflow.deal_id`. Rejects with `"document does not belong to this deal."` |
| Deal stage flips to `closed_lost` mid-workflow | Workflow keeps running, decoupled from `deals.stage_key`. Broker can abandon explicitly if appropriate. |
| Second `deal_workflow_start` call | `deal_workflows.deal_id` is UNIQUE — second insert fails. RPC returns `"workflow already exists for this deal"`. |
| Deal's listing has neither `for_sale` nor `for_rent` true | Shouldn't occur (business invariant), but defensively the kickoff card renders a friendly error: "Listing has no sale/rent kind set — fix the listing before starting the transfer workflow." No RPC call attempted. |

## Testing

### SQL-level (Postgres)

Runs as part of CI alongside `pnpm check:migrations`. Scripts exercise:

- Happy path: start → advance 16 times → completed (sale, condo branch and
  land branch separately, asserting correct skip counts)
- `attestation_signature` is persisted verbatim
- Abandon mid-flow → workflow status flips, step snapshot preserved
- Race: parallel advance calls — exactly one succeeds, the other gets a
  state-machine error
- RPC permission denials for non-participants
- Cross-deal document binding rejected
- Branch skipping: condo skips 3 land steps, land skips 2 condo steps

### Playwright E2E

Extends the three smoke specs added in `0c00d3b`:

- `workflow_sale_condo.spec.ts` — envelope completes → kickoff card →
  pick condo → upload + attest 13 steps → completion screen
- `workflow_lease.spec.ts` — lease stub end-to-end
- `workflow_manual_start.spec.ts` — no envelope, manual start
- `workflow_abandon.spec.ts` — admin abandons; broker restarts on the
  corrected branch

### Manual smoke

Run dev server, complete a real envelope on a sale deal, walk a full sale
workflow in the browser to completion. Matches the launch-readiness
verification pattern Tyler uses for UI changes.

## Future Work (post-v1)

- Admin UI for editing templates (CRUD on `workflow_templates` /
  `workflow_template_steps`)
- `deal_workflow_revert_step(step_id, reason)` admin RPC for fixing
  wrong attestations without abandoning the whole workflow
- Mid-step document replacement (linked to revert semantics)
- Reminder cron for stale steps (no progress in N days)
- Per-step due-date tracking and SLA reporting
- Per-step "needs reviewer" override (some brokerages might want manager
  sign-off on the BIR CAR upload even though default is self-attest)
- OCR / structured data extraction for BIR receipts to validate amounts
  against `deals.deal_value`
- Buyer-facing read-only progress page (token-gated, like envelope external
  recipient links) so buyers can see workflow status

## Open Questions

None blocking. The five clarifying questions during brainstorming resolved
all major axes. The admin UI for template editing is the most likely first
follow-up.
