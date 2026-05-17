<script setup lang="ts">
/**
 * Market Intelligence dashboard.
 *
 * Internal-facing v1: city × property_type filter, then snapshot
 * cards (inventory, velocity), monthly trend chart, and top
 * buildings table. Public version is a follow-up (the data needs
 * to be validated on sparse cities first).
 *
 * Heatmap UI deferred — RPC ships in mig 28; this page wires
 * the tabular intelligence first.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import HeatmapGridChart from '~/components/market/HeatmapGridChart.vue'
import HotAreasList from '~/components/market/HotAreasList.vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'

const heatmapMode = ref<'pricing' | 'demand' | 'inventory' | 'trust' | 'luxury' | 'velocity'>('pricing')
const HEATMAP_MODES = [
  { key: 'pricing',   label: 'Median ₱/sqm' },
  { key: 'demand',    label: 'Demand (30d inquiries)' },
  { key: 'inventory', label: 'Inventory density' },
  { key: 'trust',     label: 'Broker trust density' },
  { key: 'luxury',    label: 'Luxury concentration' },
  { key: 'velocity',  label: 'Velocity (median DOM)' },
] as const

definePageMeta({ layout: 'default' })
useHead({ title: 'Market Intelligence | Housinginteractive' })

type City = { id: number; name: string; slug: string }

type InventoryRow = {
  city_id: number
  property_type: string
  listing_count: number
  available_count: number
  reserved_count: number
  sold_count: number
  median_price: number | null
  median_price_per_sqm: number | null
  p25_price: number | null
  p75_price: number | null
  sufficient_data: boolean
}

type VelocityRow = {
  city_id: number
  property_type: string
  active_listings: number
  median_dom_days: number | null
  p75_dom_days: number | null
  deals_closed_30d: number
  deals_closed_90d: number
  gmv_90d: number | null
  absorption_rate_30d: number | null
}

type BuildingRow = {
  building_id: string
  building_name: string
  building_slug: string
  listing_count: number
  median_price: number | null
  median_price_per_sqm: number | null
  deals_won_90d: number
  gmv_90d: number | null
  trust_score: number | null
  review_count: number | null
}

type TrendRow = {
  month_start: string
  city_id: number
  property_type: string
  listings_created: number
  median_price: number | null
  median_price_per_sqm: number | null
}

const cities = ref<City[]>([])
const cityId = ref<number | null>(null)
const propertyType = ref<string>('condominium')

const inventory = ref<InventoryRow[]>([])
const velocity = ref<VelocityRow[]>([])
const topBuildings = ref<BuildingRow[]>([])
const trends = ref<TrendRow[]>([])
const minSample = ref(5)
const loading = ref(true)

const PROPERTY_TYPES = ['condominium', 'house', 'townhouse', 'lot', 'commercial']

async function loadCities() {
  // Reuse the public cities table — anon-readable.
  const supabase = useSupabaseClient()
  const { data } = await (supabase as any)
    .from('cities')
    .select('id, name, slug')
    .order('name')
  cities.value = (data ?? []) as City[]
  if (cities.value.length > 0 && cityId.value == null) {
    cityId.value = cities.value[0]!.id
  }
}

async function loadSnapshot() {
  if (cityId.value == null) return
  loading.value = true
  try {
    const [snap, trend] = await Promise.all([
      $fetch<{
        inventory: InventoryRow[]
        velocity: VelocityRow[]
        top_buildings: BuildingRow[]
        min_sample: number
      }>('/api/market/snapshot', {
        query: { city_id: cityId.value, property_type: propertyType.value },
      }),
      $fetch<{ trends: TrendRow[] }>('/api/market/trends', {
        query: { city_id: cityId.value, property_type: propertyType.value, months: 12 },
      }),
    ])
    inventory.value    = snap.inventory ?? []
    velocity.value     = snap.velocity ?? []
    topBuildings.value = snap.top_buildings ?? []
    minSample.value    = snap.min_sample ?? 5
    trends.value       = trend.trends ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load market data',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadCities()
  await loadSnapshot()
})

watch([cityId, propertyType], () => {
  if (cityId.value != null) loadSnapshot()
})

const currentInventory = computed(() => inventory.value[0] ?? null)
const currentVelocity  = computed(() => velocity.value[0] ?? null)

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v >= 1_000_000) return '₱' + (v / 1_000_000).toFixed(2) + 'M'
  if (v >= 1_000)     return '₱' + (v / 1_000).toFixed(1) + 'K'
  return '₱' + v.toFixed(0)
}
function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—'
  return (Number(n) * 100).toFixed(1) + '%'
}
function fmtDays(n: number | null | undefined): string {
  if (n == null) return '—'
  return Number(n).toFixed(0) + 'd'
}
function fmtMonth(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', year: '2-digit' })
}

// SVG line chart for trends. Native rendering — same approach as
// OpsTimeSeriesChart, no charting library dependency.
const chart = computed(() => {
  const rows = trends.value
  if (rows.length < 2) return null
  const points = rows
    .filter((r) => r.median_price != null)
    .map((r, i) => ({ idx: i, value: Number(r.median_price), label: r.month_start }))
  if (points.length < 2) return null

  const minV = Math.min(...points.map((p) => p.value))
  const maxV = Math.max(...points.map((p) => p.value))
  const range = Math.max(1, maxV - minV)
  const W = 600, H = 160, padL = 8, padR = 8, padT = 12, padB = 24
  const xScale = (i: number) => padL + (i / (points.length - 1)) * (W - padL - padR)
  const yScale = (v: number) => padT + (1 - (v - minV) / range) * (H - padT - padB)

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.idx).toFixed(1)} ${yScale(p.value).toFixed(1)}`)
    .join(' ')

  return { points, path, W, H, minV, maxV, padL, padR, padT, padB, xScale, yScale }
})
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <UiPageHeader
      title="Market Intelligence"
      description="Inventory, velocity, and pricing for any city × property type. Live aggregates; monthly trends refresh nightly."
    />

    <!-- Filter bar -->
    <UiCard padding="sm">
      <div class="flex flex-wrap items-end gap-3">
        <label class="text-xs">
          <span class="font-semibold text-foreground">City</span>
          <select
            v-model="cityId"
            class="mt-1 block rounded-md border border-border bg-card px-2 py-1 text-sm focus-ring"
          >
            <option v-for="c in cities" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label class="text-xs">
          <span class="font-semibold text-foreground">Property type</span>
          <select
            v-model="propertyType"
            class="mt-1 block rounded-md border border-border bg-card px-2 py-1 text-sm focus-ring"
          >
            <option v-for="t in PROPERTY_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
      </div>
    </UiCard>

    <UiCard v-if="loading" padding="md" class="text-center text-sm text-muted-foreground">
      Loading market data…
    </UiCard>

    <template v-else>
      <!-- Sparse-data warning -->
      <UiCard
        v-if="currentInventory && !currentInventory.sufficient_data"
        padding="md"
        class="border-warning/30 bg-warning/10 text-xs text-warning"
      >
        <strong>Limited data.</strong> Only {{ currentInventory.listing_count }} listing(s) match this segment
        (minimum {{ minSample }} for reliable medians). Numbers below may not be representative.
      </UiCard>

      <!-- Inventory + price cards -->
      <UiCard padding="md">
        <h2 class="mb-3 text-card-title">Inventory & price</h2>
        <div v-if="!currentInventory" class="text-xs text-muted-foreground">
          No listings in this segment.
        </div>
        <div v-else class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div class="rounded-md border border-border bg-muted/40 p-3">
            <p class="text-eyebrow">Listings</p>
            <p class="text-lg font-semibold text-foreground tabular-nums">{{ fmtInt(currentInventory.listing_count) }}</p>
            <p class="text-[10px] text-muted-foreground">
              {{ fmtInt(currentInventory.available_count) }} avail
              · {{ fmtInt(currentInventory.reserved_count) }} reserved
              · {{ fmtInt(currentInventory.sold_count) }} sold
            </p>
          </div>
          <div class="rounded-md border border-primary/30 bg-primary/10 p-3">
            <p class="text-[10px] uppercase tracking-wide text-primary">Median price</p>
            <p class="text-lg font-semibold text-primary tabular-nums">{{ fmtCurrency(currentInventory.median_price) }}</p>
            <p class="text-[10px] text-primary">
              p25 {{ fmtCurrency(currentInventory.p25_price) }} ·
              p75 {{ fmtCurrency(currentInventory.p75_price) }}
            </p>
          </div>
          <div class="rounded-md border border-primary/30 bg-primary/10 p-3">
            <p class="text-[10px] uppercase tracking-wide text-primary">Median ₱/sqm</p>
            <p class="text-lg font-semibold text-primary tabular-nums">{{ fmtCurrency(currentInventory.median_price_per_sqm) }}</p>
          </div>
          <div class="rounded-md border border-success/30 bg-success/10 p-3">
            <p class="text-[10px] uppercase tracking-wide text-success">Absorption 30d</p>
            <p class="text-lg font-semibold text-success tabular-nums">{{ fmtPct(currentVelocity?.absorption_rate_30d) }}</p>
            <p class="text-[10px] text-success">
              {{ fmtInt(currentVelocity?.deals_closed_30d) }} closed
            </p>
          </div>
        </div>
      </UiCard>

      <!-- Velocity card -->
      <UiCard v-if="currentVelocity" padding="md">
        <h2 class="mb-3 text-card-title">Velocity</h2>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div class="rounded-md border border-border bg-muted/40 p-3">
            <p class="text-eyebrow">Median DOM</p>
            <p class="text-lg font-semibold text-foreground tabular-nums">{{ fmtDays(currentVelocity.median_dom_days) }}</p>
            <p class="text-[10px] text-muted-foreground">p75 {{ fmtDays(currentVelocity.p75_dom_days) }}</p>
          </div>
          <div class="rounded-md border border-border bg-muted/40 p-3">
            <p class="text-eyebrow">Active</p>
            <p class="text-lg font-semibold text-foreground tabular-nums">{{ fmtInt(currentVelocity.active_listings) }}</p>
          </div>
          <div class="rounded-md border border-success/30 bg-success/10 p-3">
            <p class="text-[10px] uppercase tracking-wide text-success">Closed 90d</p>
            <p class="text-lg font-semibold text-success tabular-nums">{{ fmtInt(currentVelocity.deals_closed_90d) }}</p>
          </div>
          <div class="rounded-md border border-primary/30 bg-primary/10 p-3">
            <p class="text-[10px] uppercase tracking-wide text-primary">GMV 90d</p>
            <p class="text-lg font-semibold text-primary tabular-nums">{{ fmtCurrency(currentVelocity.gmv_90d) }}</p>
          </div>
        </div>
      </UiCard>

      <!-- Trend chart -->
      <UiCard padding="md">
        <h2 class="mb-3 text-card-title">Median price — last 12 months</h2>
        <div v-if="!chart" class="rounded-md border border-dashed border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground">
          Not enough monthly data points. Trends populate as more listings are created over time.
        </div>
        <svg v-else :viewBox="`0 0 ${chart.W} ${chart.H}`" class="w-full">
          <text :x="0" :y="chart.padT + 4" class="fill-muted-foreground" style="font-size: 9px">{{ fmtCurrency(chart.maxV) }}</text>
          <text :x="0" :y="chart.H - chart.padB + 12" class="fill-muted-foreground" style="font-size: 9px">{{ fmtCurrency(chart.minV) }}</text>
          <line
            :x1="chart.padL"
            :x2="chart.W - chart.padR"
            :y1="chart.H - chart.padB"
            :y2="chart.H - chart.padB"
            class="stroke-muted-foreground"
            stroke-width="1"
          />
          <path :d="chart.path" class="stroke-primary" fill="none" stroke-width="2" />
          <circle
            v-for="p in chart.points"
            :key="p.label"
            :cx="chart.xScale(p.idx)"
            :cy="chart.yScale(p.value)"
            r="2.5"
            class="fill-primary"
          />
          <text
            v-for="(p, i) in chart.points"
            :key="`xl-${p.label}`"
            v-show="i === 0 || i === chart.points.length - 1 || i === Math.floor(chart.points.length / 2)"
            :x="chart.xScale(p.idx)"
            :y="chart.H - 6"
            text-anchor="middle"
            class="fill-muted-foreground"
            style="font-size: 9px"
          >
            {{ fmtMonth(p.label) }}
          </text>
        </svg>
      </UiCard>

      <!-- Geographic intelligence: heatmap + hot areas -->
      <UiCard padding="md">
        <header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 class="text-card-title">Geographic intelligence</h2>
            <p class="text-meta">
              Per-cell heatmap projected over a Metro Manila bounding box.
              Sparse cells are suppressed (≥3 or ≥5 listings depending on mode).
            </p>
          </div>
          <label class="text-xs">
            <span class="font-semibold text-foreground">Mode</span>
            <select
              v-model="heatmapMode"
              class="mt-1 block rounded-md border border-border bg-card px-2 py-1 text-sm focus-ring"
            >
              <option v-for="m in HEATMAP_MODES" :key="m.key" :value="m.key">
                {{ m.label }}
              </option>
            </select>
          </label>
        </header>
        <HeatmapGridChart :mode="heatmapMode" />
      </UiCard>

      <HotAreasList :city-id="cityId" :limit="10" />

      <!-- Top buildings -->
      <UiCard v-if="topBuildings.length > 0" padding="md">
        <h2 class="mb-1 text-card-title">Top buildings in this city</h2>
        <p class="mb-3 text-meta">
          Sorted by listing count. Only buildings with ≥{{ minSample }} listings are shown.
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th class="py-1 pr-2 font-semibold">Building</th>
                <th class="py-1 pr-2 font-semibold">Listings</th>
                <th class="py-1 pr-2 font-semibold">Median price</th>
                <th class="py-1 pr-2 font-semibold">Median ₱/sqm</th>
                <th class="py-1 pr-2 font-semibold">Won 90d</th>
                <th class="py-1 font-semibold">Trust</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="b in topBuildings" :key="b.building_id">
                <td class="py-1.5 pr-2 font-medium">{{ b.building_name }}</td>
                <td class="py-1.5 pr-2 tabular-nums">{{ fmtInt(b.listing_count) }}</td>
                <td class="py-1.5 pr-2 tabular-nums">{{ fmtCurrency(b.median_price) }}</td>
                <td class="py-1.5 pr-2 tabular-nums">{{ fmtCurrency(b.median_price_per_sqm) }}</td>
                <td class="py-1.5 pr-2 text-success tabular-nums">{{ fmtInt(b.deals_won_90d) }}</td>
                <td class="py-1.5">
                  <UiBadge v-if="b.trust_score != null" variant="primary" size="xs">
                    {{ Math.round(b.trust_score) }}
                  </UiBadge>
                  <span v-else class="text-muted-foreground/70 text-[10px]">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>
    </template>
  </AdminPageShell>
</template>
