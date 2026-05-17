<script setup lang="ts">
/**
 * Admin triage queue for inquiries with no assigned agent.
 *
 * Two ways an inquiry lands here:
 *   1. The public submission's `assigned_user_id` resolved from
 *      `listing.created_by` came back NULL (legacy listing without
 *      a creator profile, or the orphan-FK fallback shipped on
 *      2026-05-07 in /api/public/inquiries/index.post.ts).
 *   2. An admin manually unassigned via the per-row PATCH while
 *      shopping for a different agent.
 *
 * Workflow: select rows → pick an agent from the dropdown → Assign.
 * The system-status card surfaces the recent count; clearing the
 * backlog drops the warning.
 */
import { computed, onMounted, ref } from 'vue'
import { useAdmin } from '~/composables/useAdmin'
import { showToast } from '~/helpers/helpers'

type Inquiry = {
  id: string
  listing_id: number
  assigned_user_id: string | null
  sender_name: string
  sender_email: string | null
  sender_phone: string | null
  message: string
  status: string
  source: string | null
  created_at: string
}

type AgentOption = {
  id: string
  full_name: string | null
  email: string | null
  role: string
}

const PAGE_SIZE = 25

const { listProfiles } = useAdmin()

const inquiries = ref<Inquiry[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(true)
const submitting = ref(false)
const selected = ref<Set<string>>(new Set())
const agents = ref<AgentOption[]>([])
const agentsLoading = ref(true)
const targetAgentId = ref<string>('')

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Inquiry[]; total: number }>(
      '/api/inquiries',
      {
        query: {
          assigned: 'unassigned',
          page: page.value,
          page_size: PAGE_SIZE,
        },
      },
    )
    inquiries.value = res.data ?? []
    total.value = res.total ?? 0
    // Drop selections that didn't survive the new page.
    const visible = new Set(inquiries.value.map((i) => i.id))
    for (const id of [...selected.value]) {
      if (!visible.has(id)) selected.value.delete(id)
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load inquiries',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function loadAgents() {
  agentsLoading.value = true
  try {
    // Pull both agents and managers — managers can also be assigned
    // (they handle escalations or VIP leads).
    const [agentRows, mgrRows] = await Promise.all([
      listProfiles({ role: 'agent', limit: 500 }),
      listProfiles({ role: 'manager', limit: 100 }),
    ])
    const merged: AgentOption[] = [
      ...mgrRows.map((u) => ({
        id: u.id,
        full_name: u.full_name,
        email: u.email,
        role: 'manager',
      })),
      ...agentRows.map((u) => ({
        id: u.id,
        full_name: u.full_name,
        email: u.email,
        role: 'agent',
      })),
    ]
    // Stable alpha sort within role groups (managers first by the
    // merge order above).
    agents.value = merged.sort((a, b) => {
      if (a.role !== b.role) return a.role < b.role ? -1 : 1
      return (a.full_name || a.email || '').localeCompare(
        b.full_name || b.email || '',
      )
    })
  } catch (err: any) {
    showToast({
      title: err?.message || 'Failed to load agents',
      icon: 'error',
    })
  } finally {
    agentsLoading.value = false
  }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const allOnPageSelected = computed(
  () =>
    inquiries.value.length > 0 &&
    inquiries.value.every((i) => selected.value.has(i.id)),
)

function toggleRow(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function toggleAllOnPage() {
  const next = new Set(selected.value)
  if (allOnPageSelected.value) {
    for (const i of inquiries.value) next.delete(i.id)
  } else {
    for (const i of inquiries.value) next.add(i.id)
  }
  selected.value = next
}

async function bulkAssign() {
  if (!targetAgentId.value) {
    showToast({ title: 'Pick an agent first', icon: 'warning' })
    return
  }
  if (selected.value.size === 0) return
  submitting.value = true
  const ids = [...selected.value]
  try {
    const res = await $fetch<{
      requested: number
      updated: number
      missing: number
    }>('/api/admin/inquiries/bulk-assign', {
      method: 'POST',
      body: {
        inquiry_ids: ids,
        assigned_user_id: targetAgentId.value,
      },
    })
    showToast({
      title:
        res.missing > 0
          ? `Assigned ${res.updated} of ${res.requested} (${res.missing} no longer unassigned)`
          : `Assigned ${res.updated} inquir${res.updated === 1 ? 'y' : 'ies'}`,
      icon: 'success',
    })
    selected.value = new Set()
    targetAgentId.value = ''
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Bulk assign failed',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

function nextPage() {
  if (page.value < totalPages.value) {
    page.value++
    load()
  }
}
function prevPage() {
  if (page.value > 1) {
    page.value--
    load()
  }
}

function formatTs(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function truncate(s: string | null, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

const isEmpty = computed(() => !loading.value && inquiries.value.length === 0)
const targetAgentLabel = computed(() => {
  const a = agents.value.find((x) => x.id === targetAgentId.value)
  if (!a) return ''
  return a.full_name || a.email || a.id
})

onMounted(async () => {
  await Promise.all([load(), loadAgents()])
})
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 class="text-base font-semibold text-foreground">Unassigned inquiries</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Inquiries with
          <code class="rounded bg-muted-foreground/10 px-1">assigned_user_id IS NULL</code>.
          Pick rows + an agent, then bulk-assign.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span class="rounded-full bg-muted-foreground/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground/80">
          {{ total.toLocaleString() }} unassigned
        </span>
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="loading"
          @click="load"
        >
          Refresh
        </button>
      </div>
    </header>

    <!-- Bulk action bar — only when there's something to select. Sticks
         to the top of the scroll area while the user works through the
         queue, so the assign affordance never falls offscreen. -->
    <div
      v-if="!isEmpty && !loading"
      class="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
    >
      <p class="text-sm font-semibold text-foreground tabular-nums">
        {{ selected.size }} selected
      </p>
      <select
        v-model="targetAgentId"
        :disabled="agentsLoading || submitting"
        class="rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      >
        <option value="">
          {{ agentsLoading ? 'Loading agents…' : 'Pick an agent…' }}
        </option>
        <option v-for="a in agents" :key="a.id" :value="a.id">
          {{ a.full_name || a.email || a.id }} ({{ a.role }})
        </option>
      </select>
      <button
        type="button"
        class="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!targetAgentId || selected.size === 0 || submitting"
        @click="bulkAssign"
      >
        {{ submitting ? 'Assigning…' : `Assign to ${targetAgentLabel || 'agent'}` }}
      </button>
      <button
        v-if="selected.size > 0"
        type="button"
        class="ml-auto rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        @click="selected = new Set()"
      >
        Clear selection
      </button>
    </div>

    <!-- Loading: skeleton table matching the column layout -->
    <div
      v-if="loading"
      class="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div class="border-b border-border bg-muted-foreground/5 px-3 py-2.5">
        <Skeleton class="h-3 w-24" />
      </div>
      <div
        v-for="n in 5"
        :key="n"
        class="grid grid-cols-[2.5rem_2fr_1fr_1fr_1fr] items-start gap-3 border-b border-border px-3 py-3 last:border-0"
      >
        <Skeleton class="h-4 w-4" />
        <div class="space-y-1.5">
          <Skeleton class="h-3 w-1/3" />
          <Skeleton class="h-2.5 w-1/2" />
          <Skeleton class="h-2.5 w-3/4" />
        </div>
        <Skeleton class="h-3 w-16" />
        <Skeleton class="h-3 w-24" />
        <Skeleton class="h-5 w-12 rounded-full" />
      </div>
    </div>

    <section
      v-else-if="isEmpty"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        variant="success"
        size="cozy"
        title="Triage queue is clear"
        description="No unassigned inquiries. New leads with no resolved owner will surface here."
      />
    </section>

    <!-- Table -->
    <div
      v-else
      class="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="sticky top-0 z-10 bg-card">
            <tr class="border-b border-border bg-muted-foreground/5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th class="w-10 px-3 py-2.5 text-left" scope="col">
                <input
                  type="checkbox"
                  class="cursor-pointer accent-blue-600"
                  :checked="allOnPageSelected"
                  :aria-label="allOnPageSelected ? 'Deselect all on page' : 'Select all on page'"
                  @change="toggleAllOnPage"
                />
              </th>
              <th class="px-3 py-2.5 text-left" scope="col">Inquiry</th>
              <th class="px-3 py-2.5 text-left" scope="col">Listing</th>
              <th class="px-3 py-2.5 text-left" scope="col">Received</th>
              <th class="px-3 py-2.5 text-left" scope="col">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="i in inquiries"
              :key="i.id"
              class="transition-colors hover:bg-accent/40"
              :class="selected.has(i.id) ? 'bg-accent/60' : ''"
            >
              <td class="px-3 py-3 align-top">
                <input
                  type="checkbox"
                  class="cursor-pointer accent-blue-600"
                  :checked="selected.has(i.id)"
                  :aria-label="`Select inquiry from ${i.sender_name}`"
                  @change="toggleRow(i.id)"
                />
              </td>
              <td class="px-3 py-3 align-top">
                <p class="font-semibold text-foreground">{{ i.sender_name }}</p>
                <p class="mt-0.5 text-xs text-muted-foreground">
                  <span v-if="i.sender_email">{{ i.sender_email }}</span>
                  <span v-if="i.sender_email && i.sender_phone"> · </span>
                  <span v-if="i.sender_phone">{{ i.sender_phone }}</span>
                </p>
                <p class="mt-1 text-xs text-foreground/80">
                  {{ truncate(i.message, 140) }}
                </p>
              </td>
              <td class="px-3 py-3 align-top text-xs">
                <NuxtLink
                  :to="`/listings/${i.listing_id}`"
                  class="font-mono text-primary hover:underline"
                >
                  #{{ i.listing_id }}
                </NuxtLink>
                <p v-if="i.source" class="mt-0.5 text-muted-foreground">
                  via {{ i.source }}
                </p>
              </td>
              <td class="px-3 py-3 align-top text-xs text-muted-foreground">
                {{ formatTs(i.created_at) }}
              </td>
              <td class="px-3 py-3 align-top text-xs">
                <span class="inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning ring-1 ring-warning/30">
                  {{ i.status }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Pagination -->
    <div
      v-if="!loading && total > 0"
      class="flex items-center justify-between text-xs"
    >
      <button
        type="button"
        class="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="page === 1"
        @click="prevPage"
      >
        ← Previous
      </button>
      <span class="tabular-nums text-muted-foreground">
        Page {{ page }} of {{ totalPages }}
      </span>
      <button
        type="button"
        class="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="page >= totalPages"
        @click="nextPage"
      >
        Next →
      </button>
    </div>
  </section>
</template>
