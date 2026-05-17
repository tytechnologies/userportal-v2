<script setup lang="ts">
// Index of saved tax computations the caller can see.
//
// RLS scopes server-side: agents see their own, managers see team,
// admins see all. Defaults to the broadest visible scope; the "Mine
// only" toggle narrows to the caller's own.
//
// Filters: taxpayer type (all / individual / corporate), search by
// title (client-side substring — rows are always paged so it's cheap).

import { computed, onMounted, ref, watch } from 'vue'
import { useTaxComputations, type TaxComputation, type TaxpayerType } from '~/composables/useTaxComputations'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Tax computations | Housinginteractive' })

const { listTaxComputations } = useTaxComputations()

type Filter = 'all' | 'individual' | 'corporate'

const records = ref<TaxComputation[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 50
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const search = ref('')
const filter = ref<Filter>('all')
const mineOnly = ref(false)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const res = await listTaxComputations({
      page: page.value,
      pageSize,
      mine: mineOnly.value || undefined,
      taxpayerType: filter.value === 'all' ? undefined : (filter.value as TaxpayerType),
    })
    records.value = res.data
    total.value = res.total
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load records'
  } finally {
    isLoading.value = false
  }
}

watch(filter, () => { page.value = 1; load() })
watch(mineOnly, () => { page.value = 1; load() })
watch(page, () => load())

// Client-side substring search over title — server filtering by title
// would need an index + ILIKE; the page-bounded list is small enough
// to filter in memory.
const visibleRecords = computed(() => {
  if (!search.value.trim()) return records.value
  const q = search.value.trim().toLowerCase()
  return records.value.filter((r) => (r.title ?? '').toLowerCase().includes(q))
})

function taxpayerLabel(r: TaxComputation): string {
  return r.taxpayer_type === 'corporate' ? 'Corporate' : 'Individual'
}

function kindLabel(r: TaxComputation): string {
  switch (r.computation_kind) {
    case 'gross':   return 'Gross'
    case 'nett':    return 'Nett'
    case 'nett_zv': return 'Nett + ZV'
    default: return r.computation_kind
  }
}

function relativeDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

onMounted(load)
</script>

<template>
  <div class="mx-auto max-w-5xl p-4">
    <header class="mb-4">
      <h1 class="text-xl font-bold text-foreground">Tax computations</h1>
      <p class="text-sm text-muted-foreground">
        Saved tax records — re-loadable for review or audit.
      </p>
    </header>

    <!-- Filter / search row -->
    <div class="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-sm">
      <div class="flex gap-1 rounded-lg bg-muted p-1">
        <button
          v-for="opt in [
            { v: 'all',         label: 'All' },
            { v: 'individual',  label: 'Individual' },
            { v: 'corporate',   label: 'Corporate' },
          ]"
          :key="opt.v"
          type="button"
          class="rounded-md px-3 py-1 text-xs font-medium transition-colors"
          :class="filter === opt.v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
          @click="filter = opt.v as Filter"
        >
          {{ opt.label }}
        </button>
      </div>
      <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input v-model="mineOnly" type="checkbox" class="h-3.5 w-3.5" />
        Mine only
      </label>
      <input
        v-model="search"
        type="text"
        placeholder="Search by title…"
        class="min-w-[14rem] flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
      />
      <span class="text-xs text-muted-foreground/70">{{ total }} total</span>
    </div>

    <div
      v-if="isLoading"
      class="rounded-xl border border-border bg-background p-8 text-center text-sm text-muted-foreground/70"
    >
      Loading…
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </div>

    <div
      v-else-if="visibleRecords.length === 0"
      class="rounded-xl border border-border bg-background p-6 text-center text-sm text-muted-foreground/70"
    >
      <p>No tax computations match your filters.</p>
      <p class="mt-1 text-xs">
        Save one from the
        <NuxtLink to="/documents?tab=tax-computation" class="text-primary underline">tax computation form</NuxtLink>
        to see it here.
      </p>
    </div>

    <section v-else class="rounded-xl border border-border bg-background shadow-sm">
      <ul class="divide-y divide-border">
        <li
          v-for="r in visibleRecords"
          :key="r.id"
          class="px-4 py-3 hover:bg-accent hover:text-accent-foreground"
        >
          <NuxtLink :to="`/tax-computations/${r.id}`" class="block">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-foreground">
                  {{ r.title || 'Untitled tax computation' }}
                </p>
                <p class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    :class="r.taxpayer_type === 'corporate'
                      ? 'bg-primary/15 text-primary'
                      : 'bg-success/15 text-success'"
                  >
                    {{ taxpayerLabel(r) }} {{ kindLabel(r) }}
                  </span>
                  <span>·</span>
                  <span class="truncate">{{ r.owner?.full_name || 'Unknown' }}</span>
                  <span>·</span>
                  <span class="shrink-0">{{ relativeDate(r.created_at) }}</span>
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <span
                  v-if="r.contact_id"
                  class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                  title="Linked to a contact"
                >
                  C#{{ r.contact_id }}
                </span>
                <span
                  v-if="r.listing_id"
                  class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                  title="Linked to a listing"
                >
                  L#{{ r.listing_id }}
                </span>
              </div>
            </div>
          </NuxtLink>
        </li>
      </ul>

      <footer class="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <span>Page {{ page }} of {{ totalPages }}</span>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            :disabled="page <= 1"
            @click="page = Math.max(1, page - 1)"
          >
            Prev
          </button>
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
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
