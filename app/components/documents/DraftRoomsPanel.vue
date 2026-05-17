<script setup lang="ts">
/**
 * Transaction-rooms section on the draft detail page.
 *
 * Two halves:
 *   - List of rooms this draft is linked to (deep-link to each)
 *   - Composer to link the draft to another room. The composer is a
 *     mini-typeahead against /api/transaction-rooms — broker types,
 *     picks one, clicks Add. Existing links de-duplicated server-
 *     side via the (room_id, draft_id) UNIQUE.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import UiBadge from '~/components/ui/UiBadge.vue'

type Room = {
  id: string
  name: string
  status: 'open' | 'in_review' | 'closed' | 'archived' | 'cancelled'
  listing_id: number | null
  deal_id: string | null
}
type RoomLink = {
  id: string
  room_id: string
  added_at: string
  room: Room | null
}

const props = defineProps<{
  draftId: string
}>()

const links = ref<RoomLink[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: RoomLink[] }>(
      `/api/document-drafts/${props.draftId}/rooms`,
    )
    links.value = res.data ?? []
  } catch {
    links.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.draftId, load)

// ----- Add-to-room composer (typeahead) -----------------------------
const search = ref('')
const matches = ref<Room[]>([])
const searching = ref(false)
const picked = ref<Room | null>(null)
const adding = ref(false)
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

async function runSearch() {
  const q = search.value.trim()
  if (q.length < 2) { matches.value = []; return }
  searching.value = true
  const seq = ++searchSeq
  try {
    // /api/transaction-rooms doesn't have a server-side q filter yet;
    // we pull a page and filter client-side. Pages are small (≤100)
    // so this is cheap. If a brokerage outgrows it, add q server-side.
    const res = await $fetch<{ data: Room[] }>('/api/transaction-rooms', {
      query: { mine: true, page_size: 100 },
    })
    if (seq !== searchSeq) return
    const lowered = q.toLowerCase()
    matches.value = (res.data ?? []).filter((r) => r.name.toLowerCase().includes(lowered))
  } catch {
    if (seq === searchSeq) matches.value = []
  } finally {
    if (seq === searchSeq) searching.value = false
  }
}

watch(search, (v) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!v.trim()) { matches.value = []; picked.value = null; return }
  if (picked.value && v !== picked.value.name) picked.value = null
  searchTimer = setTimeout(runSearch, 220)
})

function pickRoom(r: Room) {
  picked.value = r
  search.value = r.name
  matches.value = []
}

async function attach() {
  if (!picked.value || adding.value) return
  adding.value = true
  try {
    await $fetch(`/api/transaction-rooms/${picked.value.id}/documents`, {
      method: 'POST',
      body: { draft_id: props.draftId },
    })
    search.value = ''
    picked.value = null
    matches.value = []
    await load()
    showToast({ title: 'Attached to transaction', icon: 'success' })
  } catch (err: any) {
    // Unique-constraint violations surface as 500 with the PG code
    // — surface as "already linked" friendly message.
    const m = err?.statusMessage || err?.message || ''
    if (m.includes('duplicate key') || m.includes('unique constraint')) {
      showToast({ title: 'Already linked to that transaction.', icon: 'error' })
    } else {
      showToast({
        title: m || 'Could not attach',
        icon: 'error',
      })
    }
  } finally {
    adding.value = false
  }
}

type StatusVariant = 'success' | 'neutral' | 'primary' | 'warning' | 'destructive'
function statusVariant(s: Room['status']): StatusVariant {
  switch (s) {
    case 'open':      return 'primary'
    case 'in_review': return 'warning'
    case 'closed':    return 'success'
    case 'archived':  return 'neutral'
    case 'cancelled': return 'destructive'
  }
}
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3">
      <h3 class="text-card-title">
        Transaction rooms
        <UiBadge
          v-if="links.length > 0"
          variant="neutral"
          size="xs"
          class="ml-1"
        >
          {{ links.length }}
        </UiBadge>
      </h3>
      <p class="mt-0.5 text-meta">
        Closing rooms this draft is part of. A room is the operational
        container that bundles documents, signatures, and audit trail
        for one transaction.
      </p>
    </header>

    <!-- Existing links -->
    <p
      v-if="loading && links.length === 0"
      class="text-xs text-muted-foreground"
    >
      Loading…
    </p>
    <p
      v-else-if="links.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      Not attached to a transaction yet. Pick or create one below to
      surface this draft on the closing room.
    </p>
    <ul v-else class="mb-3 space-y-1.5">
      <li
        v-for="l in links"
        :key="l.id"
        class="flex flex-wrap items-baseline gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
      >
        <UiBadge v-if="l.room" :variant="statusVariant(l.room.status)" size="xs">
          {{ l.room.status.replace('_', ' ') }}
        </UiBadge>
        <NuxtLink
          v-if="l.room"
          :to="`/transactions/${l.room.id}`"
          class="font-semibold text-primary hover:underline focus-ring rounded"
        >
          {{ l.room.name }}
        </NuxtLink>
        <span class="ml-auto text-[10px] text-muted-foreground tabular-nums">
          attached {{ new Date(l.added_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }}
        </span>
      </li>
    </ul>

    <!-- Attach composer -->
    <form
      class="grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_auto]"
      @submit.prevent="attach"
    >
      <div class="relative">
        <input
          v-model="search"
          type="text"
          maxlength="200"
          placeholder="Find or create a transaction room…"
          autocomplete="off"
          class="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
        <div
          v-if="matches.length > 0 && !picked"
          class="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border-strong bg-card shadow-lg"
        >
          <button
            v-for="m in matches"
            :key="m.id"
            type="button"
            class="block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-accent focus-ring last:border-b-0"
            @click="pickRoom(m)"
          >
            <span class="font-semibold text-foreground">{{ m.name }}</span>
            <span class="ml-1 text-muted-foreground">{{ m.status.replace('_', ' ') }}</span>
          </button>
        </div>
        <p
          v-else-if="searching"
          class="mt-1 text-[11px] text-muted-foreground"
        >
          Searching…
        </p>
        <p
          v-else-if="search.trim().length >= 2 && matches.length === 0 && !picked"
          class="mt-1 text-[11px] text-muted-foreground"
        >
          No match.
          <NuxtLink to="/transactions" class="text-primary hover:underline">
            Create a new room →
          </NuxtLink>
        </p>
      </div>
      <button
        type="submit"
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
        :disabled="!picked || adding"
      >
        {{ adding ? 'Attaching…' : 'Attach' }}
      </button>
    </form>
  </section>
</template>
