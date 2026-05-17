<script setup lang="ts">
/**
 * Listings card grid — the new default view on /listings.
 *
 * Why this exists: the legacy ListingsTable.vue uses viewport-width
 * units (`width: 20vw`, `min-width: 5vw`) for ~20 columns, so the
 * table grows wider than the page on most screens. Even with
 * overflow-x scrolling, users can't tell what's been clipped without
 * scanning right. This grid surfaces the same operational data in
 * cards that fit any viewport: 4-up at xl+, 3-up at lg, 2-up at md,
 * 1-up below.
 *
 * Thumbnails: the DB column `listings.thumbnail` is mostly null and
 * NOT the source the legacy table uses. The legacy RowInfoCard.vue
 * fetches per-row from S3 (POST /api/listings/get-thumbnail →
 * prefix-list `properties/property-{id}/` for an object whose
 * filename contains `thumbnail-`). We route through the same path
 * via useThumbnailStore, which dedupes + caches by listing_id, so
 * switching views (table ↔ cards) doesn't re-fetch.
 *
 * Reads the same `columnsData` shape the legacy table consumes
 * (`store.buildColumns()` output), so swapping the views is a
 * cosmetic toggle — no separate fetch path. Click any card to open
 * the existing detail drawer.
 */
import { computed, onMounted, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import { useThumbnailStore } from '~/store/thumbnailStore'

type ListingRow = {
  listing_data: {
    listing_id: number
    title: string | null
    thumbnail: string | null
    is_online?: boolean
    unit_number?: string | null
    street_address?: string | null
  }
  price?: { sale_price?: number | null; rent_price?: number | null }
  status?: { value: string }
  is_online?: { value: boolean }
  bedrooms?: { value: number | null }
  bathrooms?: { value: number | null }
  floor_area?: { value: number | null }
  lot_area?: { value: number | null }
  parking_spaces?: { value: number | null }
  city?: { value: string | null }
  barangay?: { value: string | null }
  condition?: { value: string | null }
  availability?: { value: string | null }
  updated_at?: { value: string | null }
  uploaded_by?: { value: string | null }
}

const props = defineProps<{
  listings: ListingRow[]
  /** Whether bulk-selection is active. Renders a checkbox in the
   *  card's top-left corner when true. */
  selectionEnabled?: boolean
  isRowSelected?: (id: number) => boolean
}>()

const emit = defineEmits<{
  (e: 'showListingDetails', id: number): void
  (e: 'toggleRow', id: number): void
  (e: 'showHistory', id: number): void
}>()

// Status -> Badge variant. Maps the legacy status keys to the
// Operations palette tones.
function statusVariant(s: string | null | undefined): 'neutral' | 'success' | 'warning' | 'destructive' | 'primary' {
  if (!s) return 'neutral'
  switch (s) {
    case 'available':           return 'success'
    case 'occupied-rented':     return 'primary'
    case 'on-hold':             return 'warning'
    case 'under-negotiation':   return 'warning'
    case 'sold':                return 'neutral'
    default:                    return 'neutral'
  }
}

function statusLabel(s: string | null | undefined): string {
  if (!s) return '—'
  switch (s) {
    case 'available':           return 'Available'
    case 'occupied-rented':     return 'Tenanted'
    case 'on-hold':             return 'On hold'
    case 'under-negotiation':   return 'Negotiating'
    case 'sold':                return 'Sold'
    default:                    return s
  }
}

function formatPrice(row: ListingRow): { primary: string; suffix: string } {
  const rent = row.price?.rent_price
  const sale = row.price?.sale_price
  if (rent != null && rent > 0) {
    return { primary: `₱${Number(rent).toLocaleString()}`, suffix: ' / mo' }
  }
  if (sale != null && sale > 0) {
    return { primary: `₱${Number(sale).toLocaleString()}`, suffix: '' }
  }
  return { primary: 'Price not set', suffix: '' }
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function specsLine(row: ListingRow): string {
  const parts: string[] = []
  if (row.bedrooms?.value != null && row.bedrooms.value > 0) {
    parts.push(`${row.bedrooms.value} bd`)
  }
  if (row.bathrooms?.value != null && row.bathrooms.value > 0) {
    parts.push(`${row.bathrooms.value} ba`)
  }
  if (row.floor_area?.value != null && row.floor_area.value > 0) {
    parts.push(`${row.floor_area.value} m²`)
  }
  if (row.parking_spaces?.value != null && row.parking_spaces.value > 0) {
    parts.push(`${row.parking_spaces.value} pkg`)
  }
  return parts.join(' · ')
}

function locationLine(row: ListingRow): string {
  const bits = [row.barangay?.value, row.city?.value].filter(Boolean) as string[]
  return bits.join(', ')
}

const empty = computed(() => !props.listings || props.listings.length === 0)

// Thumbnail store — same one the legacy RowInfoCard hits, so the
// cache is shared across views. fetchThumbnail() dedupes in-flight
// requests per listing_id; we kick off one preload pass per render
// of the grid.
const thumbnailStore = useThumbnailStore()

function preloadVisible() {
  for (const row of props.listings) {
    const id = row.listing_data.listing_id
    if (id) thumbnailStore.fetchThumbnail(id)
  }
}

onMounted(preloadVisible)
watch(() => props.listings, preloadVisible)

// Per-card resolved thumbnail. Falls back to the (often null) DB
// column so any backfilled values still surface. Returns null while
// loading; the template renders the "No photo" placeholder.
function thumbnailFor(row: ListingRow): string | null {
  const id = row.listing_data.listing_id
  if (!id) return row.listing_data.thumbnail || null
  return thumbnailStore.getThumbnailUrl(id) || row.listing_data.thumbnail || null
}
</script>

<template>
  <div v-if="empty" class="rounded-lg border border-dashed border-border bg-surface-2 px-5 py-10 text-center">
    <p class="text-sm text-muted-foreground">No listings to show on this page.</p>
  </div>

  <div
    v-else
    class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
  >
    <article
      v-for="(row, idx) in listings"
      :key="row.listing_data.listing_id ?? idx"
      class="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-border-strong hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.18)]"
    >
      <!-- Bulk-select checkbox — top-left overlay. Only renders when
           selection is enabled by the parent. -->
      <label
        v-if="selectionEnabled"
        class="absolute left-2 top-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-border bg-card/95 backdrop-blur"
        @click.stop
      >
        <input
          type="checkbox"
          class="h-3.5 w-3.5 cursor-pointer accent-primary"
          :checked="isRowSelected ? isRowSelected(row.listing_data.listing_id) : false"
          :aria-label="`Select listing ${row.listing_data.listing_id}`"
          @change="emit('toggleRow', row.listing_data.listing_id)"
        />
      </label>

      <!-- Thumbnail -->
      <button
        type="button"
        class="aspect-[16/10] block w-full overflow-hidden bg-surface-2 focus-ring"
        :aria-label="`Open ${row.listing_data.title || 'listing'} details`"
        @click="emit('showListingDetails', row.listing_data.listing_id)"
      >
        <img
          v-if="thumbnailFor(row)"
          :src="thumbnailFor(row)!"
          :alt="row.listing_data.title || `Listing ${row.listing_data.listing_id}`"
          loading="lazy"
          decoding="async"
          class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
        />
        <div
          v-else
          class="flex h-full w-full items-center justify-center text-xs text-muted-foreground"
        >
          No photo
        </div>
      </button>

      <!-- Status + online overlay at the top-right of the thumbnail -->
      <div class="absolute right-2 top-2 z-10 flex flex-col items-end gap-1">
        <UiBadge
          v-if="row.status?.value"
          :variant="statusVariant(row.status.value)"
          size="xs"
        >
          {{ statusLabel(row.status.value) }}
        </UiBadge>
        <UiBadge
          v-if="row.is_online?.value !== undefined"
          :variant="row.is_online.value ? 'success' : 'neutral'"
          size="xs"
          dot
        >
          {{ row.is_online.value ? 'Online' : 'Offline' }}
        </UiBadge>
      </div>

      <!-- Body -->
      <div class="flex flex-1 flex-col gap-2 p-4">
        <div class="flex items-baseline justify-between gap-2">
          <button
            type="button"
            class="min-w-0 flex-1 text-left focus-ring rounded"
            @click="emit('showListingDetails', row.listing_data.listing_id)"
          >
            <h3 class="truncate text-sm font-semibold text-foreground hover:underline">
              {{ row.listing_data.title || `Listing #${row.listing_data.listing_id}` }}
            </h3>
          </button>
          <span class="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
            #{{ row.listing_data.listing_id }}
          </span>
        </div>

        <p class="text-sm font-semibold text-foreground tabular-nums">
          {{ formatPrice(row).primary }}
          <span class="font-normal text-muted-foreground">{{ formatPrice(row).suffix }}</span>
        </p>

        <p v-if="specsLine(row)" class="text-xs text-muted-foreground tabular-nums">
          {{ specsLine(row) }}
        </p>

        <p v-if="locationLine(row)" class="truncate text-xs text-muted-foreground">
          {{ locationLine(row) }}
        </p>

        <!-- Bottom meta strip -->
        <div class="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
          <span class="truncate">
            {{ row.uploaded_by?.value || 'Unknown agent' }}
          </span>
          <span v-if="row.updated_at?.value" class="shrink-0">
            {{ relativeTime(row.updated_at.value) }}
          </span>
        </div>
      </div>
    </article>
  </div>
</template>
