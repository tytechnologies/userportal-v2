# Housinginteractive Design System

The visual language for the user portal. Inspired by Linear, Stripe
Dashboard, Vercel, and Notion. Built on Tailwind + shadcn-vue tokens
+ a small set of opinionated primitives.

**Goal:** every screen reads as part of one premium SaaS product —
operational, calm, fast, dark-mode native.

---

## 1. Foundation

### 1.1 Color tokens

All color decisions go through HSL CSS variables in
`app/assets/css/tailwind.css`. Two themes (light + `.dark`) flip
automatically via `useTheme()`.

| Token | Use |
| --- | --- |
| `bg-background` / `text-foreground` | Page chrome |
| `bg-card` / `text-card-foreground` | Panel surfaces |
| `bg-popover` / `text-popover-foreground` | Floating popovers |
| `bg-primary` / `text-primary-foreground` | Brand action (HI blue) |
| `bg-secondary` / `text-secondary-foreground` | Secondary action |
| `bg-muted` / `text-muted-foreground` | De-emphasized surfaces / text |
| `bg-accent` / `text-accent-foreground` | Hover states |
| `bg-destructive` / `text-destructive-foreground` | Destructive action |
| `bg-success` / `text-success-foreground` | Positive semantic |
| `bg-warning` / `text-warning-foreground` | Caution semantic |
| `border-border` / `border-input` / `ring-ring` | Form chrome |

For tinted backgrounds, use opacity suffixes:
`bg-success/10`, `bg-warning/15`, `bg-primary/5`.

**Never hard-code grays or paired `dark:` variants.** The CI guard
(`pnpm check:tokens`) blocks regressions.

### 1.2 Typography

Semantic classes (defined in tailwind.css `@layer components`):

| Class | Use |
| --- | --- |
| `.text-page-title` | h1 of a top-level page. ~28px, `tracking-tight`. |
| `.text-section-title` | h2 of a section / card cluster. 16px semibold. |
| `.text-card-title` | h3 of a single card. 14px semibold. |
| `.text-eyebrow` | Tiny uppercase label above a value. 11px. |
| `.text-metric-value` | Big tabular number for KPI cards. 24px, `tabular-nums`. |
| `.text-metric-delta` | Small accent number under metrics. |
| `.text-body` | Default body copy. 14px. |
| `.text-meta` | Muted secondary text. 12px. |
| `.text-caption` | Smallest meaningful text (timestamps). 11px. |

Use these instead of bespoke `text-2xl font-semibold ...` chains.
The class encodes the design intent; future scale changes happen in
one place.

### 1.3 Spacing rhythm

Container widths:
- `max-w-4xl` — focused single-column flows (forms, settings)
- `max-w-5xl` — list pages
- `max-w-7xl` — dashboards, wide tables
- `max-w-[1400px]` — admin power-user surfaces

Vertical rhythm inside a page:
- `space-y-6` between major sections (default)
- `space-y-4` inside a section
- `space-y-2` inside a card

CSS custom properties (settable per page for density override):
```css
:root {
  --rhythm: 1.5rem;       /* default */
  --rhythm-tight: 1rem;   /* admin tables */
  --rhythm-loose: 2rem;   /* marketing-style pages */
}
```

### 1.4 Motion

Three timing tokens; everything else is one of these:
```css
--motion-fast:   120ms  /* hover states, focus rings */
--motion-medium: 200ms  /* drawers, modals open/close */
--motion-slow:   320ms  /* page transitions */
--motion-ease:        cubic-bezier(0.2, 0.6, 0.2, 1)
--motion-ease-out:    cubic-bezier(0.16, 1, 0.3, 1)
```

In Tailwind: `transition-colors duration-150 ease-out`. Don't ship
animations longer than 320ms.

### 1.5 Elevation

Three rhythm tiers:
- `surface-1` — page chrome (bg-background)
- `surface-2` — cards (bg-card + border)
- `surface-3` — popovers / modals (bg-popover + shadow-lg)

Shadows are subtle: `shadow-sm` for resting elevation, `shadow-lg`
only for floating elements (popover, modal, FAB).

### 1.6 Focus

Every interactive element should compose `.focus-ring`:
```html
<button class="... focus-ring">…</button>
```
This produces a ring matching the active color theme with proper
ring offset. Don't roll your own focus styling.

---

## 2. Components

### 2.1 Layout shells

| Primitive | Use |
| --- | --- |
| `<AdminPageShell>` | Outer container + access-check fallback. Default permission `admin.access`; pass `:permission="false"` to skip. |
| `<UiPageHeader title="…">` | h1 + description + optional `back` link + `actions` slot. Pair with AdminPageShell for top-level pages. |
| `<UiSectionHeader title="…">` | h2 inside a section. `eyebrow` + `description` + `actions` slot. |

### 2.2 Surface

| Primitive | Use |
| --- | --- |
| `<UiCard variant="surface" padding="md">` | Replaces every `rounded-2xl border bg-card p-5` chain. Variants: `surface` \| `elevated` \| `ghost` \| `interactive`. |
| `<AdminCard>` | Legacy alias of UiCard (still works). |

### 2.3 Data + content

| Primitive | Use |
| --- | --- |
| `<UiStatCard label="…" :value="…" tone="success">` | KPI / metric card. Slots: `trailing` (icon), default (chart). |
| `<UiBadge variant="success" :dot="true">` | Status pill. Variants: neutral / primary / success / warning / destructive / info. |
| `<UiDataTable :columns="…" :rows="…">` | Sticky-header table primitive. Cells via `cell-{id}` slot, empty via `empty` slot. Sortable headers via `sortKey` per column + `:sort` prop + `update:sort` event (see contract below). |
| `<UiSkeleton class="h-4 w-32">` | Shimmer placeholder. Pass any size classes. |
| `<UiEmptyState title="…" description="…">` | Centered "nothing here" placeholder. Slots: `icon`, `action`. |

#### `UiDataTable` sortable contract

Add a `sortKey` to any column to make its header clickable. Parent
owns the sort state (so server-side sort + client-side sort use the
same shape) and applies the sort itself; the table just emits clicks.

- `sortKey` (string, optional) — the data field to sort by. Without it,
  the header is non-interactive.
- `:sort` (prop) — current sort `{ key, dir: 'asc' | 'desc' } | null`.
- `@update:sort` (event) — fires `{ key, dir }` when a header is clicked.
  Parent decides what to do with it (re-fetch, re-sort, etc.).
- Glyphs: `↕` (idle sortable) → `↑` (asc) → `↓` (desc).
- `aria-sort` set automatically — `ascending` / `descending` / `none`.

**Worked example — `app/pages/admin/eis-submissions.vue` eligible-invoices table:**

```vue
<script setup lang="ts">
const eligibleColumns = [
  { id: 'invoice_no',  label: 'Invoice', sortKey: 'invoice_no' },
  { id: 'status',      label: 'Status',  sortKey: 'status' },
  { id: 'total_minor', label: 'Total',   align: 'right', sortKey: 'total_minor' },
  { id: 'issued_at',   label: 'Issued',  sortKey: 'issued_at' },
  { id: 'latest',      label: 'Latest EIS' },        // not sortable — derived
  { id: 'action',      label: '' },                  // action column
]

const eligibleSort = ref<{ key: string; dir: 'asc' | 'desc' } | null>({
  key: 'issued_at', dir: 'desc',
})

const sortedEligible = computed(() => {
  if (!eligibleSort.value) return eligible.value
  const { key, dir } = eligibleSort.value
  const factor = dir === 'asc' ? 1 : -1
  return [...eligible.value].sort((a, b) => {
    const av = (a as any)[key]
    const bv = (b as any)[key]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (av < bv) return -1 * factor
    if (av > bv) return 1 * factor
    return 0
  })
})
</script>

<template>
  <UiDataTable
    :columns="eligibleColumns"
    :rows="sortedEligible"
    :loading="loading"
    :sort="eligibleSort"
    @update:sort="eligibleSort = $event"
  >
    <template #cell-invoice_no="{ row }">
      <span class="font-mono text-xs">{{ row.invoice_no }}</span>
    </template>
    <!-- … other cell slots … -->
  </UiDataTable>
</template>
```

For server-side sort, swap the `computed` for a re-fetch:
`watch(eligibleSort, () => loadEligible(eligibleSort.value))`. The
table contract is identical either way.

### 2.4 Filtering + actions

| Primitive | Use |
| --- | --- |
| `<UiFilterChip v-model:active="x" :count="12">` | Toggleable filter pill with count badge. |
| `<UiTabBar v-model="active" :tabs="…" variant="underline\|pill">` | Page-level tab strip OR in-card segmented control. |
| `<UiToolbar :sticky="true">` | Filter + action row. Slots: `leading` (filters) / default (center) / `trailing` (actions). |
| `<UiButton variant="primary">` | Existing `Button.vue` (variants: primary / secondary / outline / ghost / destructive). |
| `<UiInput>` | Existing `UiInput.vue` (text input with token chrome). |

### 2.5 Overlays

| Primitive | Use |
| --- | --- |
| `<UiDrawer v-model:open="x" title="…" width="md">` | Right-side slide-in panel for contextual editors. Closes on Esc / backdrop / X. Slots: header / default / footer. |
| `<Modal>` | Existing modal — use for confirms, larger forms. |

### 2.6 Theme

| Primitive | Use |
| --- | --- |
| `<ThemeToggleFab>` | Floating bottom-right toggle (mounted in `default.vue`). |
| `useTheme()` | Composable: returns `theme` ref + `toggleTheme()` + `setTheme()`. |

### 2.7 Command palette

| Primitive | Use |
| --- | --- |
| `<CommandPalette>` | Cmd+K palette. Mounted once in `default.vue`. Recent commands persist via localStorage; cross-tab sync via the `storage` event. |
| `useCommandPalette()` | `register(...cmds)`, `useScopedCommands(...)`, `setActiveRole(role)`, `open/close/toggle`. |
| Two-key chord nav | `g d` Dashboard · `g l` Listings · `g i` Inquiries · `g t` Tasks · `g o` Operations · `g e` EIS submissions. Skipped while typing or when modifiers are held. |

**Role-aware filtering.** Tag any role-restricted command with `requiresRole: 'admin' | 'manager' | 'agent'` on the `Command` object. The palette filters globally — registration sites no longer need to wrap registrations in role checks. The active tier is mirrored from `useUserRole()` by `plugins/command-palette-actions.client.ts`. Default tier before the profile resolves is `agent` (safest default — admin commands stay hidden until explicitly enabled).

```ts
register({
  id: 'admin.eis-submissions',
  label: 'Open EIS submissions',
  hint: 'g e',
  kind: 'navigate',
  group: 'Admin · Billing & Revenue',
  requiresRole: 'admin', // hidden from agents/managers
  perform: () => router.push('/admin/eis-submissions'),
})
```

---

## 3. Page composition

### 3.1 Admin page template

```vue
<script setup lang="ts">
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiSectionHeader from '~/components/ui/UiSectionHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'My page | Admin' })
</script>

<template>
  <AdminPageShell max-width="7xl">
    <UiPageHeader title="My page" description="One-sentence purpose.">
      <template #actions>
        <button class="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring">
          Primary action
        </button>
      </template>
    </UiPageHeader>

    <!-- KPI strip -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <UiStatCard label="Open" :value="42" tone="primary" />
      <UiStatCard label="Closed" :value="158" tone="success" />
      <!-- … -->
    </div>

    <!-- Content section -->
    <section class="space-y-3">
      <UiSectionHeader title="Recent activity" eyebrow="Last 7d">
        <template #actions>
          <button class="text-xs text-primary hover:underline">View all →</button>
        </template>
      </UiSectionHeader>
      <UiCard padding="none">
        <UiDataTable :columns="cols" :rows="rows" :loading="loading">
          <template #cell-status="{ row }">
            <UiBadge :variant="row.status === 'open' ? 'primary' : 'success'">
              {{ row.status }}
            </UiBadge>
          </template>
        </UiDataTable>
      </UiCard>
    </section>
  </AdminPageShell>
</template>
```

### 3.2 Dashboard template

Use big metric strip → "needs attention" panel → activity feed →
trend chart split. Reference: `app/pages/dashboard.vue` (post-refactor).

### 3.3 Detail page template

`back` link in the header → status block → tabs/sections → primary
content → metadata sidebar (if needed) → activity log.

---

## 4. Tooling

| Command | What it does |
| --- | --- |
| `node scripts/token-sweep.mjs <path>` | Auto-rewrite hard-coded grays / dark variants / legacy palette to tokens. Idempotent. |
| `node scripts/check-design-tokens.mjs` (or `pnpm check:tokens`) | CI guard. Fails on any forbidden hard-coded color. Run before push. |

**Migration pattern for an unconverted page:**
1. Run the sweep on the file: `node scripts/token-sweep.mjs path/to/page.vue`
2. Wrap the page body in `<AdminPageShell>` + `<UiPageHeader>`
3. Replace hand-rolled cards with `<UiCard>`
4. Replace KPI blocks with `<UiStatCard>`
5. Replace tables with `<UiDataTable>`
6. Run the guard: `pnpm check:tokens`

---

## 5. Anti-patterns

**Don't:**
- Hard-code Tailwind grays (`bg-gray-50`, `text-gray-700`) — guard blocks
- Pair `dark:` variants manually (`dark:bg-gray-900`) — use tokens
- Use the legacy palette (`text-black-80`, `bg-blue-20`) — guard blocks
- Use rainbow accents (`bg-orange-100`, `bg-purple-500`, `bg-indigo-50`) — guard blocks; map to `warning` / `primary` / `primary`
- Use raw rings (`ring-amber-100`, `ring-blue-200`, `ring-emerald-300`) — guard blocks; map to `ring-warning/30` / `ring-primary/30` / `ring-success/30`
- Use bespoke `text-2xl font-semibold ...` chains — use `.text-page-title`
- Roll your own card chrome — use `<UiCard>`
- Use raw `<table>` elements — use `<UiDataTable>`
- Skip focus rings on interactive elements — use `.focus-ring`
- Ship animations >320ms — keep motion subtle

**Ring colors (focus + selection rings):**

| Hard-coded | Token |
| --- | --- |
| `ring-blue-100`/`200`/`300` | `ring-primary/30` |
| `ring-blue-500`/`600` | `ring-primary` |
| `ring-red-N` / `ring-rose-N` | `ring-destructive[/30]` |
| `ring-amber-N` / `ring-orange-N` | `ring-warning[/30]` |
| `ring-emerald-N` | `ring-success[/30]` |
| `ring-purple-N` / `ring-indigo-N` | `ring-primary[/30]` |

The CI guard catches all eight color families. Use the matching
semantic token; light shades (50–300) get `/30` opacity, full shades
(400+) use the bare token.

**Do:**
- Compose pages from primitives so the visual language is consistent
- Use semantic colors for status (success/warning/destructive — never raw red/green)
- Use `tabular-nums` for any number a user might compare row-to-row
- Use `<UiSkeleton>` for loading states — never an empty card
- Use `<UiEmptyState>` for empty results — never a bare "No items"

---

## 6. What's next

The foundation primitives ship in this repo at:
- `app/components/ui/Ui*.vue`
- `app/components/admin/shell/Admin*.vue`
- `app/assets/css/tailwind.css` (`@layer components`)

Migration roadmap:
- **Now:** dashboard, admin/eis-submissions, admin/bir-2306, admin/bir-2307, admin/platform-settings refactored
- **Next batches:** listings, contacts, tasks, deals, inquiries, analytics, market intelligence, document drafts
- **Tooling guard:** `pnpm check:tokens` runs in CI on every PR (`.github/workflows/lint.yaml`)

If the migration loses focus, the guard's violation count is the
single source of truth for progress: smaller is better, zero is done.
