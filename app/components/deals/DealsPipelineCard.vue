<script setup lang="ts">
/**
 * One card in the kanban board. Renders the deal's headline data
 * (title, listing #, client, value, updated) and exposes drag
 * affordances. The parent owns drag state — this component only
 * fires `dragstart` / `dragend` so the parent can update its hover
 * targets and snapshot the pre-move state for revert.
 *
 * Click anywhere on the card body (not the listing #/client links,
 * which `@click.stop` themselves) navigates to /deals/[id].
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'

// Mirror of the Board's Deal type. The Card only renders a subset
// of the fields, but TypeScript needs structural identity between
// the parent's emit-handler param and the emit's declared payload —
// so we match the broader shape here even though some fields are
// unused. Pulling this into a shared type would be cleaner; deferred
// until a third consumer appears.
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
  buyer_contact: {
    id: number
    full_name: string | null
  } | null
  buyer_agent: {
    id: string
    full_name: string | null
  } | null
}

const props = defineProps<{
  deal: Deal
  /** True while this specific card is being dragged. Parent applies. */
  dragging?: boolean
  /** Stage list provided by the parent (single source of truth on the
   *  board) so the move-to menu lists exactly the stages the board
   *  shows. The card filters out the current stage itself. */
  stages: { key: string; label: string }[]
  /** Workflow progress for this deal, if a workflow exists. Null when
   *  no workflow has been started. Passed from the board's bulk-fetch. */
  workflowProgress?: { completed: number; total: number; status: string } | null
}>()

// Emit names are namespaced (cardDrag*) to avoid colliding with the
// native dragstart/dragend DOM events that fire on the article root —
// Vue/volar otherwise can't decide whether the parent's handler is for
// the emit or the native event, and the type narrows to the wrong one.
// Using the named-tuple form (Vue 3.4+) instead of call-signature
// because volar resolves multi-arg listener types more reliably.
const emit = defineEmits<{
  cardDragStart: [deal: Deal, ev: DragEvent]
  cardDragEnd: [deal: Deal]
  /** Click-driven stage change — keyboard / mobile fallback for drag.
   *  Parent handles it identically to a drop into the target column. */
  cardMoveRequest: [deal: Deal, newStageKey: string]
  open: [dealId: string]
}>()

// Move-to popover open state. We attach document-level listeners only
// while the menu is open to keep idle cost zero — the board can have
// dozens of cards and we don't want N standing listeners.
const moveMenuOpen = ref(false)

function toggleMoveMenu(ev: Event) {
  ev.stopPropagation()
  moveMenuOpen.value = !moveMenuOpen.value
}

function pickStage(key: string, ev: Event) {
  ev.stopPropagation()
  moveMenuOpen.value = false
  if (key === props.deal.stage_key) return
  emit('cardMoveRequest', props.deal, key)
}

function onDocumentClick() {
  // Any click reaching the document past the menu's stopPropagation
  // is "outside" — close.
  moveMenuOpen.value = false
}
function onDocumentKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') moveMenuOpen.value = false
}

watch(moveMenuOpen, (open) => {
  if (typeof window === 'undefined') return
  if (open) {
    document.addEventListener('click', onDocumentClick)
    document.addEventListener('keydown', onDocumentKey)
  } else {
    document.removeEventListener('click', onDocumentClick)
    document.removeEventListener('keydown', onDocumentKey)
  }
})

onBeforeUnmount(() => {
  if (typeof window === 'undefined') return
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKey)
})

function priceLabel(d: Deal): string {
  if (d.deal_value != null) {
    return `${d.currency} ${Number(d.deal_value).toLocaleString()}`
  }
  if (d.listing?.sale_price) {
    return `₱${Number(d.listing.sale_price).toLocaleString()}`
  }
  if (d.listing?.rent_price) {
    return `₱${Number(d.listing.rent_price).toLocaleString()}/mo`
  }
  return ''
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function onDragStart(ev: DragEvent) {
  if (ev.dataTransfer) {
    // We rely on parent state for the actual move, but also stash
    // the id in the dataTransfer payload so external drop targets
    // (or future cross-window drag) can read it.
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', props.deal.id)
  }
  emit('cardDragStart', props.deal, ev)
}

function onDragEnd() {
  emit('cardDragEnd', props.deal)
}
</script>

<template>
  <article
    :draggable="true"
    class="group relative cursor-grab rounded-md border border-border bg-card p-2.5 transition-all hover:border-border-strong hover:shadow-sm active:cursor-grabbing focus-ring"
    :class="{ 'opacity-40': dragging }"
    tabindex="0"
    role="button"
    :aria-label="`Open deal ${deal.title || deal.id.slice(0, 8)}`"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @click="emit('open', deal.id)"
    @keydown.enter.prevent="emit('open', deal.id)"
  >
    <!-- Move-to menu trigger. Anchored top-right of the card; the
         popover is keyboard- and mobile-accessible (drag isn't).
         Stops propagation so the card-open handler doesn't fire. -->
    <div class="absolute right-1 top-1 z-10">
      <button
        type="button"
        class="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-ring group-hover:opacity-100 group-focus-within:opacity-100"
        :class="{ 'opacity-100': moveMenuOpen }"
        :aria-haspopup="true"
        :aria-expanded="moveMenuOpen"
        :aria-label="`Move ${deal.title || 'deal'} to another stage`"
        @click="toggleMoveMenu"
        @keydown.enter.stop
        @keydown.space.stop
      >
        <span aria-hidden="true" class="text-xs">⋯</span>
      </button>
      <div
        v-if="moveMenuOpen"
        class="absolute right-0 mt-1 w-44 overflow-hidden rounded-md border border-border-strong bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-8px_rgba(15,23,42,0.16)]"
        role="menu"
      >
        <p class="border-b border-border bg-surface-2 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Move to
        </p>
        <button
          v-for="s in stages.filter((x) => x.key !== deal.stage_key)"
          :key="s.key"
          type="button"
          role="menuitem"
          class="block w-full border-b border-border px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent focus-ring last:border-b-0"
          @click="(ev) => pickStage(s.key, ev)"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <!-- Headline: title or fallback id -->
    <p class="mb-1 line-clamp-2 pr-6 text-xs font-semibold text-foreground">
      {{ deal.title || `Deal ${deal.id.slice(0, 8)}` }}
    </p>

    <!-- Workflow progress chip — shown only when a workflow exists -->
    <div v-if="workflowProgress" class="mb-1 flex items-center gap-1">
      <span
        v-if="workflowProgress.status === 'active'"
        class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
        :title="`Transfer workflow: ${workflowProgress.completed} / ${workflowProgress.total} steps complete`"
      >
        {{ workflowProgress.completed }}/{{ workflowProgress.total }}
      </span>
      <span
        v-else-if="workflowProgress.status === 'completed'"
        class="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success"
        title="Transfer workflow complete"
      >
        ✓ Transfer
      </span>
    </div>

    <!-- Listing pointer: clickable, separate from card open -->
    <p class="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">
      <NuxtLink
        :to="`/listings/${deal.listing_id}`"
        class="font-mono text-primary hover:underline focus-ring rounded"
        @click.stop
      >
        #{{ deal.listing_id }}
      </NuxtLink>
      <span v-if="deal.listing?.title" class="truncate">
        — {{ deal.listing.title }}
      </span>
    </p>

    <!-- Client + value row -->
    <div class="mb-1.5 flex items-center justify-between gap-1.5 text-[11px]">
      <span class="min-w-0 flex-1 truncate">
        <NuxtLink
          v-if="deal.buyer_contact"
          :to="`/contacts/${deal.buyer_contact.id}`"
          class="font-medium text-primary hover:underline focus-ring rounded"
          @click.stop
        >
          {{ deal.buyer_contact.full_name || `Contact #${deal.buyer_contact.id}` }}
        </NuxtLink>
        <span v-else class="italic text-muted-foreground">No client</span>
      </span>
      <span
        v-if="priceLabel(deal)"
        class="shrink-0 font-semibold tabular-nums text-foreground"
      >
        {{ priceLabel(deal) }}
      </span>
    </div>

    <!-- Meta strip: agent + updated -->
    <div class="flex items-center justify-between gap-2 border-t border-border pt-1.5 text-[10px] text-muted-foreground">
      <span class="truncate">
        {{ deal.buyer_agent?.full_name || 'Unassigned' }}
      </span>
      <span class="shrink-0 tabular-nums">{{ relativeTime(deal.updated_at) }}</span>
    </div>
  </article>
</template>
