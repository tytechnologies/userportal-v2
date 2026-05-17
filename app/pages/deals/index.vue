<script setup lang="ts">
/**
 * /deals — pipeline view (table or kanban).
 *
 * Stage tabs across the top + a list/board view that the broker can
 * toggle between. The kanban surfaces drag-to-transition; the table
 * gives a denser, sortable scan. View preference is persisted to
 * localStorage so each broker's choice sticks across sessions.
 *
 * Filters: stage, mine vs. all-visible. RLS already scopes
 * "all-visible" to deals the caller participates in. The stage filter
 * only applies to the table view — the kanban is the stage filter.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiTabBar from '~/components/ui/UiTabBar.vue'
import UiDataTable from '~/components/ui/UiDataTable.vue'
import DealsPipelineBoard from '~/components/deals/DealsPipelineBoard.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Deals | Housing Interactive' })

type Deal = {
  id: string
  listing_id: number
  inquiry_id: string | null
  stage_key: string
  stage_entered_at: string
  deal_value: number | null
  currency: string
  title: string | null
  closed_at: string | null
  closed_won: boolean | null
  created_at: string
  updated_at: string
  listing: {
    id: number
    title: string | null
    sale_price: number | null
    rent_price: number | null
    for_sale: boolean | null
    for_rent: boolean | null
  } | null
  buyer_agent: {
    id: string
    full_name: string | null
    avatar_url: string | null
  } | null
  buyer_contact: {
    id: number
    full_name: string | null
    email: string | null
    mobile_phone: string | null
  } | null
}

const STAGES = [
  { key: 'inquiry_received',   label: 'Inquiry' },
  { key: 'contacted',          label: 'Contacted' },
  { key: 'viewing_scheduled',  label: 'Viewing scheduled' },
  { key: 'viewing_completed',  label: 'Viewing done' },
  { key: 'negotiating',        label: 'Negotiating' },
  { key: 'reservation',        label: 'Reservation' },
  { key: 'documentation',      label: 'Documentation' },
  { key: 'financing',          label: 'Financing' },
  { key: 'closing',            label: 'Closing' },
  { key: 'closed_won',         label: 'Closed (won)' },
  { key: 'closed_lost',        label: 'Closed (lost)' },
] as const

const route = useRoute()
const router = useRouter()

const stageFilter = ref<string>(String(route.query.stage_key ?? ''))
const mineOnly = ref<boolean>(String(route.query.mine ?? '') === 'true')

// Free-text search — matches against title + buyer contact name
// + listing title. Table mode hits the server (so it works across
// pages); board mode filters client-side (cards are all in memory).
// Synced to the URL ?q= so refreshes / shares preserve the term.
const searchQuery = ref<string>(String(route.query.q ?? ''))

// View toggle: 'table' (paginated list) | 'board' (kanban). Default is
// 'board' for new brokers — visual pipeline is more useful for the
// soft-launch persona than a dense table. Persisted per-user via
// localStorage so power users can stick with the table.
type ViewMode = 'table' | 'board'
const view = ref<ViewMode>('board')
if (import.meta.client) {
  const saved = localStorage.getItem('deals.view')
  if (saved === 'table' || saved === 'board') view.value = saved
}
function setView(next: ViewMode) {
  view.value = next
  if (import.meta.client) localStorage.setItem('deals.view', next)
}

// UiTabBar tab list — derived from STAGES with an "All" entry pinned
// at the front. Counts are intentionally not wired in (we don't have
// a server-side aggregate yet); add `count: stageCounts[s.key]` here
// when the backend exposes them.
const stageTabs = computed(() => [
  { value: '', label: 'All' },
  ...STAGES.map((s) => ({ value: s.key as string, label: s.label })),
])

const deals = ref<Deal[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(true)
const loadError = ref<string | null>(null)

async function load() {
  // Skip the table-mode fetch when the kanban is the active view —
  // the board owns its own data lifecycle. Saves a useless round-trip
  // on first paint for board users.
  if (view.value !== 'table') {
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const res = await $fetch<{
      data: Deal[]
      total: number
      total_pages: number
    }>('/api/deals', {
      query: {
        page: page.value,
        page_size: pageSize,
        stage_key: stageFilter.value || undefined,
        mine: mineOnly.value || undefined,
      },
    })
    deals.value = res.data ?? []
    total.value = res.total ?? 0
  } catch (err: any) {
    // Set an inline error so the table doesn't fall through to its
    // built-in empty state (which would look like "no deals"). The
    // toast still fires for parity with other pages but the persistent
    // error card is what the broker sees.
    loadError.value = err?.statusMessage || err?.message || 'Failed to load deals'
    deals.value = []
    total.value = 0
    showToast({
      title: loadError.value,
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

watch([stageFilter, mineOnly, searchQuery], () => {
  page.value = 1
  // Sync URL so deep-links work.
  router.replace({
    query: {
      ...(stageFilter.value ? { stage_key: stageFilter.value } : {}),
      ...(mineOnly.value ? { mine: 'true' } : {}),
      ...(searchQuery.value.trim() ? { q: searchQuery.value.trim() } : {}),
    },
  })
  load()
})

// When the user switches to the table view, fetch (board owns its own).
watch(view, (next) => {
  if (next === 'table') load()
})

onMounted(load)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

// Client-side search filter on the loaded page. Matches against
// deal title, buyer contact name, and listing title — the three
// strings a broker is likely to type. v1 only filters the visible
// page; server-side cross-page search can come later if pipelines
// grow larger than ~200 active deals per broker.
const filteredDeals = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return deals.value
  return deals.value.filter((d) => {
    const haystacks = [
      d.title ?? '',
      d.buyer_contact?.full_name ?? '',
      d.buyer_contact?.email ?? '',
      d.listing?.title ?? '',
    ]
    return haystacks.some((s) => s.toLowerCase().includes(q))
  })
})

const isEmpty = computed(() => !loading.value && filteredDeals.value.length === 0)

function stageLabel(key: string): string {
  const s = STAGES.find((x) => x.key === key)
  return s?.label || key
}

type BadgeVariant = 'success' | 'neutral' | 'primary' | 'warning'
function stageVariant(key: string): BadgeVariant {
  if (key === 'closed_won') return 'success'
  if (key === 'closed_lost') return 'neutral'
  if (key === 'reservation' || key === 'documentation' || key === 'financing' || key === 'closing') {
    return 'primary'
  }
  if (key === 'negotiating') return 'warning'
  return 'neutral'
}

const dealColumns = [
  { id: 'title', label: 'Title', tone: 'emphasis' as const },
  { id: 'client', label: 'Client' },
  { id: 'listing', label: 'Listing' },
  { id: 'stage', label: 'Stage' },
  { id: 'buyer_agent', label: 'Buyer agent', hideOnMobile: true },
  { id: 'value', label: 'Value', tone: 'numeric' as const },
  { id: 'updated', label: 'Updated', tone: 'muted' as const, hideOnMobile: true },
]

function formatPrice(d: Deal): string {
  if (d.deal_value != null) return `${d.currency} ${Number(d.deal_value).toLocaleString()}`
  if (d.listing?.sale_price) return `₱${Number(d.listing.sale_price).toLocaleString()}`
  if (d.listing?.rent_price) return `₱${Number(d.listing.rent_price).toLocaleString()} / mo`
  return '—'
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 86400_000) return 'today'
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <UiPageHeader title="Deals">
      <template #description>
        Pipeline of inquiries-turned-transactions. Convert from
        <NuxtLink to="/inquiries" class="font-medium text-primary hover:underline">
          Inquiries
        </NuxtLink>
        or create directly from a listing.
      </template>
      <template #actions>
        <!-- View toggle (table | board). Persisted to localStorage. -->
        <div
          role="tablist"
          aria-label="View mode"
          class="inline-flex overflow-hidden rounded-md border border-border bg-card text-xs font-medium"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="view === 'board'"
            class="px-2.5 py-1 transition-colors focus-ring"
            :class="view === 'board' ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'"
            @click="setView('board')"
          >
            Board
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="view === 'table'"
            class="border-l border-border px-2.5 py-1 transition-colors focus-ring"
            :class="view === 'table' ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'"
            @click="setView('table')"
          >
            Table
          </button>
        </div>
        <label class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <input
            v-model="mineOnly"
            type="checkbox"
            class="h-4 w-4 cursor-pointer accent-primary focus-ring"
          />
          Mine only
        </label>
        <UiBadge v-if="view === 'table'" variant="neutral" size="sm" :dot="true">
          <span class="tabular-nums">{{ total.toLocaleString() }} total</span>
        </UiBadge>
      </template>
    </UiPageHeader>

    <!-- Search bar — visible in both views. Free-text filter
         across title, buyer name, listing title. -->
    <label class="relative block max-w-md">
      <span class="sr-only">Search deals</span>
      <input
        v-model="searchQuery"
        type="search"
        placeholder="Search by title, client name, or listing…"
        class="block w-full rounded-md border border-input bg-card px-3 py-2 pl-9 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
      />
      <span
        aria-hidden="true"
        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
      >
        ⌕
      </span>
    </label>

    <!-- Kanban view: board owns its data + drag-to-transition. -->
    <DealsPipelineBoard
      v-if="view === 'board'"
      :mine-only="mineOnly"
      :search-query="searchQuery"
    />

    <!-- Stage filter pills — clicking sets the stage filter; All clears it.
         Only renders for the table view; in board mode, the columns ARE
         the stage filter. -->
    <UiTabBar
      v-if="view === 'table'"
      v-model="stageFilter"
      variant="pill"
      :tabs="stageTabs"
    />

    <!-- Inline error card for the table view. Differentiates a failed
         fetch from a healthy zero-row query — UiDataTable's empty slot
         would otherwise render "No deals" for both cases. -->
    <div
      v-if="view === 'table' && loadError"
      class="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
    >
      <p class="text-sm font-medium text-destructive">Could not load deals</p>
      <p class="mt-0.5 text-xs text-muted-foreground">{{ loadError }}</p>
      <button
        type="button"
        class="mt-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus-ring"
        @click="load"
      >
        Retry
      </button>
    </div>

    <UiDataTable
      v-if="view === 'table' && !loadError"
      :columns="dealColumns"
      :rows="filteredDeals"
      :loading="loading"
      :skeleton-rows="6"
      :row-key="(d: Deal) => d.id"
      @row-click="(d: Deal) => router.push(`/deals/${d.id}`)"
    >
      <template #cell-title="{ row }">
        <span class="font-semibold text-foreground">
          {{ row.title || `Deal ${row.id.slice(0, 8)}` }}
        </span>
      </template>
      <template #cell-client="{ row }">
        <span v-if="row.buyer_contact" class="text-xs text-foreground/80">
          <NuxtLink
            :to="`/contacts/${row.buyer_contact.id}`"
            class="font-medium text-primary hover:underline focus-ring rounded"
            @click.stop
          >
            {{ row.buyer_contact.full_name || `Contact #${row.buyer_contact.id}` }}
          </NuxtLink>
        </span>
        <span v-else class="text-xs text-muted-foreground italic">No client linked</span>
      </template>
      <template #cell-listing="{ row }">
        <div class="text-xs">
          <NuxtLink
            :to="`/listings/${row.listing_id}`"
            class="font-mono text-primary hover:underline focus-ring rounded"
            @click.stop
          >
            #{{ row.listing_id }}
          </NuxtLink>
          <p
            v-if="row.listing?.title"
            class="max-w-[240px] truncate text-muted-foreground"
          >
            {{ row.listing.title }}
          </p>
        </div>
      </template>
      <template #cell-stage="{ row }">
        <UiBadge :variant="stageVariant(row.stage_key)" size="xs">
          {{ stageLabel(row.stage_key) }}
        </UiBadge>
      </template>
      <template #cell-buyer_agent="{ row }">
        <span class="text-xs text-foreground/80">
          {{ row.buyer_agent?.full_name || '—' }}
        </span>
      </template>
      <template #cell-value="{ row }">
        <span class="text-xs tabular-nums text-foreground/80">
          {{ formatPrice(row) }}
        </span>
      </template>
      <template #cell-updated="{ row }">
        <span class="text-xs text-muted-foreground">
          {{ formatTs(row.updated_at) }}
        </span>
      </template>
      <template #empty>
        <EmptyState
          variant="neutral"
          size="cozy"
          title="No deals here yet"
          description="Convert an inquiry into a deal to start tracking it through the pipeline."
        >
          <template #cta>
            <NuxtLink
              to="/inquiries"
              class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
            >
              Open inquiries
            </NuxtLink>
          </template>
        </EmptyState>
      </template>
    </UiDataTable>

    <div
      v-if="view === 'table' && !loading && total > 0"
      class="flex items-center justify-between text-xs text-muted-foreground"
    >
      <p class="tabular-nums">
        Page {{ page }} of {{ totalPages }} · {{ total.toLocaleString() }} deals
      </p>
      <div class="flex gap-1">
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="page === 1 || loading"
          @click="page--; load()"
        >
          Previous
        </button>
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="page >= totalPages || loading"
          @click="page++; load()"
        >
          Next
        </button>
      </div>
    </div>
  </AdminPageShell>
</template>
