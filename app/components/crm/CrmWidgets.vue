<script setup lang="ts">
// Three small dashboard widgets: overdue tasks, pending share invites,
// notifications badge. Each fetches its own count via the matching
// composable (RLS scopes the visible rows). Click-through navigates to
// the corresponding page.
//
// Cheap on-mount load only — no polling. The notification bell handles
// its own polling separately, so duplicating it here would be wasted
// work.

import { onMounted, ref } from 'vue'
import { useTasks, type CrmTask } from '~/composables/useTasks'
import { useListingShares, type ListingShare } from '~/composables/useListingShares'
import { useNotes, type CrmNote } from '~/composables/useNotes'

const { listTasks } = useTasks()
const { listShares } = useListingShares()
const { listNotes } = useNotes()

const overdueCount = ref<number | null>(null)
const overduePreview = ref<CrmTask[]>([])
const pendingSharesCount = ref<number | null>(null)
const pendingSharesPreview = ref<ListingShare[]>([])
const recentNotesCount = ref<number | null>(null)
const recentNotesPreview = ref<CrmNote[]>([])

async function loadAll() {
  // Run in parallel — none of these depend on each other and the
  // dashboard is the first paint after login, so latency matters.
  await Promise.all([loadOverdue(), loadPendingShares(), loadRecentNotes()])
}

async function loadOverdue() {
  try {
    // Server-side filter: dueBefore = now, then client-side strip
    // completed (overdue + completed isn't actionable).
    const res = await listTasks({
      dueBefore: new Date().toISOString(),
      status: 'open',
      pageSize: 5,
    })
    const open = res.data.filter((t) => t.status !== 'completed' && t.due_at && new Date(t.due_at) < new Date())
    overdueCount.value = open.length === 5 ? res.total : open.length
    overduePreview.value = open
  } catch { overdueCount.value = 0 }
}

async function loadPendingShares() {
  try {
    const res = await listShares({ direction: 'incoming', status: 'pending', pageSize: 5 })
    pendingSharesCount.value = res.total
    pendingSharesPreview.value = res.data
  } catch { pendingSharesCount.value = 0 }
}

async function loadRecentNotes() {
  try {
    // Recent = the 5 most recent notes the caller can see; the count
    // here is the total visible (cheap, server-side count via RLS).
    const res = await listNotes({ pageSize: 5 })
    recentNotesCount.value = res.total
    recentNotesPreview.value = res.data
  } catch { recentNotesCount.value = 0 }
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30)  return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

onMounted(loadAll)
</script>

<template>
  <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    <!-- Overdue tasks -->
    <NuxtLink
      :to="{ path: '/tasks', query: { due: 'overdue' } }"
      class="group rounded-lg border border-border bg-card p-5 transition-colors hover:bg-accent/40"
    >
      <header class="flex items-center justify-between gap-2">
        <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Overdue tasks
        </h3>
        <span
          class="text-2xl font-semibold tabular-nums"
          :class="(overdueCount ?? 0) > 0 ? 'text-destructive' : 'text-foreground/40'"
        >
          {{ overdueCount ?? '—' }}
        </span>
      </header>
      <ul v-if="overduePreview.length > 0" class="mt-3 space-y-1.5">
        <li v-for="t in overduePreview.slice(0, 3)" :key="t.id" class="truncate text-xs text-muted-foreground">
          • {{ t.title }}
        </li>
      </ul>
      <p v-else-if="overdueCount === 0" class="mt-3 text-xs text-muted-foreground/80">
        Nothing overdue.
      </p>
    </NuxtLink>

    <!-- Pending share invites -->
    <NuxtLink
      :to="{ name: 'shares' }"
      class="group rounded-lg border border-border bg-card p-5 transition-colors hover:bg-accent/40"
    >
      <header class="flex items-center justify-between gap-2">
        <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Pending invites
        </h3>
        <span
          class="text-2xl font-semibold tabular-nums"
          :class="(pendingSharesCount ?? 0) > 0 ? 'text-warning' : 'text-foreground/40'"
        >
          {{ pendingSharesCount ?? '—' }}
        </span>
      </header>
      <ul v-if="pendingSharesPreview.length > 0" class="mt-3 space-y-1.5">
        <li v-for="s in pendingSharesPreview.slice(0, 3)" :key="s.id" class="truncate text-xs text-muted-foreground">
          • Listing #{{ s.listing_id }} as {{ s.share_role }}
        </li>
      </ul>
      <p v-else-if="pendingSharesCount === 0" class="mt-3 text-xs text-muted-foreground/80">
        No invites waiting.
      </p>
    </NuxtLink>

    <!-- Recent notes -->
    <NuxtLink
      :to="{ name: 'contacts' }"
      class="group rounded-lg border border-border bg-card p-5 transition-colors hover:bg-accent/40"
    >
      <header class="flex items-center justify-between gap-2">
        <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent notes
        </h3>
        <span class="text-metric-value">
          {{ recentNotesCount ?? '—' }}
        </span>
      </header>
      <ul v-if="recentNotesPreview.length > 0" class="mt-3 space-y-1.5">
        <li v-for="n in recentNotesPreview.slice(0, 3)" :key="n.id" class="truncate text-xs text-muted-foreground">
          <span class="text-muted-foreground/70">{{ relativeTime(n.created_at) }}</span>
          · {{ n.body }}
        </li>
      </ul>
      <p v-else-if="recentNotesCount === 0" class="mt-3 text-xs text-muted-foreground/80">
        No notes yet.
      </p>
    </NuxtLink>
  </section>
</template>
