<script setup lang="ts">
/**
 * Similar listings widget.
 *
 * Calls /api/listings/:id/similar — backed by the deterministic
 * similar_listings RPC. Each match exposes its match_reasons array
 * (e.g., ["same_building","similar_price"]) so the user sees why
 * each card surfaced.
 *
 * Designed to drop into the listing detail page below the main
 * content. Loading state is single-spinner; empty state explicit.
 */
import { ref, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type SimilarListing = {
  id: number
  title: string | null
  sale_price: number | null
  rent_price: number | null
  bedrooms: number | null
  bathrooms: number | null
  floor_area: number | null
  property_type: string | null
  city_id: number | null
  building_id: string | null
  similarity_score: number
  match_reasons: string[]
}

const props = defineProps<{
  listingId: string | number
  limit?: number
}>()

const items = ref<SimilarListing[]>([])
const loading = ref(true)

async function load() {
  if (props.listingId == null) return
  loading.value = true
  try {
    const res = await $fetch<{ source_id: string; similar: SimilarListing[] }>(
      `/api/listings/${props.listingId}/similar`,
      { query: { limit: props.limit ?? 8 } },
    )
    items.value = res.similar ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load similar listings',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.listingId, load)

function fmtCurrency(n: number | null): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v >= 1_000_000) return '₱' + (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000)     return '₱' + (v / 1_000).toFixed(1) + 'K'
  return '₱' + v.toFixed(0)
}
function reasonLabel(r: string): string {
  return r.replace(/_/g, ' ')
}
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <header class="mb-3">
      <h3 class="text-sm font-semibold text-foreground">Similar listings</h3>
      <p class="text-xs text-muted-foreground">
        Deterministic matches — each card shows why it surfaced.
      </p>
    </header>

    <div v-if="loading" class="text-xs text-muted-foreground">Loading…</div>

    <div
      v-else-if="items.length === 0"
      class="rounded-md border border-dashed border-border bg-muted/50 p-4 text-center text-xs text-muted-foreground"
    >
      No similar listings in this city.
    </div>

    <ul v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <li
        v-for="l in items"
        :key="l.id"
        class="rounded-md border border-border bg-muted/40 p-3"
      >
        <NuxtLink :to="`/listings/${l.id}`" class="block">
          <p class="text-sm font-semibold text-foreground line-clamp-2">
            {{ l.title || `Listing #${l.id}` }}
          </p>
          <p class="mt-1 text-xs text-foreground">
            {{ fmtCurrency(l.sale_price ?? l.rent_price) }}
            <span v-if="l.bedrooms != null"> · {{ l.bedrooms }}BR</span>
            <span v-if="l.floor_area"> · {{ l.floor_area }}sqm</span>
          </p>
        </NuxtLink>
        <div class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="r in l.match_reasons"
            :key="r"
            class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
          >
            {{ reasonLabel(r) }}
          </span>
          <span class="ml-auto text-[10px] text-muted-foreground">
            score {{ l.similarity_score }}
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>
