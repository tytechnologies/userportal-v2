<script setup lang="ts">
// Listing-shares inbox + outgoing log.
//
// Two tabs:
//   - Incoming: shares where I'm the recipient. Pending ones get
//     accept/decline buttons; accepted/revoked are read-only history.
//   - Outgoing: shares I created. Read-only summary + revoke button.
//
// Both lists hit /api/listing-shares with direction= filter; RLS
// double-checks who can see what.

import { computed, onMounted, ref } from 'vue'
import {
  useListingShares,
  type ListingShare,
} from '~/composables/useListingShares'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })

const { listShares, acceptShare, declineShare, revokeShare } = useListingShares()

type Tab = 'incoming' | 'outgoing'
const tab = ref<Tab>('incoming')
const incoming = ref<ListingShare[]>([])
const outgoing = ref<ListingShare[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const supabase = useSupabaseClient()

// Listing summary cache so we can show "Listing #42 · Bahay Kubo" not
// just the bare id. Keyed by listing_id; populated lazily after the
// shares load.
const listingTitles = ref<Record<number, string>>({})

async function loadAll() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const [inc, out] = await Promise.all([
      listShares({ direction: 'incoming', pageSize: 100 }),
      listShares({ direction: 'outgoing', pageSize: 100 }),
    ])
    incoming.value = inc.data
    outgoing.value = out.data
    await populateListingTitles([...inc.data, ...out.data])
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load shares'
  } finally {
    isLoading.value = false
  }
}

async function populateListingTitles(shares: ListingShare[]) {
  const ids = Array.from(new Set(shares.map(s => s.listing_id)))
    .filter(id => listingTitles.value[id] === undefined)
  if (ids.length === 0) return
  // Single batched read; RLS may hide some rows (revoked share +
  // hidden listing) — those just won't appear in the cache, fall back
  // to "Listing #<id>" in the UI.
  const { data } = await (supabase as any)
    .from('listings')
    .select('id, title')
    .in('id', ids)
  for (const row of (data ?? [])) {
    listingTitles.value[row.id] = row.title || `Listing #${row.id}`
  }
}

function listingLabel(s: ListingShare) {
  return listingTitles.value[s.listing_id] ?? `Listing #${s.listing_id}`
}

const incomingPending = computed(() => incoming.value.filter(s => s.status === 'pending'))
const incomingHistory = computed(() => incoming.value.filter(s => s.status !== 'pending'))

async function onAccept(s: ListingShare) {
  try {
    const updated = await acceptShare(s.id)
    const idx = incoming.value.findIndex(x => x.id === s.id)
    if (idx >= 0) incoming.value[idx] = updated
    showToast({ title: 'Share accepted', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to accept', icon: 'error' })
  }
}

async function onDecline(s: ListingShare) {
  if (!confirm('Decline this share invite?')) return
  try {
    const updated = await declineShare(s.id)
    const idx = incoming.value.findIndex(x => x.id === s.id)
    if (idx >= 0) incoming.value[idx] = updated
    showToast({ title: 'Share declined', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to decline', icon: 'error' })
  }
}

async function onRevoke(s: ListingShare) {
  if (!confirm(`Revoke this share for ${listingLabel(s)}?`)) return
  try {
    const updated = await revokeShare(s.id)
    const idx = outgoing.value.findIndex(x => x.id === s.id)
    if (idx >= 0) outgoing.value[idx] = updated
    showToast({ title: 'Share revoked', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to revoke', icon: 'error' })
  }
}

function statusBadge(status: ListingShare['status']) {
  switch (status) {
    case 'pending':  return 'bg-warning/10 text-warning ring-warning/30'
    case 'accepted': return 'bg-success/10 text-success ring-success/30'
    case 'revoked':  return 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/15'
  }
}

function fmt(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

onMounted(loadAll)
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-4 px-4 py-6 sm:px-6 lg:px-8">
    <header>
      <h1 class="text-page-title">Listing shares</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Co-brokering invites — accept to gain access to a peer's listing.
      </p>
    </header>

    <!-- Tabs -->
    <nav
      class="flex gap-1 border-b border-border"
      aria-label="Share direction"
    >
      <button
        class="-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors"
        :class="
          tab === 'incoming'
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'
        "
        @click="tab = 'incoming'"
      >
        Incoming
        <span
          v-if="incomingPending.length > 0"
          class="rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-warning ring-1 ring-warning/30"
        >
          {{ incomingPending.length }}
        </span>
      </button>
      <button
        class="-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors"
        :class="
          tab === 'outgoing'
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'
        "
        @click="tab = 'outgoing'"
      >
        Outgoing
        <span class="text-xs tabular-nums text-muted-foreground/80">
          {{ outgoing.length }}
        </span>
      </button>
    </nav>

    <div v-if="isLoading" class="space-y-2">
      <div
        v-for="n in 4"
        :key="n"
        class="rounded-lg border border-border bg-card p-3"
      >
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="mt-2 h-2.5 w-1/2" />
      </div>
    </div>

    <section
      v-else-if="errorMessage"
      class="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </section>

    <!-- Incoming -->
    <div v-else-if="tab === 'incoming'" class="space-y-4">
      <section
        v-if="incomingPending.length > 0"
        class="rounded-lg border border-border bg-card"
      >
        <header class="border-b border-border px-5 py-3">
          <h2 class="text-sm font-semibold text-foreground">Pending invites</h2>
        </header>
        <ul class="divide-y divide-border">
          <li v-for="s in incomingPending" :key="s.id" class="px-5 py-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-foreground">
                  {{ listingLabel(s) }}
                </p>
                <p class="text-xs text-muted-foreground">
                  Role: <span class="font-medium text-foreground/80">{{ s.share_role }}</span>
                  · Sent {{ fmt(s.created_at) }}
                  <span v-if="s.expires_at"> · expires {{ fmt(s.expires_at) }}</span>
                </p>
                <p
                  v-if="s.message"
                  class="mt-2 rounded-lg border border-border bg-muted-foreground/5 p-2 text-sm text-foreground/85"
                >
                  "{{ s.message }}"
                </p>
              </div>
              <div class="flex shrink-0 gap-2">
                <button
                  class="rounded-lg bg-success px-3 py-1.5 text-xs font-semibold text-success-foreground transition-colors hover:bg-success/90"
                  @click="onAccept(s)"
                >
                  Accept
                </button>
                <button
                  class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                  @click="onDecline(s)"
                >
                  Decline
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section class="rounded-lg border border-border bg-card">
        <header class="border-b border-border px-5 py-3">
          <h2 class="text-sm font-semibold text-foreground">History</h2>
        </header>
        <ul v-if="incomingHistory.length > 0" class="divide-y divide-border">
          <li
            v-for="s in incomingHistory"
            :key="s.id"
            class="flex items-center justify-between px-5 py-3"
          >
            <div>
              <p class="text-sm text-foreground">{{ listingLabel(s) }}</p>
              <p class="text-xs text-muted-foreground">{{ fmt(s.updated_at) }}</p>
            </div>
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1"
              :class="statusBadge(s.status)"
            >
              {{ s.status }}
            </span>
          </li>
        </ul>
        <EmptyState
          v-else
          variant="neutral"
          size="compact"
          title="No past invites"
          description="Accepted, declined, and revoked invites will land here."
        />
      </section>
    </div>

    <!-- Outgoing -->
    <section v-else class="rounded-lg border border-border bg-card">
      <header class="border-b border-border px-5 py-3">
        <h2 class="text-sm font-semibold text-foreground">Shares you've sent</h2>
      </header>
      <ul v-if="outgoing.length > 0" class="divide-y divide-border">
        <li v-for="s in outgoing" :key="s.id" class="px-5 py-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-foreground">
                {{ listingLabel(s) }}
              </p>
              <p class="text-xs text-muted-foreground">
                Role: {{ s.share_role }} · Sent {{ fmt(s.created_at) }}
                <span v-if="s.expires_at"> · expires {{ fmt(s.expires_at) }}</span>
              </p>
            </div>
            <div class="flex items-center gap-2">
              <span
                class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1"
                :class="statusBadge(s.status)"
              >
                {{ s.status }}
              </span>
              <button
                v-if="s.status !== 'revoked'"
                class="rounded-md px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                @click="onRevoke(s)"
              >
                Revoke
              </button>
            </div>
          </div>
        </li>
      </ul>
      <EmptyState
        v-else
        variant="neutral"
        size="cozy"
        title="No shares sent yet"
        description="Open any listing's actions menu and pick Share to send a co-broker invite."
      />
    </section>
  </div>
</template>
