# Operations Control Center — Redesign Blueprint

The canonical page architecture for every workflow surface in the
Housinginteractive platform. Inspired by Linear's issue queue,
Stripe's payments dashboard, and Vercel's deployment monitoring.

**Goal:** every page reads as a control center for its domain —
operationally clear, severity-ordered, action-first.

---

## 1. The four-zone page

Every workflow page (dashboards, list pages, admin queues, ops
panels) follows this top-to-bottom structure:

```
┌─────────────────────────────────────────────────────────────┐
│  ZONE 1 — PAGE HEADER                                        │
│  h1 + 1-line description + primary action (rightmost)        │
│  Optional: back-link, contextual filters                     │
├─────────────────────────────────────────────────────────────┤
│  ZONE 2 — OPERATIONAL SUMMARY                                │
│  3-5 KPI tiles, severity-toned. Each tile is clickable       │
│  and drills into the relevant filtered view.                 │
├─────────────────────────────────────────────────────────────┤
│  ZONE 3 — PRIMARY WORKFLOW                                   │
│  The thing the user came here to do. Two patterns:           │
│   (a) Workflow Queue — items needing action, severity-sorted │
│   (b) Data Table     — searchable, sortable, paginated       │
├─────────────────────────────────────────────────────────────┤
│  ZONE 4 — SECONDARY ANALYTICS / CONTEXT                      │
│  Trend charts, activity feed, related lists.                 │
│  Supporting context — never the primary action.              │
└─────────────────────────────────────────────────────────────┘
```

**Why this order:**
- **Severity first**: an operator opening any page sees the urgent
  count immediately (Zone 2)
- **Action second**: the workflow queue (Zone 3) is what the
  operator does next
- **Context last**: trends and history (Zone 4) inform the next
  decision but don't steal focus

This is the inverse of legacy admin dashboards (which lead with
charts and bury the actionable items).

---

## 2. Required primitives per zone

| Zone | Primitive | Purpose |
| --- | --- | --- |
| 1 | `<UiPageHeader>` | h1 + description + actions slot |
| 2 | `<OpsSummaryStrip>` | Severity-toned KPI row |
| 3a | `<WorkflowQueue>` | Items needing action |
| 3b | `<UiDataTable>` | Sortable list view |
| 4 | `<UiCard>` + `<UiSectionHeader>` | Charts / feeds |

Open `app/components/ui/Ui*.vue` for the primitive set. Compose,
never hand-roll chrome.

---

## 3. Severity hierarchy (the heart of the redesign)

Every status / KPI / row indicator uses one of four semantic tones,
defined as design tokens. **No raw red/green/amber/orange/purple.**

| Tone | Token | When to use |
| --- | --- | --- |
| Critical | `destructive` (red) | Blocks revenue, breaks compliance, user-facing failure |
| Warning | `warning` (amber) | Past-due, stale, needs review soon |
| Info / brand | `primary` (blue) | Routine actions, navigation, in-progress states |
| Healthy | `success` (green) | Passed, completed, accepted |
| Neutral | `muted` | Idle, archived, no signal |

**Order on a page:** critical → warning → primary → success → neutral.
Never alphabetical, never insertion-order. This is the operator's
scan order.

---

## 4. Information density

The platform is for power users running operations all day. Density
matters.

| Surface | Default padding | Default text size |
| --- | --- | --- |
| Page container | `space-y-6` between zones | — |
| Card / panel | `p-5` (`--card-pad`) | `text-sm` body, `.text-card-title` |
| KPI tile | `p-4` (`--card-pad-tight`) | `.text-eyebrow` + `.text-metric-value` |
| Data table row | `py-2.5` (~36px row height) | `text-sm` |
| Workflow queue row | `py-3` (~48px — needs more breathing room for actions) | `.text-body` |

These are codified as CSS variables in
`app/assets/css/tailwind.css :root` so future scale changes happen
in one place.

---

## 5. AI / intelligence surfacing

The platform should visibly feel AI-powered. Surface intelligence
inline:

- **Workflow queue items** with an AI suggestion get a small
  `<UiBadge variant="primary">AI</UiBadge>` indicator
- **Anomalies** (e.g., sudden inquiry spike) appear as a banner at
  top of Zone 4, not as a popup
- **Duplicate warnings** surface inline in lists, never as separate
  modals
- **Predictive signals** (deal closing soon, listing going stale)
  appear as ghost rows in the workflow queue with a softer tone
  than confirmed-action items

The pattern: AI augments, never interrupts. No chat bubbles, no
popovers that block flow.

---

## 6. Realtime / monitoring surfaces

Per the skill's "Real-Time Monitoring" recommendation, monitoring
panels (`/admin/operations`, system status) use:

- **Pulsing status dots** for live indicators (use the new
  `.status-dot-pulse` utility — to be added if not present)
- **Connection state** in a corner of the panel header
- **Critical alerts** prominent at the top with `bg-destructive/10
  border-destructive/30 text-destructive`
- **Auto-refresh** with a visible "last updated Xs ago" caption

---

## 7. Page-by-page application

| Page kind | Zone 1 | Zone 2 | Zone 3 | Zone 4 |
| --- | --- | --- | --- | --- |
| `/dashboard` | "Operations Control Center" | OpsSummaryStrip (4 KPIs) | WorkflowQueue (Needs Attention) | TrendChart + ActivityFeed |
| `/admin/operations` | "Operations" | OpsSummaryStrip (alerts/health) | OpsAlertFeed + CronJobs | DomainPanels |
| `/admin/eis-submissions` | "BIR e-Invoicing" | OpsSummaryStrip (eligible / queued / accepted) | UiDataTable (eligible) | UiDataTable (history) |
| `/admin/leases` | "Leases" | OpsSummaryStrip (active/draft/terminated) | UiDataTable (filtered) | — |
| `/listings` | "Listings" | OpsSummaryStrip (online/offline/stale) | UiDataTable | — |
| `/inquiries` | "Inquiries" | OpsSummaryStrip (new/in-progress/replied) | WorkflowQueue (new only) + UiDataTable (rest) | — |
| `/deals` | "Deals" | OpsSummaryStrip (per stage) | UiDataTable + Kanban toggle | — |
| `/admin/bir-2307` | "BIR Form 2307" | OpsSummaryStrip (period totals) | Form (period picker) → preview table | UiDataTable (saved runs) |
| `/admin/vendors` | "Vendors" | — (small surface) | UiDataTable + UiDrawer for edit | — |

Pages without a meaningful Zone 2 or Zone 4 may omit them — but the
order (1 → 2 → 3 → 4) is invariant.

---

## 8. Tooling enforcement

- `pnpm check:tokens` — blocks raw colors / paired-dark / rainbow accents / raw rings
- `node scripts/token-sweep.mjs <path>` — auto-rewrite legacy patterns
- `docs/design-system.md` — token + primitive contracts
- `design-system/housinginteractive/MASTER.md` + `pages/*.md` — skill-authored design intelligence
- `tests/dashboard-stats.test.ts` — guards count('exact') regression

These are the four pillars: **tokens, primitives, blueprint, runtime perf**.

---

## 9. Migration roadmap

Per-track. Each track is one focused session.

| # | Track | Pages | Effort |
| --- | --- | --- | --- |
| 1 | Dashboard reference | `dashboard.vue` | Done as part of this batch |
| 2 | Listings | `listings/index.vue`, `listings/[id].vue` | 1 session (large file) |
| 3 | CRM | `inquiries.vue`, `deals/index.vue`, `tasks.vue`, `contacts/[id].vue` | 1 session |
| 4 | Admin · Billing | `admin/eis-submissions.vue`, `admin/bir-2307.vue`, `admin/bir-2306.vue`, `admin/platform-fees.vue` | 1 session |
| 5 | Admin · PM | `admin/leases.vue`, `admin/units.vue`, `admin/owners.vue`, `admin/vendors.vue`, `admin/maintenance.vue`, `admin/work-orders.vue` | 1 session |
| 6 | Admin · Accounting | `admin/accounting.vue`, `admin/journal-entry-new.vue`, `admin/bank-reconciliation.vue` | 1 session |
| 7 | Analytics + market intel | `analytics.vue`, market widgets | 1 session |
| 8 | Documents | `document-drafts/*`, `admin/document-templates/*`, `admin/government-documents/*` | 1 session |
| 9 | Admin tabs (`/admin/index.vue` sub-components) | `BrokerImportTab`, `ListingImportTab`, `DuplicateReviewQueue`, etc. | 2 sessions |
| 10 | Settings + auth | `admin/platform-settings.vue`, `login.vue`, `register.vue`, profile pages | 0.5 session |

Each track follows the same recipe:
1. Open the page
2. Apply the four-zone structure
3. Replace bespoke chrome with primitives
4. Wire severity hierarchy via `tone="…"` props
5. Run `pnpm check:tokens` and `node scripts/token-sweep.mjs`
6. Move to the next page in the track

No track is allowed to introduce a new visual system, a new typography
chain, or a new color literal. The blueprint + token guard + skill
docs are the contract.

---

## 10. What this redesign is NOT

- Not a rewrite of routes or data layers
- Not a logo / brand refresh
- Not a complete style overhaul — the design system is already
  established (shadcn-vue tokens, semantic typography, primitives)
- Not a one-shot job — the long tail is mechanical per-page work
  governed by this blueprint
- Not adding new dependencies or design libraries

It IS a **product architecture spec** that turns 350+ disparate
pages into one coherent operations platform.
