<script setup lang="ts">
/**
 * Deals on this client — companion section for /contacts/[id].
 *
 * Lists every deal where this contact is the buyer (RLS still scopes
 * to deals the caller can see; the contact_id filter is applied
 * server-side via /api/deals?contact_id=…). Shows the active /
 * closed split inline so a broker can scan their relationship status
 * with this client at a glance.
 *
 * Each row: stage badge, listing link, value, last-touch time. Click
 * opens the deal detail page. New-deal CTA navigates to /listings
 * — the broker picks a listing first, then uses the listing-side
 * "Start a deal" wizard to attach this client. The reverse direction
 * (deal-first, then pick listing) doesn't exist in v1 because deals
 * are always anchored to a specific listing.
 */
import { computed, onMounted, ref, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'

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
  updated_at: string
  listing: {
    id: number
    title: string | null
    sale_price: number | null
    rent_price: number | null
  } | null
}

const props = defineProps<{
  /** Contact id to scope deals to. Section renders nothing when null. */
  contactId: number | null
}>()

const deals = ref<Deal[]>([])
const loading = ref(false)
const errored = ref(false)

async function load() {
  if (!props.contactId) {
    deals.value = []
    return
  }
  loading.value = true
  errored.value = false
  try {
    const res = await $fetch<{ data: Deal[] }>('/api/deals', {
      query: { contact_id: props.contactId, page_size: 100 },
    })
    deals.value = res.data ?? []
  } catch {
    deals.value = []
    errored.value = true
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.contactId, load)

// Active = pipeline-state. Closed = won/lost. Splitting them lets the
// active list stay visually dominant while archived history is one
// click away when the broker actually wants it.
const active = computed(() =>
  deals.value.filter((d) => d.stage_key !== 'closed_won' && d.stage_key !== 'closed_lost'),
)
const closed = computed(() =>
  deals.value.filter((d) => d.stage_key === 'closed_won' || d.stage_key === 'closed_lost'),
)
const showClosed = ref(false)

function stageLabel(key: string): string {
  switch (key) {
    case 'inquiry_received':   return 'Inquiry'
    case 'contacted':          return 'Contacted'
    case 'viewing_scheduled':  return 'Viewing scheduled'
    case 'viewing_completed':  return 'Viewing done'
    case 'negotiating':        return 'Negotiating'
    case 'reservation':        return 'Reservation'
    case 'documentation':      return 'Documentation'
    case 'financing':          return 'Financing'
    case 'closing':            return 'Closing'
    case 'closed_won':         return 'Won'
    case 'closed_lost':        return 'Lost'
    default:                    return key
  }
}

type StageVariant = 'success' | 'neutral' | 'primary' | 'warning' | 'destructive'
function stageVariant(key: string): StageVariant {
  if (key === 'closed_won') return 'success'
  if (key === 'closed_lost') return 'destructive'
  if (key === 'reservation' || key === 'documentation' || key === 'financing' || key === 'closing') {
    return 'primary'
  }
  if (key === 'negotiating') return 'warning'
  return 'neutral'
}

function priceLabel(d: Deal): string {
  if (d.deal_value != null) return `${d.currency} ${Number(d.deal_value).toLocaleString()}`
  if (d.listing?.sale_price) return `₱${Number(d.listing.sale_price).toLocaleString()}`
  if (d.listing?.rent_price) return `₱${Number(d.listing.rent_price).toLocaleString()}/mo`
  return '—'
}

function relativeTime(iso: string): string {
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

function openDeal(d: Deal) {
  if (typeof navigateTo === 'function') {
    navigateTo(`/deals/${d.id}`)
  }
}
</script>

<template>
  <section v-if="contactId !== null" class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-3">
      <div>
        <h3 class="text-card-title">Deals on this client</h3>
        <p class="mt-0.5 text-meta">
          Pipeline activity where this contact is the buyer.
        </p>
      </div>
      <NuxtLink
        to="/listings"
        class="text-xs font-medium text-primary hover:underline focus-ring rounded"
      >
        + Start a deal
      </NuxtLink>
    </header>

    <!-- Loading skeleton -->
    <div v-if="loading" class="space-y-1.5">
      <div
        v-for="n in 2"
        :key="n"
        class="flex items-center gap-2 rounded-md border border-border bg-card p-2"
      >
        <div class="h-3 w-1/2 animate-pulse rounded bg-muted-foreground/15" />
        <div class="ml-auto h-3 w-12 animate-pulse rounded bg-muted-foreground/15" />
      </div>
    </div>

    <p
      v-else-if="errored"
      class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      Could not load deals. Try refreshing the page.
    </p>

    <!-- Empty state — encourages the broker to start a deal here when
         the client has no pipeline activity yet. -->
    <div
      v-else-if="deals.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      No deals linked to this client yet. Open a listing and use
      <span class="font-semibold">Start a deal</span> to track one.
    </div>

    <div v-else class="space-y-3">
      <!-- Active pipeline -->
      <div v-if="active.length > 0">
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Active ({{ active.length }})
        </p>
        <ul class="space-y-1.5">
          <li
            v-for="d in active"
            :key="d.id"
            class="group flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-border-strong hover:bg-accent focus-ring"
            tabindex="0"
            @click="openDeal(d)"
            @keydown.enter.prevent="openDeal(d)"
            @keydown.space.prevent="openDeal(d)"
          >
            <UiBadge :variant="stageVariant(d.stage_key)" size="xs">
              {{ stageLabel(d.stage_key) }}
            </UiBadge>
            <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {{ d.title || d.listing?.title || `Deal ${d.id.slice(0, 8)}` }}
            </span>
            <span class="shrink-0 text-[11px] tabular-nums text-foreground/80">
              {{ priceLabel(d) }}
            </span>
            <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {{ relativeTime(d.updated_at) }}
            </span>
          </li>
        </ul>
      </div>

      <!-- Closed history — collapsed by default. Brokers want active
           pipeline visible by default; closed deals are reference. -->
      <div v-if="closed.length > 0">
        <button
          type="button"
          class="mb-1.5 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground focus-ring rounded"
          @click="showClosed = !showClosed"
        >
          <span aria-hidden="true">{{ showClosed ? '▾' : '▸' }}</span>
          Closed ({{ closed.length }})
        </button>
        <ul v-if="showClosed" class="space-y-1.5">
          <li
            v-for="d in closed"
            :key="d.id"
            class="group flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 transition-colors hover:border-border-strong hover:bg-accent focus-ring"
            tabindex="0"
            @click="openDeal(d)"
            @keydown.enter.prevent="openDeal(d)"
            @keydown.space.prevent="openDeal(d)"
          >
            <UiBadge :variant="stageVariant(d.stage_key)" size="xs">
              {{ stageLabel(d.stage_key) }}
            </UiBadge>
            <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground/80">
              {{ d.title || d.listing?.title || `Deal ${d.id.slice(0, 8)}` }}
            </span>
            <span class="shrink-0 text-[11px] tabular-nums text-foreground/70">
              {{ priceLabel(d) }}
            </span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
