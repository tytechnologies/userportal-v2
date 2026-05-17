# Design tokens

Every UI surface in this repo uses **shadcn-vue design tokens** — CSS
variables in `app/assets/css/tailwind.css` mapped to Tailwind classes
in `tailwind.config.js`. Dark mode flips them automatically when
`useTheme()` adds `.dark` to `<html>`.

**Never hard-code Tailwind grays or paired `dark:` variants.** The CI
guard (`pnpm check:tokens`) fails the build if you do.

## Available tokens

| Token | Purpose |
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
| `bg-success/15`, `bg-warning/10`, `bg-primary/5` | Subtle tinted surfaces |

## Swap table

When refactoring legacy code, apply this table:

| Hard-coded | Token |
| ---------- | ----- |
| `bg-white dark:bg-gray-900` | `bg-card text-card-foreground` |
| `border-gray-200 dark:border-gray-800` | `border-border` |
| `border-gray-300 dark:border-gray-700` (input) | `border-border` |
| `text-gray-900 dark:text-gray-100` | `text-foreground` |
| `text-gray-700 dark:text-gray-300` | `text-foreground` |
| `text-gray-600 dark:text-gray-400` | `text-muted-foreground` |
| `text-gray-500` / `text-gray-400` | `text-muted-foreground` / `text-muted-foreground/70` |
| `divide-gray-100 dark:divide-gray-800` | `divide-border` |
| `bg-gray-50 dark:bg-gray-900/40` | `bg-muted/40` |
| `bg-blue-600 hover:bg-blue-700 text-white` | `bg-primary text-primary-foreground hover:bg-primary/90` |
| `text-blue-600 dark:text-blue-400` | `text-primary` |
| `focus:border-blue-500 focus:ring-blue-500` | `focus:border-ring focus:ring-ring` |
| `bg-emerald-100 text-emerald-800 dark:…` | `bg-success/15 text-success` |
| `bg-amber-100 text-amber-800 dark:…` | `bg-warning/15 text-warning` |
| `bg-rose-100 text-rose-800 dark:…` | `bg-destructive/15 text-destructive` |
| `bg-blue-100 text-blue-800 dark:…` | `bg-primary/15 text-primary` |
| `bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300` | `bg-muted text-muted-foreground` |
| `hover:bg-gray-50 dark:hover:bg-gray-…` | `hover:bg-accent hover:text-accent-foreground` |

## Reusable shell primitives

For new admin pages, use the shells in `app/components/admin/shell/`:

- `<AdminPageShell>` — outer container + access-check fallback
- `<AdminCard>` — replaces the `rounded-2xl border bg-card p-5` pattern
- `<AdminPageHeader title="…">…description…<template #actions>…</template></AdminPageHeader>`

Reference page: [`app/pages/admin/platform-settings.vue`](../app/pages/admin/platform-settings.vue).

## Tooling

- **Sweep an existing file:** `node scripts/token-sweep.mjs <file>...`
  Idempotent. Re-run after manual edits to catch new patterns.
- **CI guard:** `node scripts/check-design-tokens.mjs` (or `pnpm check:tokens`).
  Fails non-zero on any violation; surface in CI before merge.
- **Floating theme toggle:** `app/components/layout/ThemeToggleFab.vue`
  is mounted in the default layout — visible from every authenticated
  page so dark mode is always one click away.

## Adding a new color or semantic

1. Add the CSS variable to `app/assets/css/tailwind.css` (both light
   and `.dark` blocks).
2. Wire it in `tailwind.config.js` under `theme.extend.colors` using
   the `hsl(var(--name) / <alpha-value>)` format.
3. Use the token; never use the raw HSL value at the call site.

## Allowing a violation

If you have a real reason to hard-code a color (canvas, design-system
preview, third-party widget styling), append `// design-tokens-allow`
to the line. The CI guard skips lines containing that marker.
