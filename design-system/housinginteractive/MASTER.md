# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Housinginteractive
**Generated:** 2026-05-08 11:43:13
**Category:** CRM & Client Management

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#2563EB` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#3B82F6` | `--color-secondary` |
| Accent/CTA | `#059669` | `--color-accent` |
| Background | `#F8FAFC` | `--color-background` |
| Foreground | `#0F172A` | `--color-foreground` |
| Muted | `#F1F5FD` | `--color-muted` |
| Border | `#E4ECFC` | `--color-border` |
| Destructive | `#DC2626` | `--color-destructive` |
| Ring | `#2563EB` | `--color-ring` |

**Color Notes:** Professional blue + deal green

### Typography

- **Heading Font:** Inter
- **Body Font:** Inter
- **Mood:** Professional + Clean hierarchy

### Spacing Variables

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #059669;
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #2563EB;
  border: 2px solid #2563EB;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #F8FAFC;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #2563EB;
  outline: none;
  box-shadow: 0 0 0 3px #2563EB20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Flat Design

**Keywords:** 2D, minimalist, bold colors, no shadows, clean lines, simple shapes, typography-focused, modern, icon-heavy

**Best For:** Web apps, mobile apps, cross-platform, startup MVPs, user-friendly, SaaS, dashboards, corporate

**Key Effects:** No gradients/shadows, simple hover (color/opacity shift), fast loading, clean transitions (150-200ms ease), minimal icons

### Page Pattern

**Pattern Name:** Feature-Rich Showcase + Demo

- **CTA Placement:** Above fold
- **Section Order:** Hero > Features > CTA

---

## Anti-Patterns (Do NOT Use)

- ❌ Excessive decoration
- ❌ Complex shadows
- ❌ 3D effects

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile

---

## Housinginteractive — Project-Specific Implementation

The above sections are the canonical recommendations from
`ui-ux-pro-max`. The sections below pin those recommendations to
this codebase's actual structure: which token names we use, where
the primitives live, and which conventions are enforced by CI.

### Color tokens (shadcn-vue HSL CSS variables)

Defined in `app/assets/css/tailwind.css`. Every color decision MUST
go through these — never raw `bg-blue-500`, `text-emerald-700`,
`ring-amber-200`, etc. CI guard (`pnpm check:tokens`) blocks those.

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
| `border-border`, `border-input`, `ring-ring` | Form chrome |

For tinted backgrounds: `bg-success/10`, `bg-warning/15`, `bg-primary/5`.

### Density anchors

Codified in `app/assets/css/tailwind.css` `:root` per the
"Data-Dense Dashboard" recommendation. Use these CSS vars for
chrome dimensions:

| Var | Value | Use |
| --- | --- | --- |
| `--header-height` | 3.5rem (h-14) | Global navbar |
| `--sidebar-width` | 15rem (w-60) | Expanded sidebar |
| `--sidebar-collapsed` | 4rem (w-16) | Collapsed sidebar |
| `--table-row-height` | 2.25rem (~36px) | Compact data tables |
| `--grid-gap` | 0.75rem (gap-3) | KPI grids |
| `--card-pad` | 1.25rem (p-5) | Standard cards |
| `--card-pad-tight` | 0.75rem (p-3) | Compact cards |

### Semantic typography classes

Defined in `tailwind.css` `@layer components`. Always use these
instead of bespoke `text-2xl font-semibold ...` chains.

| Class | Use |
| --- | --- |
| `.text-page-title` | h1 of a top-level page (~30px on sm+) |
| `.text-section-title` | h2 of a section / card cluster (16px) |
| `.text-card-title` | h3 of a single card (14px) |
| `.text-eyebrow` | Tiny uppercase label above a value (11px) |
| `.text-metric-value` | Big tabular number for KPI cards (24px) |
| `.text-metric-delta` | Small accent number under metrics |
| `.text-body` / `.text-meta` / `.text-caption` | Body / muted / smallest |

### UI primitives (compose, never hand-roll)

Located in `app/components/ui/Ui*.vue` and
`app/components/admin/shell/Admin*.vue`:

| Primitive | Use |
| --- | --- |
| `<AdminPageShell>` | Outer container + access-check fallback |
| `<UiPageHeader>` | h1 + back link + actions slot |
| `<UiSectionHeader>` | h2 + eyebrow + actions slot |
| `<UiCard>` | Surface (variants: surface / elevated / ghost / interactive) |
| `<UiBadge>` | Status pill (6 variants × 3 sizes) |
| `<UiStatCard>` | KPI card with eyebrow / value / delta / tone |
| `<UiDataTable>` | Sticky-header table with sortable columns |
| `<UiSkeleton>` | Shimmer placeholder |
| `<UiEmptyState>` | Centered empty placeholder |
| `<UiTabBar>` | Segmented control (underline / pill variants) |
| `<UiToolbar>` | Filter + action row (sticky-capable) |
| `<UiDrawer>` | Right-side slide-in (Esc / backdrop / X close) |
| `<UiFilterChip>` | Toggleable filter pill with count |
| `<ThemeToggleFab>` | Floating bottom-right theme toggle |

### Tooling

| Command | Purpose |
| --- | --- |
| `pnpm check:tokens` | CI guard: blocks raw colors, paired-dark, legacy palette, raw rings |
| `node scripts/token-sweep.mjs <path>` | Auto-rewrite forbidden patterns into tokens |
| `pnpm typecheck` | Nuxt + vue-tsc typecheck |
| `pnpm test:run` | Vitest run (CI mode) |
| `node scripts/check-design-tokens.mjs` | Same as `pnpm check:tokens` |

### Anti-pattern enforcement

The CI guard (`scripts/check-design-tokens.mjs`) blocks:
- Raw grays (`bg-gray-*`, `text-gray-*`, `border-gray-*`, `divide-gray-*`)
- Paired dark variants (`dark:bg-gray-*`, etc.)
- Brand-blue literals (`bg-blue-50/100/600/700`, `text-blue-600/700/800/900`)
- Semantic literals (`bg-emerald-50/100/800/900`, etc. for amber/rose)
- Rainbow accents (`bg/text/border-orange-*`, `-purple-*`, `-indigo-*`)
- Raw rings (`ring-blue-N`, `ring-amber-N`, `ring-emerald-N`, etc.)
- Legacy HI palette (`text-black-N`, `bg-blue-10/20/40x`)

To bypass for an intentional case, add `// design-tokens-allow` to the line.

### How to invoke the skill

This codebase pins to `ui-ux-pro-max` v2.5.0. Search examples:

```bash
# Get full design system bundle
python3 ~/.claude/skills/ui-ux-pro-max/scripts/search.py \
  "<product> <industry> <keywords>" --design-system -p "Housinginteractive"

# Get UX rules for a category
python3 ~/.claude/skills/ui-ux-pro-max/scripts/search.py \
  "<topic>" --domain ux

# Get page-specific overrides
python3 ~/.claude/skills/ui-ux-pro-max/scripts/search.py \
  "<query>" --design-system --persist -p "Housinginteractive" --page "<page>"
```

Persisted page overrides live at `design-system/housinginteractive/pages/`.
