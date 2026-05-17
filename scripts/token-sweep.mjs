#!/usr/bin/env node
// scripts/token-sweep.mjs
//
// One-shot rewrite: swaps hard-coded Tailwind grays / dark: variants
// for shadcn-vue design tokens across the listed files. See
// memory/feedback_design_tokens_only.md for the full swap table.
//
// Usage: node scripts/token-sweep.mjs <file> [<file>...]
//
// Idempotent: re-running on an already-swept file is a no-op.

import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Order matters: longer / more-specific patterns first so they win
// against shorter overlapping ones (e.g., the long input chain has to
// be matched before bare `dark:bg-gray-800`).
const SWAPS = [
  // Inputs (longest pattern first)
  [
    /border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800/g,
    'border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring',
  ],
  [
    /border border-gray-300 bg-white px-3 py-1\.5 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900/g,
    'border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring',
  ],
  [
    /border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900/g,
    'border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:ring-1 focus:ring-ring',
  ],

  // Card panels
  [
    /rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900/g,
    'rounded-2xl border border-border bg-card p-5 text-card-foreground',
  ],
  [
    /rounded-2xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900/g,
    'rounded-2xl border border-border bg-card px-4 py-3 text-card-foreground',
  ],
  [
    /rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/g,
    'rounded-2xl border border-border bg-card text-card-foreground',
  ],
  [
    /rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900/g,
    'rounded-xl border border-border bg-card p-5 text-card-foreground',
  ],
  [
    /rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900/g,
    'rounded-lg border border-border bg-card p-3 text-card-foreground',
  ],

  // Header + label colors
  [/text-gray-900 dark:text-gray-100/g, 'text-foreground'],
  [/text-gray-700 dark:text-gray-300/g, 'text-foreground'],
  [/text-gray-700 dark:text-gray-200/g, 'text-foreground'],
  [/text-gray-600 dark:text-gray-400/g, 'text-muted-foreground'],
  [/text-gray-600 dark:text-gray-300/g, 'text-muted-foreground'],
  [/text-gray-500 dark:text-gray-400/g, 'text-muted-foreground'],
  [/text-gray-500 dark:text-gray-500/g, 'text-muted-foreground'],

  // Border / divide
  [/border-gray-200 dark:border-gray-800/g, 'border-border'],
  [/border-gray-200 dark:border-gray-700/g, 'border-border'],
  [/border-gray-300 dark:border-gray-700/g, 'border-border'],
  [/border-gray-300 dark:border-gray-600/g, 'border-border'],
  [/divide-gray-100 dark:divide-gray-800/g, 'divide-border'],
  [/divide-gray-200 dark:divide-gray-800/g, 'divide-border'],

  // Muted backgrounds
  [/bg-gray-50 dark:bg-gray-900\/40/g, 'bg-muted/40'],
  [/bg-gray-50 dark:bg-gray-800\/40/g, 'bg-muted/40'],
  [/bg-gray-50\/50 dark:bg-gray-800\/40/g, 'bg-muted/40'],
  [/bg-gray-50\/60 dark:bg-gray-900\/40/g, 'bg-muted/40'],
  [/bg-gray-50 dark:bg-gray-900/g, 'bg-muted'],
  [/hover:bg-gray-50 dark:hover:bg-gray-900\/40/g, 'hover:bg-accent hover:text-accent-foreground'],
  [/hover:bg-gray-50\/60 dark:hover:bg-gray-900\/40/g, 'hover:bg-accent hover:text-accent-foreground'],
  [/hover:bg-gray-50 dark:hover:bg-gray-800\/40/g, 'hover:bg-accent hover:text-accent-foreground'],
  [/hover:bg-gray-50 dark:hover:bg-gray-800/g, 'hover:bg-accent hover:text-accent-foreground'],

  // Pills (semantic)
  [
    /bg-emerald-100 text-emerald-800 dark:bg-emerald-900\/40 dark:text-emerald-200/g,
    'bg-success/15 text-success',
  ],
  [
    /bg-emerald-100 text-emerald-700 dark:bg-emerald-900\/40 dark:text-emerald-200/g,
    'bg-success/15 text-success',
  ],
  [
    /bg-amber-100 text-amber-800 dark:bg-amber-900\/40 dark:text-amber-200/g,
    'bg-warning/15 text-warning',
  ],
  [
    /bg-amber-100 text-amber-700 dark:bg-amber-900\/40 dark:text-amber-200/g,
    'bg-warning/15 text-warning',
  ],
  [
    /bg-rose-100 text-rose-800 dark:bg-rose-900\/40 dark:text-rose-200/g,
    'bg-destructive/15 text-destructive',
  ],
  [
    /bg-red-100 text-red-800 dark:bg-red-900\/40 dark:text-red-200/g,
    'bg-destructive/15 text-destructive',
  ],
  [
    /bg-red-100 text-red-700 dark:bg-red-900\/40 dark:text-red-300/g,
    'bg-destructive/15 text-destructive',
  ],
  [
    /bg-blue-100 text-blue-800 dark:bg-blue-900\/40 dark:text-blue-200/g,
    'bg-primary/15 text-primary',
  ],
  [
    /bg-blue-100 text-blue-700 dark:bg-blue-900\/40 dark:text-blue-200/g,
    'bg-primary/15 text-primary',
  ],
  [
    /bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300/g,
    'bg-muted text-muted-foreground',
  ],
  [
    /bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400/g,
    'bg-muted text-muted-foreground',
  ],
  [
    /bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300/g,
    'bg-muted text-muted-foreground',
  ],

  // Semantic accent text
  [/text-emerald-700 dark:text-emerald-300/g, 'text-success'],
  [/text-emerald-600 dark:text-emerald-400/g, 'text-success'],
  [/text-amber-800 dark:text-amber-200/g, 'text-warning'],
  [/text-amber-700 dark:text-amber-300/g, 'text-warning'],
  [/text-rose-700 dark:text-rose-300/g, 'text-destructive'],
  [/text-red-700 dark:text-red-300/g, 'text-destructive'],
  [/text-purple-700 dark:text-purple-300/g, 'text-primary'],

  // Buttons
  [
    /rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:opacity-60/g,
    'rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-60',
  ],
  [
    /rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60/g,
    'rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60',
  ],
  [
    /rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60/g,
    'rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60',
  ],
  [
    /rounded-md bg-blue-600 px-2\.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60/g,
    'rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60',
  ],
  [
    /rounded-md bg-blue-600 px-2 py-0\.5 text-\[10px\] font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60/g,
    'rounded-md bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60',
  ],
  [
    /bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700/g,
    'bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90',
  ],
  [/hover:bg-blue-700/g, 'hover:bg-primary/90'],
  [/bg-blue-600/g, 'bg-primary'],

  // Outline buttons / secondary buttons
  [
    /rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200/g,
    'rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-60',
  ],
  [
    /rounded-md border border-gray-200 bg-white px-2\.5 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300/g,
    'rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  ],
  [
    /rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300/g,
    'rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  ],
  [
    /rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/g,
    'rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground',
  ],
  [
    /rounded-md border border-red-300 bg-white px-3 py-1\.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-gray-900 dark:text-red-300/g,
    'rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10',
  ],

  // Links
  [/text-xs text-blue-600 hover:underline dark:text-blue-400/g, 'text-xs text-primary hover:underline'],
  [/text-blue-600 dark:text-blue-400/g, 'text-primary'],
  [/text-xs text-blue-600 underline-offset-2 hover:underline dark:text-blue-400/g, 'text-xs text-primary underline-offset-2 hover:underline'],

  // Selects (smaller pattern after the long input swap)
  [
    /rounded-lg border border-gray-300 bg-white px-2\.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-800/g,
    'rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-foreground',
  ],

  // Pre / code blocks
  [/overflow-x-auto rounded bg-white p-2 text-\[11px\] dark:bg-gray-900/g, 'overflow-x-auto rounded bg-background p-2 text-[11px] text-foreground'],

  // Bare gray text colors that don't have a paired dark: variant:
  // these are the most common after the paired ones are gone.
  // Done LAST so we don't double-substitute inside the longer patterns.
  [/text-gray-500/g, 'text-muted-foreground'],
  [/text-gray-400/g, 'text-muted-foreground/70'],
  [/text-gray-600(?![- ])/g, 'text-muted-foreground'],

  // Hover-only patterns the longer ones missed
  [/dark:bg-gray-900\/40/g, ''],
  [/dark:bg-gray-800\/40/g, ''],

  // ============ v2 patterns ============

  // Segmented control container + inactive button
  [/inline-flex rounded-lg border border-gray-200 p-1 dark:border-gray-700/g, 'inline-flex rounded-lg border border-border p-1'],
  [/text-gray-700 hover:text-gray-900 dark:text-gray-300/g, 'text-foreground hover:text-foreground/80'],

  // Zero-padding cards
  [/rounded-2xl border border-gray-200 bg-white p-0 dark:border-gray-800 dark:bg-gray-900/g, 'rounded-2xl border border-border bg-card p-0 text-card-foreground'],

  // Modal panels (max-w-lg / md / sm)
  [/rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900/g, 'rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-xl'],
  [/rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900/g, 'rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl'],

  // Loading / empty cards
  [/rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-muted-foreground dark:border-gray-800 dark:bg-gray-900/g, 'rounded-2xl border border-border bg-card p-10 text-center text-sm text-muted-foreground'],

  // Inputs with non-blue focus rings (purple / red / amber)
  [/border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 dark:border-gray-700 dark:bg-gray-800/g, 'border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring'],
  [/border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800/g, 'border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50'],
  [/border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-red-500 focus:ring-1 focus:ring-red-500 dark:border-gray-700 dark:bg-gray-800/g, 'border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-destructive focus:ring-1 focus:ring-destructive'],
  [/border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500 dark:border-gray-700 dark:bg-gray-800/g, 'border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-warning focus:ring-1 focus:ring-warning'],
  [/border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800/g, 'border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50'],
  [/border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900/g, 'border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring'],
  [/w-72 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900/g, 'w-72 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring'],

  // Effective-rate dashed display
  [/border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-sm tabular-nums text-gray-700 dark:border-gray-700\s+dark:text-gray-300/g, 'border border-dashed border-border bg-muted/40 px-3 py-2 text-sm tabular-nums text-foreground'],
  [/border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-sm tabular-nums text-gray-700 dark:border-gray-700 dark:text-gray-300/g, 'border border-dashed border-border bg-muted/40 px-3 py-2 text-sm tabular-nums text-foreground'],

  // Semantic callouts
  [/border-emerald-200 bg-emerald-50\/60 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950\/30 dark:text-emerald-200/g, 'border-success/30 bg-success/10 text-success'],
  [/border-red-200 bg-red-50\/60 text-red-900 dark:border-red-900 dark:bg-red-950\/30 dark:text-red-200/g, 'border-destructive/30 bg-destructive/10 text-destructive'],

  // Pill alts (orange / purple)
  [/bg-orange-100 text-orange-800 dark:bg-orange-900\/40 dark:text-orange-200/g, 'bg-warning/15 text-warning'],
  [/bg-purple-100 text-purple-800 dark:bg-purple-900\/40 dark:text-purple-200/g, 'bg-primary/15 text-primary'],

  // Tab bar / divider lines
  [/border-b border-gray-100 px-4 py-3 dark:border-gray-800/g, 'border-b border-border px-4 py-3'],
  [/border-t border-gray-100 pt-4/g, 'border-t border-border pt-4'],
  [/border border-gray-100 px-3 py-2 dark:border-gray-800/g, 'border border-border px-3 py-2'],

  // Small inline badge
  [/bg-gray-100 px-1 text-\[10px\] text-muted-foreground dark:bg-gray-800 dark:text-muted-foreground\/70/g, 'bg-muted px-1 text-[10px] text-muted-foreground'],

  // Warning text link
  [/text-xs text-amber-700 hover:underline dark:text-amber-400/g, 'text-xs text-warning hover:underline'],

  // Banner backgrounds
  [/border border-gray-200 bg-gray-50\/60 p-3 text-xs text-muted-foreground dark:border-gray-800\s*/g, 'border border-border bg-muted/40 p-3 text-xs text-muted-foreground '],
  [/bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950\/40 dark:text-amber-200/g, 'bg-warning/10 px-3 py-2 text-xs text-warning'],

  // Pill alts (gray with muted text)
  [/bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-muted-foreground\/70/g, 'bg-muted text-muted-foreground'],
  [/bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-muted-foreground/g, 'bg-muted text-muted-foreground'],

  // Toolbar / segmented inactive button
  [/border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300/g, 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground'],

  // Destructive outline button
  [/inline-flex items-center rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 shadow hover:bg-red-50 dark:border-red-900 dark:bg-gray-900 dark:text-red-300 disabled:opacity-60/g, 'inline-flex items-center rounded-lg border border-destructive/40 bg-background px-3 py-2 text-sm font-semibold text-destructive shadow hover:bg-destructive/10 disabled:opacity-60'],

  // Primary pill small (uppercase)
  [/rounded-full bg-blue-100 px-1\.5 py-0\.5 text-\[10px\] font-semibold uppercase text-blue-800 dark:bg-blue-900\/40 dark:text-blue-200/g, 'rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary'],

  // Highlight row (selection)
  [/bg-blue-50\/30 dark:bg-blue-950\/20/g, 'bg-primary/5'],

  // Inline-edit small inputs
  [/border border-gray-300 bg-white px-2 py-1\.5 text-xs dark:border-gray-700 dark:bg-gray-800/g, 'border border-border bg-background px-2 py-1.5 text-xs text-foreground'],

  // Bare divider classes (after the longer paired patterns swept)
  [/divide-y divide-gray-200 text-sm dark:divide-gray-800/g, 'divide-y divide-border text-sm'],
  [/border-gray-300/g, 'border-border'],
  [/border-gray-100/g, 'border-border'],

  // Anywhere a stray dark:hover or dark:bg snuck through: clean up the
  // residue token left over from earlier swaps where the pair partner
  // was already removed.
  [/hover:bg-gray-50/g, 'hover:bg-accent hover:text-accent-foreground'],

  // Fix v2 sweep bug: bg-gray-50/60 (with opacity suffix) was matched
  // by `bg-gray-50` first and produced `bg-muted/50/60`. Fix both
  // forwards and the broken result.
  [/bg-muted\/50\/60/g, 'bg-muted/40'],
  [/bg-gray-50\/60/g, 'bg-muted/40'],

  // Stat-card backgrounds (semantic-tinted panels)
  [/rounded-2xl border border-amber-200 bg-amber-50\/60 p-4 dark:border-amber-900 dark:bg-amber-950\/30/g, 'rounded-2xl border border-warning/30 bg-warning/10 p-4'],
  [/rounded-2xl border border-emerald-200 bg-emerald-50\/60 p-4 dark:border-emerald-900 dark:bg-emerald-950\/30/g, 'rounded-2xl border border-success/30 bg-success/10 p-4'],
  [/rounded-2xl border border-rose-200 bg-rose-50\/60 p-4 dark:border-rose-900 dark:bg-rose-950\/30/g, 'rounded-2xl border border-destructive/30 bg-destructive/10 p-4'],
  [/rounded-2xl border border-blue-200 bg-blue-50\/60 p-4 dark:border-blue-900 dark:bg-blue-950\/30/g, 'rounded-2xl border border-primary/30 bg-primary/10 p-4'],

  // Stat-card text (label + value)
  [/text-xs font-medium text-amber-800 dark:text-amber-300/g, 'text-xs font-medium text-warning'],
  [/text-xs font-medium text-blue-800 dark:text-blue-300/g, 'text-xs font-medium text-primary'],
  [/text-xs font-medium text-emerald-800 dark:text-emerald-300/g, 'text-xs font-medium text-success'],
  [/text-xs font-medium text-rose-800 dark:text-rose-300/g, 'text-xs font-medium text-destructive'],
  [/text-xs text-blue-700 dark:text-blue-400/g, 'text-xs text-primary'],
  [/text-xs text-emerald-700 dark:text-emerald-400/g, 'text-xs text-success'],
  [/text-xs text-amber-700 dark:text-amber-400/g, 'text-xs text-warning'],
  [/text-xs text-rose-700 dark:text-rose-400/g, 'text-xs text-destructive'],
  [/text-xs text-blue-800 dark:text-blue-300/g, 'text-xs text-primary'],
  [/mt-1 text-xl font-semibold tabular-nums text-amber-900 dark:text-amber-100/g, 'mt-1 text-xl font-semibold tabular-nums text-warning'],
  [/mt-1 text-xl font-semibold tabular-nums text-blue-900 dark:text-blue-100/g, 'mt-1 text-xl font-semibold tabular-nums text-primary'],
  [/mt-1 text-xl font-semibold tabular-nums text-emerald-900 dark:text-emerald-100/g, 'mt-1 text-xl font-semibold tabular-nums text-success'],
  [/mt-1 text-xl font-semibold tabular-nums text-rose-900 dark:text-rose-100/g, 'mt-1 text-xl font-semibold tabular-nums text-destructive'],
  [/mt-1 text-xl font-semibold text-amber-900 dark:text-amber-100/g, 'mt-1 text-xl font-semibold text-warning'],
  [/mt-1 text-xl font-semibold text-blue-900 dark:text-blue-100/g, 'mt-1 text-xl font-semibold text-primary'],
  [/mt-1 text-xl font-semibold text-emerald-900 dark:text-emerald-100/g, 'mt-1 text-xl font-semibold text-success'],
  [/mt-1 text-lg font-semibold text-emerald-900 dark:text-emerald-100/g, 'mt-1 text-lg font-semibold text-success'],
  [/mt-1 text-lg font-semibold text-red-900 dark:text-red-100/g, 'mt-1 text-lg font-semibold text-destructive'],

  // Segmented control: inactive pill option
  [/'bg-muted text-gray-600 hover:bg-gray-200'/g, "'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'"],
  [/bg-muted text-gray-600 /g, 'bg-muted text-muted-foreground '],

  // Banner buttons leftover with bg-white after the longer pattern
  [/inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground\s+dark:text-foreground/g, 'inline-flex items-center rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground'],

  // Misc gov-docs page: bare bordered selects with indigo focus ring
  [/rounded-md border border-gray-200 px-3 py-1\.5 text-sm focus:border-indigo-400 focus:outline-none/g, 'rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none'],
  [/rounded-md border border-gray-200 px-3 py-1\.5 text-xs text-gray-600 hover:bg-accent hover:text-accent-foreground/g, 'rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground'],
  [/rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-accent hover:text-accent-foreground/g, 'rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground'],
  [/cursor-pointer rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-accent hover:text-accent-foreground/g, 'cursor-pointer rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground'],
  [/sm:col-span-2 rounded-md border border-gray-200 px-3 py-1\.5 text-sm focus:border-indigo-400 focus:outline-none/g, 'sm:col-span-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none'],
  [/divide-y divide-gray-100 rounded-xl border border-border bg-white shadow-sm/g, 'divide-y divide-border rounded-xl border border-border bg-card shadow-sm'],

  // Selection card border
  [/border-gray-200 bg-muted\/50\/60\s+/g, 'border-border bg-muted/40 '],

  // Sub-card panels
  [/rounded-2xl border border-gray-200 bg-muted\/50\/60 p-4\s+\/30/g, 'rounded-2xl border border-border bg-muted/40 p-4'],

  // Misc emerald banner
  [/mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950\/40\s+/g, 'mt-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success '],

  // Bank-recon blue input + ring
  [/border border-blue-300 bg-white px-3 py-2 font-mono text-xs shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-blue-800\s*/g, 'border border-primary/40 bg-background px-3 py-2 font-mono text-xs text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring '],
  [/text-xs text-blue-800 dark:text-blue-300/g, 'text-xs text-primary'],
  [/mt-1 text-xs text-blue-800 dark:text-blue-300/g, 'mt-1 text-xs text-primary'],

  // Borders on grid + list rows
  [/rounded border border-gray-200 px-2 py-1\.5 text-xs\s+/g, 'rounded border border-border px-2 py-1.5 text-xs '],
  [/rounded-lg border border-gray-200 p-3\s+/g, 'rounded-lg border border-border p-3 '],
  [/grid grid-cols-3 gap-3 rounded-lg border border-gray-200 p-3 text-sm\s*/g, 'grid grid-cols-3 gap-3 rounded-lg border border-border p-3 text-sm '],
  [/flex items-start justify-between gap-3 rounded-lg border border-gray-200 p-3\s*/g, 'flex items-start justify-between gap-3 rounded-lg border border-border p-3 '],

  // ============ v4 — patterns surfaced by check:tokens ============

  // Stat-card variants left over (border + bg only, no `dark:` after sweep)
  [/rounded-2xl border border-blue-200 bg-blue-50\/60 p-4\s*/g, 'rounded-2xl border border-primary/30 bg-primary/10 p-4 '],
  [/rounded-2xl border border-success\/30 bg-emerald-50\/60 p-4\s*/g, 'rounded-2xl border border-success/30 bg-success/10 p-4 '],
  [/rounded-2xl border border-success\/30 bg-amber-50\/60 p-4\s*/g, 'rounded-2xl border border-warning/30 bg-warning/10 p-4 '],

  // Bare label text after sweep stripped pair
  [/text-xs font-medium text-emerald-800/g, 'text-xs font-medium text-success'],
  [/text-xs font-medium text-amber-800/g, 'text-xs font-medium text-warning'],
  [/text-xs font-medium text-blue-800/g, 'text-xs font-medium text-primary'],
  [/text-xs font-medium text-rose-800/g, 'text-xs font-medium text-destructive'],

  // Bare blue link
  [/text-blue-600 hover:underline/g, 'text-primary hover:underline'],
  [/mt-3 text-primary hover:underline/g, 'mt-3 text-primary hover:underline'],

  // ============ v5 — final straggler patterns ============

  // Bank-recon stat cards
  [/text-xs font-medium text-rose-800/g, 'text-xs font-medium text-destructive'],

  // Bank-recon "next steps" callout
  [/rounded-2xl border border-blue-200 bg-blue-50\/40 p-5\s*/g, 'rounded-2xl border border-primary/30 bg-primary/10 p-5 '],
  [/text-base font-semibold text-blue-900/g, 'text-base font-semibold text-primary'],

  // Document-templates / government-docs status pills (no dark: pair)
  [/'bg-emerald-50 text-emerald-700'/g, "'bg-success/15 text-success'"],
  [/'bg-amber-50 text-amber-700'/g, "'bg-warning/15 text-warning'"],
  [/'bg-emerald-100 text-emerald-700'/g, "'bg-success/15 text-success'"],
  [/'bg-emerald-100 text-emerald-800'/g, "'bg-success/15 text-success'"],
  [/'bg-amber-100 text-amber-700'/g, "'bg-warning/15 text-warning'"],
  [/'bg-blue-100 text-blue-700'/g, "'bg-primary/15 text-primary'"],
  [/'bg-rose-100 text-rose-700'/g, "'bg-destructive/15 text-destructive'"],

  // Trailing text-amber-700 (no dark pair)
  [/text-xs text-amber-700\b/g, 'text-xs text-warning'],

  // Hover blue link
  [/hover:text-blue-700/g, 'hover:text-primary'],

  // Underline blue link
  [/text-blue-600 underline/g, 'text-primary underline'],

  // Warning banner (border + bg + text)
  [/rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-700/g, 'rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning'],

  // ============ v3 cleanup ============

  // Fix more sweep bugs
  [/bg-muted\/50\/50/g, 'bg-muted/40'],
  [/bg-muted\/50\/40/g, 'bg-muted/40'],

  // Indigo pill (replaces with primary as we don't have a separate
  // "info" color)
  [/bg-indigo-100 text-indigo-800 dark:bg-indigo-900\/40 dark:text-indigo-200/g, 'bg-primary/15 text-primary'],

  // Orange tinted text (use warning)
  [/text-orange-700 dark:text-orange-300 font-medium/g, 'text-warning font-medium'],
  [/text-orange-700 dark:text-orange-300/g, 'text-warning'],
  [/text-orange-700 dark:text-orange-400/g, 'text-warning'],

  // Link variants
  [/text-sm text-blue-600 hover:underline dark:text-blue-400/g, 'text-sm text-primary hover:underline'],
  [/text-blue-600 hover:underline dark:text-blue-400/g, 'text-primary hover:underline'],
  [/text-xs text-indigo-600 hover:underline dark:text-indigo-400/g, 'text-xs text-primary hover:underline'],
  [/text-xs text-emerald-700 hover:underline dark:text-emerald-400/g, 'text-xs text-success hover:underline'],
  [/text-xs text-red-600 hover:underline dark:text-red-400 disabled:opacity-30/g, 'text-xs text-destructive hover:underline disabled:opacity-30'],
  [/text-xs text-red-600 hover:underline dark:text-red-400/g, 'text-xs text-destructive hover:underline'],

  // Long info banner (blue 50)
  [/mt-3 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:bg-blue-950\/40\s*/g, 'mt-3 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary '],

  // Long warning banner with all the dark: parts
  [/rounded-2xl border border-amber-200 bg-amber-50\/60 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950\/30\s*/g, 'rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning '],

  // Operations page "Back to admin" button (no paired dark: in original)
  [/rounded-md border border-gray-200 bg-white px-3 py-1\.5 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground/g, 'rounded-md border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground'],

  // Gov-docs filter: bare-text-gray-600 leftover
  [/rounded-md border border-gray-200 px-3 py-1\.5 text-sm text-gray-600 hover:bg-accent hover:text-accent-foreground/g, 'rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground'],

  // Doc-template inputs (blue-20 = the legacy palette key, not blue-200)
  [/mt-1 w-full rounded-md border border-gray-200 px-2 py-1\.5 font-mono text-sm focus:border-blue-20 focus:outline-none focus:ring-1 focus:ring-blue-20/g, 'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring'],
  [/mt-1 w-full rounded-md border border-gray-200 px-2 py-1\.5 text-sm focus:border-blue-20 focus:outline-none focus:ring-1 focus:ring-blue-20/g, 'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring'],
  [/rounded-md border border-gray-200 px-2 py-1\.5 text-xs(?!\s*"|\s+text)/g, 'rounded-md border border-border px-2 py-1.5 text-xs'],
  [/divide-y divide-gray-100 rounded-xl border border-border bg-white/g, 'divide-y divide-border rounded-xl border border-border bg-card'],
  [/rounded-xl border border-dashed border-gray-200 bg-white p-10 text-center text-sm text-muted-foreground/g, 'rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground'],

  // Sticky save bar
  [/sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-gray-200 bg-white\/90 px-4 py-3 backdrop-blur\s+\/90 sm:-mx-6 lg:-mx-8/g, 'sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-card/90 px-4 py-3 backdrop-blur sm:-mx-6 lg:-mx-8'],
  [/sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-gray-200 bg-white\/90 px-4 py-3 backdrop-blur\s+\/90 sm:-mx-6 lg:-mx-8/g, 'sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-card/90 px-4 py-3 backdrop-blur sm:-mx-6 lg:-mx-8'],

  // Active row highlight
  [/border-emerald-300 bg-emerald-50\/40 dark:border-emerald-800/g, 'border-success/40 bg-success/10'],

  // dd cleanup: text-foreground dark:text-foreground (redundant)
  [/text-foreground dark:text-foreground/g, 'text-foreground'],

  // Partial border swaps left over
  [/border-emerald-200(?!\/30)/g, 'border-success/30'],
  [/border-amber-300/g, 'border-warning/40'],
  [/border-amber-200(?!\/30)/g, 'border-warning/30'],

  // Red-900 stat value
  [/mt-1 text-xl font-semibold tabular-nums text-red-900 dark:text-red-100/g, 'mt-1 text-xl font-semibold tabular-nums text-destructive'],

  // Junky leftovers like "border-amber-300 dark:border-amber-800"
  [/dark:border-amber-800/g, ''],

  // Final pass: bare gray-* (only fires if not already inside a swapped longer string)
  [/text-gray-700/g, 'text-foreground'],
  [/text-gray-300/g, 'text-foreground'],
  [/text-gray-200/g, 'text-foreground'],
  [/text-gray-800/g, 'text-foreground'],
  [/text-gray-900/g, 'text-foreground'],
  [/bg-gray-100/g, 'bg-muted'],
  [/bg-gray-50/g, 'bg-muted/50'],
  [/dark:bg-gray-800/g, ''],
  [/dark:bg-gray-900/g, ''],
  [/dark:border-gray-700/g, ''],
  [/dark:border-gray-800/g, ''],
  [/dark:text-gray-300/g, ''],
  [/dark:text-gray-200/g, ''],
  [/dark:text-gray-400/g, ''],
  [/dark:divide-gray-800/g, ''],
  [/dark:bg-emerald-900\/40/g, ''],
  [/dark:text-emerald-200/g, ''],
  [/dark:bg-rose-900\/40/g, ''],
  [/dark:text-rose-300/g, ''],
  [/dark:bg-blue-900\/40/g, ''],
  [/dark:text-blue-200/g, ''],
  [/dark:bg-amber-900\/40/g, ''],
  [/dark:text-amber-200/g, ''],
  [/dark:bg-amber-950\/40/g, ''],
  [/dark:bg-blue-950\/30/g, ''],
  [/dark:text-amber-400/g, ''],
  [/dark:text-emerald-300/g, ''],
  [/dark:bg-red-900\/40/g, ''],
  [/dark:text-red-200/g, ''],
  [/dark:text-red-300/g, ''],
  [/dark:border-red-900/g, ''],
  [/dark:border-emerald-900/g, ''],
  [/dark:bg-emerald-950\/30/g, ''],
  [/dark:bg-red-950\/30/g, ''],
  [/dark:border-blue-900/g, ''],
  [/dark:bg-orange-900\/40/g, ''],
  [/dark:text-orange-200/g, ''],
  [/dark:bg-purple-900\/40/g, ''],
  [/dark:text-purple-200/g, ''],
  [/dark:text-purple-300/g, ''],
  [/dark:hover:bg-gray-800/g, ''],
  [/dark:hover:bg-gray-900\/40/g, ''],

  // ============ v6 — bare semantic patterns (no dark: pair) ============
  // Run very last so the paired patterns above have already swept.

  // Borders + grays
  [/border-gray-200/g, 'border-border'],
  [/border-gray-100/g, 'border-border'],
  [/border-gray-300/g, 'border-border'],
  [/border-gray-700/g, 'border-border'],
  [/border-gray-800/g, 'border-border'],
  [/divide-gray-100/g, 'divide-border'],
  [/divide-gray-200/g, 'divide-border'],
  [/divide-gray-800/g, 'divide-border'],

  // Bare gray text (in addition to the paired ones above)
  [/\btext-gray-600(?!\d)/g, 'text-muted-foreground'],
  [/\btext-gray-500(?!\d)/g, 'text-muted-foreground'],
  [/\btext-gray-400(?!\d)/g, 'text-muted-foreground/70'],
  [/\btext-gray-300(?!\d)/g, 'text-muted-foreground'],
  [/\btext-gray-700(?!\d)/g, 'text-foreground'],
  [/\btext-gray-800(?!\d)/g, 'text-foreground'],
  [/\btext-gray-900(?!\d)/g, 'text-foreground'],

  // Bare gray backgrounds
  [/\bbg-gray-50(?!\d)/g, 'bg-muted/50'],
  [/\bbg-gray-100(?!\d)/g, 'bg-muted'],
  [/\bbg-gray-200(?!\d)/g, 'bg-muted'],
  [/\bbg-gray-300(?!\d)/g, 'bg-muted'],
  [/\bbg-gray-400(?!\d)/g, 'bg-muted'],
  [/\bbg-gray-500(?!\d)/g, 'bg-muted-foreground'],
  [/\bbg-gray-600(?!\d)/g, 'bg-muted-foreground'],
  [/\bbg-gray-700(?!\d)/g, 'bg-muted'],
  [/\bbg-gray-800(?!\d)/g, 'bg-muted'],
  [/\bbg-gray-900(?!\d)/g, 'bg-muted'],

  // Border grays missing from earlier list
  [/\bborder-gray-400(?!\d)/g, 'border-border'],
  [/\bborder-gray-500(?!\d)/g, 'border-border'],
  [/\bborder-gray-600(?!\d)/g, 'border-border'],
  [/\bborder-gray-900(?!\d)/g, 'border-border'],

  // Stragglers: dark:bg-gray-800/40 and similar → drop entirely
  [/dark:bg-gray-800\/(\d+)/g, ''],
  [/dark:bg-gray-900\/(\d+)/g, ''],
  [/dark:border-gray-(700|800)/g, ''],

  // Bare semantic backgrounds
  [/\bbg-emerald-50(?!\d)/g, 'bg-success/10'],
  [/\bbg-emerald-100(?!\d)/g, 'bg-success/15'],
  [/\bbg-amber-50(?!\d)/g, 'bg-warning/10'],
  [/\bbg-amber-100(?!\d)/g, 'bg-warning/15'],
  [/\bbg-rose-50(?!\d)/g, 'bg-destructive/10'],
  [/\bbg-rose-100(?!\d)/g, 'bg-destructive/15'],
  [/\bbg-red-50(?!\d)/g, 'bg-destructive/10'],
  [/\bbg-red-100(?!\d)/g, 'bg-destructive/15'],
  [/\bbg-blue-50(?!\d)/g, 'bg-primary/10'],
  [/\bbg-blue-100(?!\d)/g, 'bg-primary/15'],

  // Bare semantic text
  [/text-emerald-(700|800|900)/g, 'text-success'],
  [/text-amber-(700|800|900)/g, 'text-warning'],
  [/text-rose-(700|800|900)/g, 'text-destructive'],
  [/text-red-(700|800|900)/g, 'text-destructive'],
  [/text-blue-(600|700|800|900)/g, 'text-primary'],

  // Bare borders for semantic
  [/border-emerald-(100|200|300)/g, 'border-success/30'],
  [/border-amber-(100|200|300)/g, 'border-warning/30'],
  [/border-rose-(100|200|300)/g, 'border-destructive/30'],
  [/border-red-(100|200|300)/g, 'border-destructive/30'],
  [/border-blue-(100|200|300)/g, 'border-primary/30'],

  // Orange / purple / indigo — the rainbow-UI anti-pattern. Map to
  // the four semantic tokens (primary / success / warning / destructive).
  // Indigo is a brand-blue cousin → primary. Purple → primary too
  // (used for accents in our codebase, never for warnings or success).
  // Orange is a warning cousin → warning.
  [/\bbg-orange-(50|100|200)\b/g, 'bg-warning/10'],
  [/\bbg-orange-(300|400|500|600)\b/g, 'bg-warning'],
  [/\bbg-orange-(700|800|900)\b/g, 'bg-warning/90'],
  [/\btext-orange-(50|100|200|300)\b/g, 'text-warning/80'],
  [/\btext-orange-(400|500|600|700|800|900)\b/g, 'text-warning'],
  [/\bborder-orange-(50|100|200|300|400|500|600|700|800|900)\b/g, 'border-warning/30'],
  [/\bbg-purple-(50|100|200)\b/g, 'bg-primary/10'],
  [/\bbg-purple-(300|400|500|600)\b/g, 'bg-primary'],
  [/\bbg-purple-(700|800|900)\b/g, 'bg-primary/90'],
  [/\btext-purple-(50|100|200|300)\b/g, 'text-primary/80'],
  [/\btext-purple-(400|500|600|700|800|900)\b/g, 'text-primary'],
  [/\bborder-purple-(50|100|200|300|400|500|600|700|800|900)\b/g, 'border-primary/30'],
  [/\bbg-indigo-(50|100|200)\b/g, 'bg-primary/10'],
  [/\bbg-indigo-(300|400|500|600)\b/g, 'bg-primary'],
  [/\bbg-indigo-(700|800|900)\b/g, 'bg-primary/90'],
  [/\btext-indigo-(50|100|200|300)\b/g, 'text-primary/80'],
  [/\btext-indigo-(400|500|600|700|800|900)\b/g, 'text-primary'],
  [/\bborder-indigo-(50|100|200|300)\b/g, 'border-primary/30'],
  [/\bborder-indigo-(400|500|600|700|800|900)\b/g, 'border-primary'],

  // Raw ring colors → semantic tokens. Ring shows up around badges,
  // selected pills, and focused inputs — same color taxonomy as
  // their bg/text counterparts: blue → primary, red/rose → destructive,
  // amber/orange → warning, emerald/green → success, purple/indigo → primary.
  [/\bring-blue-(50|100|200|300)\b/g, 'ring-primary/30'],
  [/\bring-blue-(400|500|600|700|800|900)\b/g, 'ring-primary'],
  [/\bring-red-(50|100|200|300)\b/g, 'ring-destructive/30'],
  [/\bring-red-(400|500|600|700|800|900)\b/g, 'ring-destructive'],
  [/\bring-rose-(50|100|200|300)\b/g, 'ring-destructive/30'],
  [/\bring-rose-(400|500|600|700|800|900)\b/g, 'ring-destructive'],
  [/\bring-amber-(50|100|200|300)\b/g, 'ring-warning/30'],
  [/\bring-amber-(400|500|600|700|800|900)\b/g, 'ring-warning'],
  [/\bring-orange-(50|100|200|300)\b/g, 'ring-warning/30'],
  [/\bring-orange-(400|500|600|700|800|900)\b/g, 'ring-warning'],
  [/\bring-emerald-(50|100|200|300)\b/g, 'ring-success/30'],
  [/\bring-emerald-(400|500|600|700|800|900)\b/g, 'ring-success'],
  [/\bring-purple-(50|100|200|300)\b/g, 'ring-primary/30'],
  [/\bring-purple-(400|500|600|700|800|900)\b/g, 'ring-primary'],
  [/\bring-indigo-(50|100|200|300)\b/g, 'ring-primary/30'],
  [/\bring-indigo-(400|500|600|700|800|900)\b/g, 'ring-primary'],

  // Buttons: blue accents
  [/hover:bg-blue-(50|100)/g, 'hover:bg-primary/10'],

  // Bare patterns with opacity suffix that the v6 negative lookahead skipped.
  // Match bg-emerald-50/40 etc. and rewrite to bg-success/X (preserve the
  // opacity suffix where it makes sense, otherwise pick a default).
  [/bg-emerald-50\/(\d+)/g, 'bg-success/10'],
  [/bg-emerald-100\/(\d+)/g, 'bg-success/15'],
  [/bg-amber-50\/(\d+)/g, 'bg-warning/10'],
  [/bg-amber-100\/(\d+)/g, 'bg-warning/15'],
  [/bg-rose-50\/(\d+)/g, 'bg-destructive/10'],
  [/bg-rose-100\/(\d+)/g, 'bg-destructive/15'],
  [/bg-red-50\/(\d+)/g, 'bg-destructive/10'],
  [/bg-red-100\/(\d+)/g, 'bg-destructive/15'],
  [/bg-blue-50\/(\d+)/g, 'bg-primary/10'],
  [/bg-blue-100\/(\d+)/g, 'bg-primary/15'],

  // Bare gray with opacity suffix (e.g. text-gray-400/70)
  [/text-gray-400\/(\d+)/g, 'text-muted-foreground/70'],
  [/text-gray-500\/(\d+)/g, 'text-muted-foreground'],
  [/text-gray-600\/(\d+)/g, 'text-muted-foreground'],
  [/bg-gray-50\/(\d+)/g, 'bg-muted/40'],
  [/bg-gray-100\/(\d+)/g, 'bg-muted'],

  // Final cleanup of the negative-lookahead misses
  [/text-gray-400/g, 'text-muted-foreground/70'],
  [/text-gray-500/g, 'text-muted-foreground'],
  [/text-gray-600/g, 'text-muted-foreground'],
  [/text-gray-300/g, 'text-muted-foreground'],
  [/text-gray-700/g, 'text-foreground'],
  [/text-gray-800/g, 'text-foreground'],
  [/text-gray-900/g, 'text-foreground'],
  [/bg-gray-50/g, 'bg-muted/50'],
  [/bg-gray-100/g, 'bg-muted'],
  [/bg-gray-200/g, 'bg-muted'],
  [/bg-gray-700/g, 'bg-muted'],
  [/bg-gray-800/g, 'bg-muted'],
  [/bg-gray-900/g, 'bg-muted'],

  // Catch any lingering dark: gray patterns
  [/dark:bg-gray-\d+(?:\/\d+)?/g, ''],
  [/dark:text-gray-\d+(?:\/\d+)?/g, ''],
  [/dark:border-gray-\d+(?:\/\d+)?/g, ''],
  [/dark:divide-gray-\d+(?:\/\d+)?/g, ''],
  [/dark:hover:bg-gray-\d+(?:\/\d+)?/g, ''],
  [/dark:hover:text-gray-\d+(?:\/\d+)?/g, ''],

  // Stroke / fill / ring grays (less common but exist)
  [/\bstroke-gray-(\d+)(?!\d)/g, 'stroke-muted-foreground'],
  [/\bfill-gray-(\d+)(?!\d)/g, 'fill-muted-foreground'],
  [/\bring-gray-(\d+)(?!\d)/g, 'ring-border'],

  // Solid blue button / accent
  [/\bbg-blue-700(?!\d)/g, 'bg-primary/90'],

  // ============ v9 — semantic typography normalization ============
  // Lift bespoke h1/h2 chains into the .text-* utility classes so the
  // visual hierarchy stays uniform when typography rules evolve.

  // h1 page titles — 17 admin pages still hand-rolled the chain.
  [/<h1 class="text-2xl font-semibold text-foreground">/g, '<h1 class="text-page-title">'],
  [/<h1 class="text-xl font-semibold text-foreground">/g, '<h1 class="text-page-title">'],
  // KPI / stat values — `text-xl` and `text-2xl` variants both lift to
  // .text-metric-value (same effective styling, single source of truth).
  [/text-xl font-semibold tabular-nums text-foreground/g, 'text-metric-value'],
  [/text-xl font-semibold tabular-nums(?!\b)/g, 'text-metric-value'],
  [/text-2xl font-semibold tabular-nums text-foreground/g, 'text-metric-value'],

  // Redundant /100 opacity suffix on tinted utilities — same as no suffix.
  [/bg-success\/100\b/g, 'bg-success'],
  [/bg-primary\/100\b/g, 'bg-primary'],
  [/bg-warning\/100\b/g, 'bg-warning'],
  [/bg-destructive\/100\b/g, 'bg-destructive'],

  // ============ v7 — sweep residue / focus-ring stragglers ============

  // Double-suffix bugs (v6 sometimes produced bg-destructive/10/60 etc.)
  [/bg-destructive\/10\/(\d+)/g, 'bg-destructive/10'],
  [/bg-destructive\/15\/(\d+)/g, 'bg-destructive/15'],
  [/bg-success\/10\/(\d+)/g, 'bg-success/10'],
  [/bg-success\/15\/(\d+)/g, 'bg-success/15'],
  [/bg-warning\/10\/(\d+)/g, 'bg-warning/10'],
  [/bg-warning\/15\/(\d+)/g, 'bg-warning/15'],
  [/bg-primary\/10\/(\d+)/g, 'bg-primary/10'],
  [/bg-primary\/15\/(\d+)/g, 'bg-primary/15'],

  // Inputs with focus:ring-blue-500 but no bg-white pair (sweep missed
  // earlier because the longer pattern required gray-300+bg-white).
  [/focus:border-blue-500 focus:ring-1 focus:ring-blue-500/g, 'focus:border-ring focus:ring-1 focus:ring-ring'],
  [/focus:ring-blue-500/g, 'focus:ring-ring'],
  [/focus:border-blue-500/g, 'focus:border-ring'],

  // bg-white leftover in input chains where the outer card pattern
  // didn't match. Map to bg-background (the input-surface token).
  [/border border-border bg-white/g, 'border border-border bg-background'],
  [/rounded-md border border-border bg-white/g, 'rounded-md border border-border bg-background'],
  [/bg-white px-2 py-1\.5 text-xs/g, 'bg-background px-2 py-1.5 text-xs text-foreground'],

  // Modal/card wrappers that were `border bg-white` after sweep
  [/rounded-2xl border bg-white p-5/g, 'rounded-2xl border border-border bg-card p-5 text-card-foreground'],
  [/rounded-xl border bg-white p-5/g, 'rounded-xl border border-border bg-card p-5 text-card-foreground'],
  [/rounded-lg border bg-white p-5/g, 'rounded-lg border border-border bg-card p-5 text-card-foreground'],
  [/rounded-2xl border bg-white p-3/g, 'rounded-2xl border border-border bg-card p-3 text-card-foreground'],

  // Bare bg-white on its own (least common; keep last)
  [/\bbg-white(?![-\/A-Za-z])/g, 'bg-card'],

  // ============ v8 — legacy HI palette ============
  //
  // tailwind.config.js still defines text-black-*, bg-black-*, bg-blue-10/20/40x.
  // These were the pre-shadcn palette. They're valid Tailwind classes
  // (they compile) but they don't adapt to dark mode — they're fixed
  // hex colors. Map them onto semantic tokens.

  // text-black-* (foreground / muted)
  [/\btext-black-80\b/g, 'text-foreground'],
  [/\btext-black-50\b/g, 'text-muted-foreground'],
  [/\btext-black-40\b/g, 'text-muted-foreground/70'],
  [/\btext-black-30\b/g, 'text-muted-foreground/70'],
  [/\btext-black-20\b/g, 'text-muted-foreground/70'],
  [/\btext-black-10\b/g, 'text-muted-foreground/50'],

  // bg-black-* (surface scale)
  [/\bbg-black-2\b/g, 'bg-muted/30'],
  [/\bbg-black-5\b/g, 'bg-muted/50'],
  [/\bbg-black-10\b/g, 'bg-muted'],
  [/\bbg-black-20\b/g, 'bg-muted'],
  [/\bbg-black-30\b/g, 'bg-muted'],
  [/\bbg-black-40\b/g, 'bg-muted'],
  [/\bbg-black-50\b/g, 'bg-muted-foreground'],
  [/\bbg-black-80\b/g, 'bg-foreground'],

  // border-black-* (border scale)
  [/\bborder-black-2\b/g, 'border-border'],
  [/\bborder-black-5\b/g, 'border-border'],
  [/\bborder-black-10\b/g, 'border-border'],
  [/\bborder-black-20\b/g, 'border-border'],
  [/\bborder-black-30\b/g, 'border-border'],
  [/\bborder-black-40\b/g, 'border-border'],
  [/\bborder-black-50\b/g, 'border-border'],
  [/\bborder-black-80\b/g, 'border-foreground'],

  // bg-blue-* (legacy brand)
  // bg-blue-20 is the solid brand blue (matches --primary).
  // bg-blue-10 is the light tint.
  [/\bhover:bg-blue-10\b/g, 'hover:bg-primary/10'],
  [/\bhover:bg-blue-20\b/g, 'hover:bg-primary/90'],
  [/\bhover:bg-blue-401\b/g, 'hover:bg-primary/10'],
  [/\bhover:bg-blue-402\b/g, 'hover:bg-primary/90'],
  [/\bbg-blue-10\b/g, 'bg-primary/10'],
  [/\bbg-blue-20\b/g, 'bg-primary'],
  [/\bbg-blue-401\b/g, 'bg-primary/10'],
  [/\bbg-blue-402\b/g, 'bg-primary/90'],
  [/\bbg-blue-403\b/g, 'bg-primary/60'],
  [/\btext-blue-10\b/g, 'text-primary'],
  [/\btext-blue-20\b/g, 'text-primary'],
  [/\btext-blue-401\b/g, 'text-primary'],
  [/\btext-blue-402\b/g, 'text-primary'],
  [/\btext-blue-403\b/g, 'text-primary'],
  [/\bborder-blue-20\b/g, 'border-primary'],
  [/\bborder-blue-10\b/g, 'border-primary/30'],
]

async function* walk(path) {
  let s
  try {
    s = await stat(path)
  } catch {
    return
  }
  if (s.isFile()) {
    yield path
    return
  }
  if (!s.isDirectory()) return
  const entries = await readdir(path, { withFileTypes: true })
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.nuxt' || e.name === 'dist') continue
    yield* walk(join(path, e.name))
  }
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: node scripts/token-sweep.mjs <file-or-dir> [...]')
  process.exit(2)
}

async function processFile(arg, abs) {
  let src
  try {
    src = await readFile(abs, 'utf8')
  } catch (err) {
    console.error(`skip ${arg}: ${err.message}`)
    return 0
  }
  let next = src
  let changed = 0
  for (const [pat, repl] of SWAPS) {
    const before = next
    next = next.replace(pat, repl)
    if (next !== before) {
      const matches = before.match(pat)
      changed += matches ? matches.length : 0
    }
  }
  if (changed === 0) return 0
  await writeFile(abs, next, 'utf8')
  console.log(`${arg}: ${changed}`)
  return changed
}

let totalChanges = 0
let scanned = 0
for (const arg of args) {
  const root = resolve(process.cwd(), arg)
  for await (const file of walk(root)) {
    if (!file.endsWith('.vue') && !file.endsWith('.ts') && !file.endsWith('.tsx')) continue
    scanned += 1
    const rel = file.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', '')
    totalChanges += await processFile(rel, file)
  }
}

console.log(`\nScanned ${scanned} file(s). Total substitutions: ${totalChanges}`)
