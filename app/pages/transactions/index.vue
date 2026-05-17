<script setup lang="ts">
/**
 * /transactions — list of transaction rooms.
 *
 * A transaction room is the operational container for a closing:
 * participants, documents, files, signatures, audit log. It can be
 * spawned standalone or anchored to an existing deal/listing.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiCard from '~/components/ui/UiCard.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Transactions | Housing Interactive' })

type Room = {
  id: string
  name: string
  status: 'open' | 'in_review' | 'closed' | 'archived' | 'cancelled'
  listing_id: number | null
  deal_id: string | null
  buyer_contact_id: number | null
  closed_at: string | null
  updated_at: string
  listing: { id: number; title: string | null } | null
  buyer_contact: { id: number; full_name: string | null } | null
}

const route = useRoute()
const router = useRouter()

const status = ref<string>(String(route.query.status ?? ''))
const mineOnly = ref<boolean>(String(route.query.mine ?? '') === 'true')

const rooms = ref<Room[]>([])
const total = ref(0)
const loading = ref(true)
const creating = ref(false)
const newName = ref('')

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Room[]; total: number }>('/api/transaction-rooms', {
      query: {
        status: status.value || undefined,
        mine: mineOnly.value || undefined,
        page_size: 100,
      },
    })
    rooms.value = res.data ?? []
    total.value = res.total ?? 0
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load transactions',
      icon: 'error',
    })
    rooms.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch([status, mineOnly], () => {
  router.replace({
    query: {
      ...(status.value ? { status: status.value } : {}),
      ...(mineOnly.value ? { mine: 'true' } : {}),
    },
  })
  load()
})

async function create() {
  if (!newName.value.trim() || creating.value) return
  creating.value = true
  try {
    const room = await $fetch<{ id: string }>('/api/transaction-rooms', {
      method: 'POST',
      body: { name: newName.value.trim() },
    })
    showToast({ title: 'Transaction room created', icon: 'success' })
    newName.value = ''
    if (typeof navigateTo === 'function') {
      await navigateTo(`/transactions/${room.id}`)
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not create',
      icon: 'error',
    })
  } finally {
    creating.value = false
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

const isEmpty = computed(() => !loading.value && rooms.value.length === 0)
</script>

<template>
  <AdminPageShell :permission="false" max-width="6xl">
    <UiPageHeader title="Transactions">
      <template #description>
        Closing rooms — one per deal-in-progress. Holds documents,
        signatures, files, and the audit trail in one place.
      </template>
      <template #actions>
        <label class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <input
            v-model="mineOnly"
            type="checkbox"
            class="h-4 w-4 cursor-pointer accent-primary focus-ring"
          />
          Mine only
        </label>
        <UiBadge variant="neutral" size="sm" :dot="true">
          <span class="tabular-nums">{{ total.toLocaleString() }} total</span>
        </UiBadge>
      </template>
    </UiPageHeader>

    <!-- Quick-create -->
    <UiCard padding="md">
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="create">
        <input
          v-model="newName"
          type="text"
          placeholder="Name this transaction (e.g. BGC One Maridien — Santos closing)"
          maxlength="200"
          class="min-w-[260px] flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
        <button
          type="submit"
          class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="!newName.trim() || creating"
        >
          {{ creating ? 'Creating…' : '+ New transaction' }}
        </button>
      </form>
    </UiCard>

    <!-- Status pills -->
    <div role="tablist" aria-label="Transaction status" class="flex flex-wrap gap-1.5">
      <button
        v-for="s in (['', 'open', 'in_review', 'closed', 'archived', 'cancelled'] as const)"
        :key="s"
        type="button"
        role="tab"
        :aria-selected="status === s"
        class="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-ring"
        :class="status === s
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-foreground hover:bg-accent'"
        @click="status = s"
      >
        {{ s === '' ? 'All' : s.replace('_', ' ') }}
      </button>
    </div>

    <!-- List -->
    <div v-if="loading" class="space-y-2">
      <div v-for="n in 4" :key="n" class="h-16 animate-pulse rounded-md bg-muted-foreground/10" />
    </div>

    <UiCard v-else-if="isEmpty" padding="lg" class="text-center">
      <p class="text-sm font-medium text-foreground">No transactions yet</p>
      <p class="mt-1 text-xs text-muted-foreground">
        Use the form above to spin up your first transaction room.
        Anchor it to a deal or listing later from inside the room.
      </p>
    </UiCard>

    <ul v-else class="space-y-2">
      <li
        v-for="r in rooms"
        :key="r.id"
        class="rounded-md border border-border bg-card p-3 transition-colors hover:border-border-strong"
      >
        <NuxtLink
          :to="`/transactions/${r.id}`"
          class="block focus-ring rounded"
        >
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="text-sm font-semibold text-foreground">{{ r.name }}</span>
            <UiBadge :variant="statusVariant(r.status)" size="xs">
              {{ r.status.replace('_', ' ') }}
            </UiBadge>
            <span class="ml-auto text-[11px] tabular-nums text-muted-foreground">
              {{ relativeTime(r.updated_at) }}
            </span>
          </div>
          <p class="mt-1 text-xs text-muted-foreground">
            <span v-if="r.listing">Listing: {{ r.listing.title || `#${r.listing.id}` }}</span>
            <span v-if="r.listing && r.buyer_contact"> · </span>
            <span v-if="r.buyer_contact">Buyer: {{ r.buyer_contact.full_name }}</span>
            <span v-if="!r.listing && !r.buyer_contact" class="italic">No anchors set</span>
          </p>
        </NuxtLink>
      </li>
    </ul>
  </AdminPageShell>
</template>
