<script setup lang="ts">
/**
 * Pipeline kanban — 11 columns, one per stage.
 *
 * Loads deals via /api/deals?mine={mineOnly}&page_size=200 in a single
 * round-trip and buckets client-side by stage_key. For an active
 * broker that fits comfortably; the cap is the server's MAX_PAGE_SIZE
 * (200) — if a brokerage outgrows that we'll switch to per-column
 * fetches. Today, single-fetch keeps things simple.
 *
 * Drag-to-transition wiring:
 *   - Each card emits dragstart/dragend; the board tracks
 *     {dragId, dragFromStage}.
 *   - Each column listens for dragenter/dragover.prevent + drop.
 *   - On drop into a different stage, the card moves locally (the
 *     deal's stage_key is mutated) and PATCH /api/deals/:id/stage
 *     fires. On 4xx/5xx the local mutation is reverted from the
 *     snapshot taken at dragstart.
 *
 * Closed columns (won/lost) are collapsed by default so they don't
 * eat horizontal real estate; a chip at the top reveals them.
 */
import { computed, onMounted, ref, watch } from 'vue'
import DealsPipelineCard from '~/components/deals/DealsPipelineCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import { showToast } from '~/helpers/helpers'

type Deal = {
  id: string
  listing_id: number
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
  } | null
  buyer_agent: {
    id: string
    full_name: string | null
  } | null
  buyer_contact: {
    id: number
    full_name: string | null
  } | null
}

// Stage list mirrors /deals/index.vue + /deals/[id].vue. Kept inline
// rather than imported from a shared module because the shared module
// would be load-bearing on three call sites with no other consumers.
const STAGES: { key: string; label: string; tone: 'neutral' | 'primary' | 'warning' | 'success' | 'destructive'; closed?: boolean }[] = [
  { key: 'inquiry_received',   label: 'Inquiry',          tone: 'neutral' },
  { key: 'contacted',          label: 'Contacted',        tone: 'neutral' },
  { key: 'viewing_scheduled',  label: 'Viewing scheduled', tone: 'primary' },
  { key: 'viewing_completed',  label: 'Viewing done',      tone: 'primary' },
  { key: 'negotiating',        label: 'Negotiating',       tone: 'warning' },
  { key: 'reservation',        label: 'Reservation',       tone: 'primary' },
  { key: 'documentation',      label: 'Documentation',     tone: 'primary' },
  { key: 'financing',          label: 'Financing',         tone: 'primary' },
  { key: 'closing',            label: 'Closing',           tone: 'primary' },
  { key: 'closed_won',         label: 'Won',               tone: 'success',     closed: true },
  { key: 'closed_lost',        label: 'Lost',              tone: 'destructive', closed: true },
]

const props = defineProps<{
  /** Mirror of the parent's "Mine only" toggle. When true, server-
   *  side filters to deals where the caller participates. */
  mineOnly: boolean
  /** Free-text filter passed from the page. Matches title, buyer
   *  name, listing title. Empty string = no filter. */
  searchQuery?: string
}>()

const deals = ref<Deal[]>([])
const loading = ref(true)
const errored = ref(false)
const showClosed = ref(false)
const workflowProgressByDealId = ref<Record<string, { completed: number; total: number; status: string }>>({})

// Drag state. dragFromStage is the snapshot we revert to if the
// PATCH fails — we set the new stage optimistically before the
// network call, so we need to remember where the card came from.
const dragId = ref<string | null>(null)
const dragFromStage = ref<string | null>(null)
const dragHoverStage = ref<string | null>(null)

async function loadWorkflowProgress(dealIds: string[]) {
  if (dealIds.length === 0) { workflowProgressByDealId.value = {}; return }
  const supabase = useSupabaseClient()
  const { data: wfs } = await (supabase as any)
    .from('deal_workflows')
    .select('id, deal_id, status')
    .in('deal_id', dealIds)
  if (!wfs || wfs.length === 0) { workflowProgressByDealId.value = {}; return }
  const wfIds = (wfs as Array<{ id: string; deal_id: string; status: string }>).map((w) => w.id)
  const { data: steps } = await (supabase as any)
    .from('deal_workflow_steps')
    .select('workflow_id, status')
    .in('workflow_id', wfIds)
  const byWf: Record<string, { completed: number; total: number }> = {}
  for (const s of ((steps ?? []) as Array<{ workflow_id: string; status: string }>)) {
    if (s.status === 'skipped') continue
    if (!byWf[s.workflow_id]) byWf[s.workflow_id] = { completed: 0, total: 0 }
    const bucket = byWf[s.workflow_id]!
    bucket.total += 1
    if (s.status === 'completed') bucket.completed += 1
  }
  const next: Record<string, { completed: number; total: number; status: string }> = {}
  for (const w of (wfs as Array<{ id: string; deal_id: string; status: string }>)) {
    const p = byWf[w.id] ?? { completed: 0, total: 0 }
    next[w.deal_id] = { ...p, status: w.status }
  }
  workflowProgressByDealId.value = next
}

async function load() {
  loading.value = true
  errored.value = false
  try {
    const res = await $fetch<{ data: Deal[] }>('/api/deals', {
      query: { mine: props.mineOnly || undefined, page: 1, page_size: 200 },
    })
    deals.value = res.data ?? []
    await loadWorkflowProgress(deals.value.map((d) => d.id))
  } catch {
    // Persistent inline error card — a transient toast disappears in
    // ~5s and then the board falls back to the "no deals" empty state,
    // which is indistinguishable from a healthy zero-data board. The
    // broker needs to know whether the pipeline is actually empty or
    // the fetch failed.
    deals.value = []
    workflowProgressByDealId.value = {}
    errored.value = true
  } finally {
    loading.value = false
  }
}

onMounted(load)

// Re-fetch when the parent flips Mine/All.
watch(() => props.mineOnly, load)

/** Expose refresh to parent (for a Refresh button on the toolbar). */
defineExpose({ refresh: load })

const visibleStages = computed(() =>
  STAGES.filter((s) => showClosed.value || !s.closed),
)

// Free-text filter — matches against the same haystack the table
// uses (title, buyer name, listing title). Pre-computed so it runs
// once per filter change, not once per card render.
const visibleDeals = computed(() => {
  const q = (props.searchQuery ?? '').trim().toLowerCase()
  if (!q) return deals.value
  return deals.value.filter((d) => {
    const haystacks = [
      d.title ?? '',
      d.buyer_contact?.full_name ?? '',
      d.listing?.title ?? '',
    ]
    return haystacks.some((s) => s.toLowerCase().includes(q))
  })
})

// Bucket deals by stage_key. Unknown stages (data drift) land in a
// fallback bucket so they're never silently dropped.
const cardsByStage = computed(() => {
  const out: Record<string, Deal[]> = {}
  for (const s of STAGES) out[s.key] = []
  const orphaned: Deal[] = []
  for (const d of visibleDeals.value) {
    const bucket = out[d.stage_key]
    if (bucket) {
      bucket.push(d)
    } else {
      orphaned.push(d)
    }
  }
  // Sort each bucket by stage_entered_at desc — newest at the top.
  for (const bucket of Object.values(out)) {
    bucket.sort((a, b) => {
      const ta = new Date(a.stage_entered_at || a.updated_at).getTime()
      const tb = new Date(b.stage_entered_at || b.updated_at).getTime()
      return tb - ta
    })
  }
  return { byStage: out, orphaned }
})

function columnSummary(key: string): { count: number; sum: string } {
  const bucket = cardsByStage.value.byStage[key] || []
  const count = bucket.length
  let total = 0
  let cur = '₱'
  for (const d of bucket) {
    if (d.deal_value != null) {
      total += Number(d.deal_value)
      cur = d.currency || '₱'
    } else if (d.listing?.sale_price) {
      total += Number(d.listing.sale_price)
    }
  }
  const sum = total > 0 ? `${cur === 'PHP' ? '₱' : cur} ${total.toLocaleString()}` : ''
  return { count, sum }
}

function onDragStart(deal: Deal, _ev: DragEvent) {
  dragId.value = deal.id
  dragFromStage.value = deal.stage_key
}

function onDragEnd() {
  dragId.value = null
  dragFromStage.value = null
  dragHoverStage.value = null
}

function onColumnDragOver(ev: DragEvent, stageKey: string) {
  if (!dragId.value) return
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  dragHoverStage.value = stageKey
}

function onColumnDragLeave(stageKey: string) {
  if (dragHoverStage.value === stageKey) {
    dragHoverStage.value = null
  }
}

/**
 * Shared move primitive — handles drag-drop AND click-driven moves.
 * Optimistic mutation, network call, revert on failure. Centralized so
 * the two entry points (drop + cardMoveRequest) can never diverge.
 */
async function moveDeal(id: string, from: string, to: string) {
  if (from === to) return
  const row = deals.value.find((d) => d.id === id)
  if (!row) return
  row.stage_key = to
  row.stage_entered_at = new Date().toISOString()

  try {
    await $fetch(`/api/deals/${id}/stage`, {
      method: 'PATCH',
      body: { stage_key: to },
    })
    showToast({
      title: `Moved to ${STAGES.find((s) => s.key === to)?.label || to}`,
      icon: 'success',
    })
  } catch (err: any) {
    row.stage_key = from
    showToast({
      title: err?.statusMessage || err?.message || 'Stage transition failed',
      icon: 'error',
    })
  }
}

async function onColumnDrop(stageKey: string) {
  const id = dragId.value
  const from = dragFromStage.value
  dragId.value = null
  dragFromStage.value = null
  dragHoverStage.value = null
  if (!id || !from) return
  await moveDeal(id, from, stageKey)
}

function onCardMoveRequest(deal: Deal, newStageKey: string) {
  void moveDeal(deal.id, deal.stage_key, newStageKey)
}

function openDeal(id: string) {
  if (typeof navigateTo === 'function') {
    navigateTo(`/deals/${id}`)
  }
}

// True when there are no deals at all (different copy from the
// "no matches" state shown when a search filter narrows everything out).
const isEmpty = computed(() => !loading.value && deals.value.length === 0)
const hasNoMatches = computed(
  () => !loading.value && deals.value.length > 0 && visibleDeals.value.length === 0,
)
</script>

<template>
  <div class="space-y-3">
    <!-- Toolbar: closed-stages reveal, orphan badge -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-ring"
          @click="showClosed = !showClosed"
        >
          <span aria-hidden="true">{{ showClosed ? '−' : '+' }}</span>
          {{ showClosed ? 'Hide' : 'Show' }} closed
        </button>
        <span
          v-if="cardsByStage.orphaned.length > 0"
          class="text-[11px] text-warning"
          :title="`${cardsByStage.orphaned.length} deal(s) have an unrecognized stage_key — open the deal page to fix.`"
        >
          ⚠ {{ cardsByStage.orphaned.length }} unrecognized stage
        </span>
      </div>
      <p class="text-[11px] text-muted-foreground">
        Drag a card to move it to another stage.
      </p>
    </div>

    <!-- Loading skeleton: rough column shapes so the layout doesn't
         pop when data lands. -->
    <div v-if="loading" class="grid grid-flow-col auto-cols-[minmax(280px,1fr)] gap-3 overflow-x-auto pb-2">
      <div
        v-for="n in 6"
        :key="n"
        class="rounded-lg border border-border bg-surface-2 p-3"
      >
        <div class="mb-3 h-4 w-24 animate-pulse rounded bg-muted-foreground/15" />
        <div class="space-y-2">
          <div class="h-16 animate-pulse rounded bg-muted-foreground/10" />
          <div class="h-16 animate-pulse rounded bg-muted-foreground/10" />
        </div>
      </div>
    </div>

    <!-- Error state — fetch failed. Differentiates from "no deals"
         so the broker doesn't assume their pipeline is empty when
         really the request 401'd / 500'd. -->
    <div
      v-else-if="errored"
      class="rounded-lg border border-destructive/30 bg-destructive/5 px-5 py-8 text-center"
    >
      <p class="text-sm font-medium text-destructive">Could not load pipeline</p>
      <p class="mt-1 text-xs text-muted-foreground">
        Network or permission error. Refresh, or hit retry below.
      </p>
      <button
        type="button"
        class="mt-3 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus-ring"
        @click="load"
      >
        Retry
      </button>
    </div>

    <!-- Empty state — no deals at all -->
    <div
      v-else-if="isEmpty"
      class="rounded-lg border border-dashed border-border bg-surface-2 px-5 py-10 text-center"
    >
      <p class="text-sm font-medium text-foreground">No deals on the board</p>
      <p class="mt-1 text-xs text-muted-foreground">
        Convert an
        <NuxtLink to="/inquiries" class="font-medium text-primary hover:underline">inquiry</NuxtLink>
        into a deal to start tracking it through the pipeline.
      </p>
    </div>

    <!-- No-matches state — there are deals, but the search filter
         narrowed them all out. Different copy so the broker doesn't
         think their pipeline is empty. -->
    <div
      v-else-if="hasNoMatches"
      class="rounded-lg border border-dashed border-border bg-surface-2 px-5 py-10 text-center"
    >
      <p class="text-sm font-medium text-foreground">No deals match this search</p>
      <p class="mt-1 text-xs text-muted-foreground">
        {{ deals.length.toLocaleString() }} deals on the board — try a
        different name, listing title, or clear the search.
      </p>
    </div>

    <!-- Board. Columns are 240px wide on mobile (was 280px) so brokers
         see more pipeline at a glance on a phone; scroll-snap-x means
         each swipe lands on a column boundary instead of mid-card. On
         tablet+ we expand back to 280px for comfortable card density. -->
    <div
      v-else
      class="grid grid-flow-col auto-cols-[minmax(240px,1fr)] gap-3 overflow-x-auto pb-2 [scroll-snap-type:x_mandatory] [scroll-behavior:smooth] sm:auto-cols-[minmax(280px,1fr)]"
    >
      <section
        v-for="stage in visibleStages"
        :key="stage.key"
        class="flex max-h-[calc(100vh-260px)] min-w-0 flex-col rounded-lg border bg-surface-2 transition-colors [scroll-snap-align:start]"
        :class="
          dragHoverStage === stage.key
            ? 'border-primary bg-primary/5 ring-2 ring-primary/40'
            : 'border-border'
        "
        @dragover="(ev) => onColumnDragOver(ev, stage.key)"
        @dragleave="onColumnDragLeave(stage.key)"
        @drop="onColumnDrop(stage.key)"
      >
        <!-- Column header -->
        <header class="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <UiBadge :variant="stage.tone" size="xs">
              {{ stage.label }}
            </UiBadge>
            <span class="text-[11px] tabular-nums text-muted-foreground">
              {{ columnSummary(stage.key).count }}
            </span>
          </div>
          <span
            v-if="columnSummary(stage.key).sum"
            class="truncate text-[10px] tabular-nums text-muted-foreground"
            :title="columnSummary(stage.key).sum"
          >
            {{ columnSummary(stage.key).sum }}
          </span>
        </header>

        <!-- Card stack — scrolls within the column when long -->
        <div class="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
          <DealsPipelineCard
            v-for="deal in cardsByStage.byStage[stage.key] || []"
            :key="deal.id"
            :deal="deal"
            :dragging="dragId === deal.id"
            :stages="visibleStages"
            :workflow-progress="workflowProgressByDealId[deal.id] ?? null"
            @card-drag-start="onDragStart"
            @card-drag-end="onDragEnd"
            @card-move-request="onCardMoveRequest"
            @open="openDeal"
          />
          <p
            v-if="(cardsByStage.byStage[stage.key] || []).length === 0"
            class="rounded-md border border-dashed border-border px-2 py-3 text-center text-[10px] text-muted-foreground"
          >
            Drop a card here
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
