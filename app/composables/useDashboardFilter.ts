// Shared date-range state for the dashboard. Widgets that respect the
// filter (TrendChart, InquiryFunnel — anything counting events in a
// window) read from this composable so a single change re-fetches all
// of them. State-based snapshot widgets (KpiStrip's active listings,
// open tasks, pending shares) intentionally ignore the filter — they
// represent "right now," not "in this window."
//
// Single global instance via module-scoped refs. Vue auto-deduplicates
// on re-import, so every widget reads the same source of truth.

import { computed, ref } from 'vue'

export type RangePreset = '7d' | '30d' | '90d' | 'custom'

const preset = ref<RangePreset>('30d')

// Custom-range inputs. Only consulted when preset === 'custom'. Stored
// as date-only ISO strings (YYYY-MM-DD) so the inputs map cleanly to
// <input type="date">; widgets convert to full timestamps as needed.
const customFrom = ref<string | null>(null)
const customTo = ref<string | null>(null)

function presetDays(p: RangePreset): number {
  switch (p) {
    case '7d':  return 7
    case '30d': return 30
    case '90d': return 90
    case 'custom': return 30 // fallback when custom dates aren't set
  }
}

// Resolved window — what every widget actually queries against. ISO
// strings (timestamptz-friendly) so the server can compare directly.
const fromIso = computed<string>(() => {
  if (preset.value === 'custom' && customFrom.value) {
    return new Date(customFrom.value + 'T00:00:00Z').toISOString()
  }
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - presetDays(preset.value) + 1)
  return d.toISOString()
})

const toIso = computed<string>(() => {
  if (preset.value === 'custom' && customTo.value) {
    return new Date(customTo.value + 'T23:59:59Z').toISOString()
  }
  // Inclusive of today.
  const d = new Date()
  d.setUTCHours(23, 59, 59, 999)
  return d.toISOString()
})

// Derived label for headers / breadcrumbs.
const label = computed<string>(() => {
  if (preset.value === '7d') return 'Last 7 days'
  if (preset.value === '30d') return 'Last 30 days'
  if (preset.value === '90d') return 'Last 90 days'
  if (customFrom.value && customTo.value) {
    const f = new Date(customFrom.value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const t = new Date(customTo.value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `${f} – ${t}`
  }
  return 'Custom range'
})

// Stable identity for watchers — when this string changes, refetch.
// Cheaper than watching two refs; lets each widget useDashboardFilter()
// without subscribing to internals.
const watchKey = computed<string>(() => `${preset.value}|${customFrom.value}|${customTo.value}`)

export function useDashboardFilter() {
  function setPreset(p: RangePreset) {
    preset.value = p
  }
  function setCustom(from: string | null, to: string | null) {
    customFrom.value = from
    customTo.value = to
    preset.value = 'custom'
  }
  function reset() {
    preset.value = '30d'
    customFrom.value = null
    customTo.value = null
  }

  return {
    preset,
    customFrom,
    customTo,
    fromIso,
    toIso,
    label,
    watchKey,
    setPreset,
    setCustom,
    reset,
  }
}
