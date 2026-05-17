<script setup lang="ts">
/**
 * /crm — domain hub.
 *
 * Real dashboard rather than a tile grid: KPI strip (open tasks /
 * pending shares / new inquiries) above three "today" panels —
 * Today's tasks, Today's viewings, Recently-added contacts.
 *
 * Each panel pulls from existing endpoints (no new server work):
 *   - /api/dashboard/stats for KPI counts
 *   - /api/tasks?mine=true for the tasks panel (today filter
 *     applied client-side)
 *   - /api/viewings?mine=true (filtered to today client-side)
 *   - useContacts().fetchContacts (sorted by created_at desc)
 *
 * Sub-route shortcuts moved to the bottom — discoverable but no
 * longer the lede.
 */
import { onMounted, ref } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import { useContacts, type Contact } from '~/composables/useContacts'

definePageMeta({ layout: 'default' })
useHead({ title: 'CRM | Housing Interactive' })

// ----- KPI strip ----------------------------------------------------
const kpi = ref<{ open_tasks: number; pending_shares: number; new_inquiries_7d: number } | null>(null)
const kpiLoading = ref(true)
async function loadKpi() {
  kpiLoading.value = true
  try {
    const res = await $fetch<{ kpi: any }>('/api/dashboard/stats')
    kpi.value = {
      open_tasks: Number(res?.kpi?.open_tasks_mine ?? 0),
      pending_shares: Number(res?.kpi?.pending_shares_incoming ?? 0),
      new_inquiries_7d: Number(res?.kpi?.new_inquiries_7d ?? 0),
    }
  } catch {
    kpi.value = { open_tasks: 0, pending_shares: 0, new_inquiries_7d: 0 }
  } finally {
    kpiLoading.value = false
  }
}

// ----- Today's tasks ------------------------------------------------
type Task = {
  id: string
  title: string | null
  status: string
  due_at: string | null
  priority: string | null
  contact_id: number | null
}
const todaysTasks = ref<Task[]>([])
const tasksLoading = ref(true)
async function loadTasks() {
  tasksLoading.value = true
  try {
    // Reuse the existing tasks list endpoint; filter "today" client-
    // side. For a top-level dashboard glance we want first-page only.
    const res = await $fetch<{ data: Task[] }>('/api/tasks', {
      query: { mine: 'true', page_size: 50 },
    })
    const all = res.data ?? []
    const cutoff = (() => {
      const d = new Date()
      d.setHours(23, 59, 59, 999)
      return d.getTime()
    })()
    todaysTasks.value = all
      .filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
      .filter((t) => !t.due_at || new Date(t.due_at).getTime() <= cutoff)
      .slice(0, 6)
  } catch {
    todaysTasks.value = []
  } finally {
    tasksLoading.value = false
  }
}

// ----- Today's viewings ---------------------------------------------
type Viewing = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: string
  deal: {
    id: string
    listing: { id: number; title: string | null } | null
    buyer_contact: { id: number; full_name: string | null } | null
  } | null
}
const todaysViewings = ref<Viewing[]>([])
const viewingsLoading = ref(true)
async function loadViewings() {
  viewingsLoading.value = true
  try {
    const res = await $fetch<{ data: Viewing[] }>('/api/viewings', {
      query: { mine: true, status: 'scheduled', limit: 50 },
    })
    const all = res.data ?? []
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const tomorrow = today.getTime() + 24 * 60 * 60 * 1000
    todaysViewings.value = all
      .filter((v) => {
        const t = new Date(v.scheduled_at).getTime()
        return t >= today.getTime() && t < tomorrow
      })
      .slice(0, 5)
  } catch {
    todaysViewings.value = []
  } finally {
    viewingsLoading.value = false
  }
}

// ----- Recent contacts ----------------------------------------------
// Three-state model: 'idle' before fetch fires, 'loading' while in
// flight, 'ready' once done (regardless of empty/non-empty). The
// previous boolean isLoading + length===0 check could leave the panel
// stuck on "Loading…" if the fetch never resolved (network race) or
// if the composable threw synchronously before the try/catch entered.
const { fetchContacts } = useContacts()
const recentContacts = ref<Contact[]>([])
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
const contactsState = ref<LoadState>('idle')

async function loadContacts() {
  contactsState.value = 'loading'
  try {
    const all = await fetchContacts({ sort: 'created_at', order: 'desc' })
    recentContacts.value = Array.isArray(all) ? all.slice(0, 6) : []
    contactsState.value = 'ready'
  } catch (err) {
    console.warn('[crm] fetchContacts failed:', err)
    recentContacts.value = []
    contactsState.value = 'error'
  }
}

onMounted(() => {
  loadKpi()
  loadTasks()
  loadViewings()
  loadContacts()
})

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
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
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="6xl">
    <UiPageHeader title="CRM">
      <template #description>
        Today's actions across people, tasks, and viewings.
      </template>
    </UiPageHeader>

    <!-- KPI strip -->
    <div class="grid gap-3 sm:grid-cols-3">
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Open tasks (mine)
        </p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          {{ kpiLoading ? '—' : (kpi?.open_tasks ?? 0) }}
        </p>
      </UiCard>
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Pending shares
        </p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          {{ kpiLoading ? '—' : (kpi?.pending_shares ?? 0) }}
        </p>
      </UiCard>
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          New inquiries (7d)
        </p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          {{ kpiLoading ? '—' : (kpi?.new_inquiries_7d ?? 0) }}
        </p>
      </UiCard>
    </div>

    <!-- Today panels -->
    <div class="grid gap-4 lg:grid-cols-2">
      <UiCard padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Today's tasks</h2>
          <NuxtLink to="/tasks" class="text-xs font-medium text-primary hover:underline focus-ring rounded">
            View all →
          </NuxtLink>
        </header>
        <p v-if="tasksLoading" class="text-xs text-muted-foreground">Loading…</p>
        <p
          v-else-if="todaysTasks.length === 0"
          class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
        >
          Nothing due today. Treat this as the calm before the next deal.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="t in todaysTasks"
            :key="t.id"
            class="flex items-baseline gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
          >
            <UiBadge
              :variant="t.priority === 'high' ? 'destructive' : t.priority === 'low' ? 'neutral' : 'warning'"
              size="xs"
            >
              {{ t.status }}
            </UiBadge>
            <span class="min-w-0 flex-1 truncate font-medium text-foreground">
              {{ t.title || 'Untitled task' }}
            </span>
            <span v-if="t.due_at" class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {{ formatTime(t.due_at) }}
            </span>
          </li>
        </ul>
      </UiCard>

      <UiCard padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Today's viewings</h2>
          <NuxtLink to="/viewings" class="text-xs font-medium text-primary hover:underline focus-ring rounded">
            View all →
          </NuxtLink>
        </header>
        <p v-if="viewingsLoading" class="text-xs text-muted-foreground">Loading…</p>
        <p
          v-else-if="todaysViewings.length === 0"
          class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
        >
          No viewings on the calendar today.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="v in todaysViewings"
            :key="v.id"
            class="rounded-md border border-border bg-card px-3 py-2 text-xs"
          >
            <NuxtLink
              v-if="v.deal"
              :to="`/deals/${v.deal.id}`"
              class="block focus-ring rounded"
            >
              <p class="font-semibold tabular-nums text-foreground">
                {{ formatTime(v.scheduled_at) }} · {{ v.duration_minutes }}min
              </p>
              <p class="mt-0.5 truncate text-muted-foreground">
                {{ v.deal.listing?.title || (v.deal.listing ? `Listing #${v.deal.listing.id}` : 'Unknown listing') }}
                <span v-if="v.deal.buyer_contact"> · {{ v.deal.buyer_contact.full_name }}</span>
              </p>
            </NuxtLink>
          </li>
        </ul>
      </UiCard>
    </div>

    <!-- Recent contacts -->
    <UiCard padding="md">
      <header class="mb-3 flex items-baseline justify-between gap-2">
        <h2 class="text-card-title">Recently added contacts</h2>
        <NuxtLink to="/contacts" class="text-xs font-medium text-primary hover:underline focus-ring rounded">
          All contacts →
        </NuxtLink>
      </header>
      <p
        v-if="contactsState === 'loading'"
        class="text-xs text-muted-foreground"
      >
        Loading…
      </p>
      <p
        v-else-if="contactsState === 'error'"
        class="rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-3 py-3 text-xs text-destructive"
      >
        Couldn't load contacts. Refresh to retry.
      </p>
      <p
        v-else-if="recentContacts.length === 0"
        class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
      >
        No contacts yet — convert an inquiry into a deal to seed your CRM.
      </p>
      <ul v-else class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <li
          v-for="c in recentContacts"
          :key="c.id"
          class="rounded-md border border-border bg-card p-3 text-xs"
        >
          <NuxtLink :to="`/contacts/${c.id}`" class="block focus-ring rounded">
            <p class="font-semibold text-foreground truncate">
              {{ c.full_name || `Contact #${c.id}` }}
            </p>
            <p v-if="c.email" class="mt-0.5 truncate text-muted-foreground">
              {{ c.email }}
            </p>
            <p v-if="c.created_at" class="mt-1 text-[10px] tabular-nums text-muted-foreground">
              added {{ relativeTime(c.created_at) }}
            </p>
          </NuxtLink>
        </li>
      </ul>
    </UiCard>

    <!-- Jump-to chips -->
    <section class="border-t border-border pt-4">
      <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Jump to
      </p>
      <div class="flex flex-wrap gap-2">
        <NuxtLink to="/contacts" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">
          Contacts
        </NuxtLink>
        <NuxtLink to="/tasks" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">
          Tasks
        </NuxtLink>
        <NuxtLink to="/viewings" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">
          Viewings
        </NuxtLink>
        <NuxtLink to="/shares" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">
          Shares
        </NuxtLink>
      </div>
    </section>
  </AdminPageShell>
</template>
