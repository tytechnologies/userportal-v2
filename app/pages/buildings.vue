<script setup lang="ts">
// Buildings page — directory + triage in one. Each row expands inline
// to show the listings (units/properties) that live in that building,
// grouped under the parent name. The triage affordance (curated
// toggle, search, filter) stays so editors can still work this page
// the way they did before.
//
// Listings are fetched lazily per building — clicking a row's
// disclosure chevron triggers a single read against listing_details
// for `building_id = X`. Cached in `expandedListings` so re-collapse +
// re-expand doesn't re-fetch.

import { computed, onMounted, ref, watch } from 'vue'
import { useBuildings, type Building } from '~/composables/useBuildings'
import { showToast } from '~/helpers/helpers'
import { formatMoney } from '~/utils'

definePageMeta({ layout: 'default' })

const supabase = useSupabaseClient()
const { listBuildings, updateBuilding } = useBuildings()

type CurationFilter = 'all' | 'unreviewed' | 'curated'

const filter = ref<CurationFilter>('curated')
const search = ref('')
const page = ref(1)
const pageSize = 50

const buildings = ref<(Building & { listings_count?: number })[]>([])
const total = ref(0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const togglingId = ref<number | null>(null)

// Per-building inventory state. Keyed by building id.
type ListingRow = {
  listing_id: number
  title: string | null
  is_online: boolean | null
  for_sale: boolean | null
  for_rent: boolean | null
  sale_price: number | null
  rent_price: number | null
  property_type: string | null
  unit_number: string | null
  bedrooms: number | null
  bathrooms: number | null
}
const expandedIds = ref<Set<number>>(new Set())
const listingsByBuilding = ref<Record<number, ListingRow[]>>({})
const listingsLoading = ref<Set<number>>(new Set())
const listingsError = ref<Record<number, string | null>>({})

// Debounce the search input.
let searchHandle: ReturnType<typeof setTimeout> | null = null
watch(search, () => {
  if (searchHandle) clearTimeout(searchHandle)
  searchHandle = setTimeout(() => { page.value = 1; load() }, 250)
})

watch(filter, () => { page.value = 1; load() })
watch(page, () => load())

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const res = await listBuildings({
      page: page.value,
      pageSize,
      search: search.value.trim() || undefined,
      isCurated: filter.value === 'all' ? undefined : filter.value === 'curated',
    })
    buildings.value = res.data
    total.value = res.total
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load buildings'
  } finally {
    isLoading.value = false
  }
}

async function toggleExpand(b: Building) {
  const next = new Set(expandedIds.value)
  if (next.has(b.id)) {
    next.delete(b.id)
    expandedIds.value = next
    return
  }
  next.add(b.id)
  expandedIds.value = next

  // Lazy-fetch listings only on first expand. Cache survives toggles
  // until the page reloads.
  if (listingsByBuilding.value[b.id] !== undefined) return
  await loadListings(b.id)
}

async function loadListings(buildingId: number) {
  const loading = new Set(listingsLoading.value)
  loading.add(buildingId)
  listingsLoading.value = loading
  listingsError.value[buildingId] = null

  try {
    // EXCEPTION to "always read from listing_details": this query goes
    // to the base `listings` table because the MV does not project
    // listings.building_id (it predates the buildings-first-class
    // migration). Every other listing read should still go through
    // listing_details — see its column list at the top of this file.
    //
    // Alias `id` → `listing_id` so the template renders against the
    // same field shape the rest of the app uses.
    const { data, error } = await (supabase as any)
      .from('listings')
      .select('listing_id:id, title, is_online, for_sale, for_rent, sale_price, rent_price, property_type, unit_number, bedrooms, bathrooms')
      .eq('building_id', buildingId)
      .is('deleted_at', null)
      .order('id', { ascending: false })
      .limit(100)
    if (error) throw error
    listingsByBuilding.value[buildingId] = (data ?? []) as ListingRow[]
  } catch (err: any) {
    listingsError.value[buildingId] = err?.message || 'Failed to load listings'
    listingsByBuilding.value[buildingId] = []
  } finally {
    const done = new Set(listingsLoading.value)
    done.delete(buildingId)
    listingsLoading.value = done
  }
}

async function onToggle(b: Building) {
  togglingId.value = b.id
  const next = !b.is_curated
  try {
    const updated = await updateBuilding(b.id, { is_curated: next })
    const stillVisible =
      filter.value === 'all'
      || (filter.value === 'curated' && updated.is_curated)
      || (filter.value === 'unreviewed' && !updated.is_curated)
    if (!stillVisible) {
      buildings.value = buildings.value.filter((x) => x.id !== b.id)
      total.value = Math.max(0, total.value - 1)
    } else {
      const idx = buildings.value.findIndex((x) => x.id === b.id)
      if (idx >= 0) buildings.value[idx] = { ...buildings.value[idx], ...updated }
    }
    showToast({
      title: next ? 'Approved as building' : 'Marked unreviewed',
      icon: 'success',
    })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to update', icon: 'error' })
  } finally {
    togglingId.value = null
  }
}

function priceLabel(l: ListingRow) {
  if (l.for_sale && l.sale_price) return formatMoney(l.sale_price, true)
  if (l.for_rent && l.rent_price) return `${formatMoney(l.rent_price, true)}/mo`
  return '—'
}

function unitLabel(l: ListingRow) {
  const parts: string[] = []
  if (l.unit_number) parts.push(`Unit ${l.unit_number}`)
  if (l.bedrooms !== null && l.bedrooms !== undefined) parts.push(`${l.bedrooms}BR`)
  if (l.bathrooms !== null && l.bathrooms !== undefined) parts.push(`${l.bathrooms}BA`)
  if (parts.length === 0 && l.property_type) parts.push(l.property_type)
  return parts.join(' · ')
}

onMounted(load)
</script>

<template>
  <div class="mx-auto max-w-5xl p-4">
    <header class="mb-4">
      <h1 class="text-xl font-bold text-foreground">Buildings</h1>
      <p class="text-sm text-muted-foreground">
        Properties grouped by their parent building. Click a row to see its inventory.
      </p>
    </header>

    <!-- Filter + search -->
    <div class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-sm">
      <div class="flex gap-1 rounded-lg bg-muted-foreground/10 p-1">
        <button
          v-for="opt in [
            { v: 'curated',    label: 'Curated' },
            { v: 'unreviewed', label: 'Unreviewed' },
            { v: 'all',        label: 'All' },
          ]"
          :key="opt.v"
          type="button"
          class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
          :class="filter === opt.v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground/80'"
          @click="filter = opt.v as CurationFilter"
        >
          {{ opt.label }}
        </button>
      </div>
      <input
        v-model="search"
        type="text"
        placeholder="Search by name…"
        class="min-w-[14rem] flex-1 rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
      />
      <span class="text-xs text-muted-foreground/70">{{ total }} total</span>
    </div>

    <div v-if="isLoading" class="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground/70">
      Loading…
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </div>

    <div
      v-else-if="buildings.length === 0"
      class="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground/70"
    >
      No buildings match your filters.
    </div>

    <section v-else class="rounded-lg border border-border bg-card shadow-sm">
      <ul class="divide-y divide-border">
        <li v-for="b in buildings" :key="b.id" class="overflow-hidden">
          <!-- Building row. Click anywhere except the toggle / edit
               link to expand. -->
          <div
            class="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-primary/10"
            :class="expandedIds.has(b.id) ? 'bg-primary/10' : ''"
            @click="toggleExpand(b)"
          >
            <input
              type="checkbox"
              class="h-4 w-4 cursor-pointer"
              :checked="b.is_curated"
              :disabled="togglingId === b.id"
              :title="b.is_curated ? 'Unapprove' : 'Approve as building'"
              @click.stop
              @change="onToggle(b)"
            />

            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary text-xs transition-transform"
              :class="expandedIds.has(b.id) ? 'rotate-90' : ''"
              aria-hidden="true"
            >
              â–¶
            </span>

            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-2">
                <span class="truncate text-sm font-medium text-foreground">{{ b.name }}</span>
                <span
                  v-if="b.is_curated"
                  class="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success"
                >
                  Curated
                </span>
              </p>
              <p class="truncate text-xs text-muted-foreground">
                {{ b.slug || '—' }}
                <span v-if="b.address"> · {{ b.address }}</span>
              </p>
            </div>

            <NuxtLink
              :to="`/buildings/${b.id}`"
              class="shrink-0 text-xs text-primary hover:underline"
              @click.stop
            >
              Edit
            </NuxtLink>
          </div>

          <!-- Expanded inventory: lazy-loaded listings for this
               building. Indented to visually nest under the parent. -->
          <div v-if="expandedIds.has(b.id)" class="border-t border-primary/30 bg-primary/10">
            <div
              v-if="listingsLoading.has(b.id)"
              class="px-12 py-3 text-xs text-muted-foreground/70"
            >
              Loading listings…
            </div>
            <div
              v-else-if="listingsError[b.id]"
              class="px-12 py-3 text-xs text-destructive"
            >
              {{ listingsError[b.id] }}
            </div>
            <div
              v-else-if="(listingsByBuilding[b.id] ?? []).length === 0"
              class="px-12 py-3 text-xs text-muted-foreground/70"
            >
              No listings linked to this building yet.
            </div>
            <ul v-else class="divide-y divide-indigo-100/60">
              <li
                v-for="l in listingsByBuilding[b.id]"
                :key="l.listing_id"
                class="flex items-center gap-3 px-12 py-2 text-sm hover:bg-card"
              >
                <span
                  class="h-2 w-2 shrink-0 rounded-full"
                  :class="l.is_online ? 'bg-success' : 'bg-muted'"
                  :title="l.is_online ? 'Online' : 'Offline'"
                  aria-hidden="true"
                />
                <NuxtLink
                  :to="`/listings/${l.listing_id}`"
                  class="min-w-0 flex-1 hover:text-primary"
                  @click.stop
                >
                  <p class="truncate text-sm font-medium text-foreground">
                    {{ l.title || `Listing #${l.listing_id}` }}
                  </p>
                  <p v-if="unitLabel(l)" class="truncate text-xs text-muted-foreground">
                    {{ unitLabel(l) }}
                  </p>
                </NuxtLink>
                <span class="shrink-0 text-xs font-medium text-foreground/80">
                  {{ priceLabel(l) }}
                </span>
              </li>
            </ul>
          </div>
        </li>
      </ul>

      <footer class="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <span>Page {{ page }} of {{ totalPages }}</span>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1 hover:bg-muted-foreground/5 disabled:opacity-50"
            :disabled="page <= 1"
            @click="page = Math.max(1, page - 1)"
          >
            Prev
          </button>
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1 hover:bg-muted-foreground/5 disabled:opacity-50"
            :disabled="page >= totalPages"
            @click="page = Math.min(totalPages, page + 1)"
          >
            Next
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
