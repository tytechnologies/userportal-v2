<script setup lang="ts">
/**
 * SVG-based heatmap grid renderer.
 *
 * Reads /api/market/heatmap for a chosen mode + bounding box and
 * renders the grid cells as colored SVG rectangles laid out by
 * cell_lat / cell_lng. No map library — internal/analytics surface.
 *
 * Color scale is mode-aware:
 *   - pricing/luxury: high = warm (red)
 *   - demand/inventory/trust: high = warm
 *   - velocity (DOM): LOW = warm (low DOM is hotter)
 *
 * The bounding box defaults to a Metro Manila viewport but is
 * configurable via prop (so future zoom-aware integrations can
 * narrow it). All RPCs enforce ≥3 (or ≥5) HAVING — sparse cells
 * never reach this component.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Mode = 'pricing' | 'demand' | 'inventory' | 'trust' | 'luxury' | 'velocity'

type Cell = {
  cell_lat: number
  cell_lng: number
  [k: string]: any
}

const props = withDefaults(defineProps<{
  mode?: Mode
  // Default = Metro Manila bounding box. Override for other regions.
  minLat?: number
  minLng?: number
  maxLat?: number
  maxLng?: number
  cell?: number
}>(), {
  mode: 'pricing',
  minLat: 14.40,
  minLng: 120.90,
  maxLat: 14.80,
  maxLng: 121.20,
  cell: 0.01,
})

const cells = ref<Cell[]>([])
const valueColumn = ref<string>('')
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      mode: Mode
      value_column: string
      cell_size: number
      cells: Cell[]
    }>('/api/market/heatmap', {
      query: {
        mode:    props.mode,
        min_lat: props.minLat,
        min_lng: props.minLng,
        max_lat: props.maxLat,
        max_lng: props.maxLng,
        cell:    props.cell,
      },
    })
    cells.value = res.cells ?? []
    valueColumn.value = res.value_column
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load heatmap',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.mode, props.minLat, props.minLng, props.maxLat, props.maxLng, props.cell], load)

// SVG layout: project lat/lng to viewBox coordinates.
// Note: SVG y grows downward; latitude grows northward, so we invert.
const VIEW_W = 600
const VIEW_H = 480

const projection = computed(() => {
  const lngSpan = props.maxLng - props.minLng
  const latSpan = props.maxLat - props.minLat
  const cellPx = (VIEW_W / lngSpan) * props.cell
  return {
    project: (lat: number, lng: number) => ({
      x: ((lng - props.minLng) / lngSpan) * VIEW_W,
      // Flip y: max latitude → top of viewBox.
      y: VIEW_H - ((lat - props.minLat) / latSpan) * VIEW_H - cellPx,
    }),
    cellPx,
  }
})

// Derive min / max value across the rendered cells for the color scale.
const range = computed(() => {
  if (cells.value.length === 0 || !valueColumn.value) return { min: 0, max: 1 }
  let min = Infinity, max = -Infinity
  for (const c of cells.value) {
    const v = Number(c[valueColumn.value])
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return { min: 0, max: 1 }
  }
  return { min, max }
})

// velocity is INVERTED — low DOM = hotter.
const isInverted = computed(() => props.mode === 'velocity')

function colorFor(value: number): string {
  const { min, max } = range.value
  if (!Number.isFinite(value)) return 'rgba(0,0,0,0.05)'
  let t = (value - min) / Math.max(1e-9, max - min)
  if (isInverted.value) t = 1 - t
  // Clamp.
  t = Math.max(0, Math.min(1, t))
  // Cool → warm gradient: blue (low) → yellow → red (high).
  // Linear interp through HSL hue space (240 = blue, 0 = red).
  const hue = 240 * (1 - t)
  const lightness = 50 + (1 - t) * 10  // hotter = slightly darker
  return `hsla(${hue.toFixed(0)}, 80%, ${lightness.toFixed(0)}%, 0.85)`
}

function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (props.mode === 'pricing')   return '₱' + (v / 1000).toFixed(0) + 'K/sqm'
  if (props.mode === 'velocity')  return v.toFixed(0) + 'd DOM'
  if (props.mode === 'luxury')    return v.toFixed(1) + '%'
  if (props.mode === 'trust')     return v.toFixed(0)
  return v.toFixed(0)
}

const isEmpty = computed(() => !loading.value && cells.value.length === 0)
const total = computed(() => cells.value.length)
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h2 class="text-sm font-semibold text-foreground">
          Heatmap — {{ mode }}
        </h2>
        <p class="text-xs text-muted-foreground">
          {{ total }} cells in view. Cells with fewer than the privacy threshold
          ({{ mode === 'trust' || mode === 'luxury' ? '5' : '3' }} listings) are hidden.
        </p>
      </div>
      <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span class="inline-block h-3 w-3 rounded" style="background: hsla(240, 80%, 55%, 0.85)" />
        <span>{{ fmtValue(range.min) }}</span>
        <span class="mx-1">→</span>
        <span class="inline-block h-3 w-3 rounded" style="background: hsla(0, 80%, 50%, 0.85)" />
        <span>{{ fmtValue(range.max) }}</span>
      </div>
    </header>

    <div v-if="loading" class="rounded-md border border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground">
      Loading heatmap…
    </div>

    <div
      v-else-if="isEmpty"
      class="rounded-md border border-dashed border-border bg-muted/50 p-8 text-center text-xs text-muted-foreground"
    >
      Not enough data in this view. Try a different mode or zoom out.
    </div>

    <svg
      v-else
      :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
      class="w-full bg-muted/40"
      preserveAspectRatio="xMidYMid meet"
    >
      <!-- Optional bounding rectangle to anchor the eye. -->
      <rect :width="VIEW_W" :height="VIEW_H" class="fill-none stroke-muted-foreground" stroke-width="1" />
      <!-- Cells -->
      <g>
        <rect
          v-for="(c, i) in cells"
          :key="i"
          :x="projection.project(c.cell_lat, c.cell_lng).x"
          :y="projection.project(c.cell_lat, c.cell_lng).y"
          :width="projection.cellPx"
          :height="projection.cellPx"
          :fill="colorFor(Number(c[valueColumn]))"
        >
          <title>{{ fmtValue(Number(c[valueColumn])) }} · {{ c.listing_count ?? c.total_count ?? '—' }} listings</title>
        </rect>
      </g>
    </svg>

    <p class="mt-2 text-[10px] text-muted-foreground/70">
      Cells projected to lat {{ minLat.toFixed(2) }}–{{ maxLat.toFixed(2) }},
      lng {{ minLng.toFixed(2) }}–{{ maxLng.toFixed(2) }}. Cell size: {{ cell }}°.
    </p>
  </section>
</template>
