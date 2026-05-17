<script setup lang="ts">
/**
 * /admin/maintenance — maintenance triage queue.
 *
 * Inbox of tenant-reported issues with quick-action triage:
 *   - "Triage" → maintenance_triage RPC (submitted → triaged)
 *   - "Cancel" → maintenance_triage RPC (submitted → cancelled)
 *
 * Defaults to showing emergencies + high-urgency open requests at top.
 * Operator drills into a row to add a work order (deferred to a later UI).
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Maintenance | Admin' })

type Status =
  | 'submitted'
  | 'triaged'
  | 'scheduled'
  | 'in_progress'
  | 'resolved'
  | 'closed'
  | 'cancelled'

type Urgency = 'emergency' | 'high' | 'normal' | 'low'

type Request = {
  id: string
  request_no: string
  unit_id: string
  lease_id: string | null
  reported_by_user_id: string | null
  reporter_external_name: string | null
  reporter_external_email: string | null
  reporter_role: string | null
  title: string
  description: string | null
  category: string
  urgency: Urgency
  status: Status
  reported_at: string
  triaged_at: string | null
  resolved_at: string | null
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const requests = ref<Request[]>([])
const loading = ref(false)
const statusFilter = ref<Status | 'all'>('submitted')

// Per-row triage state (action note + busy)
const acting = ref<Record<string, 'triaged' | 'cancelled' | null>>({})
const triageNote = ref<Record<string, string>>({})
const expandedRow = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    const res = await $fetch<{ items: Request[] }>('/api/maintenance-requests', {
      query: params,
    })
    requests.value = res.items ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load requests',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function triage(id: string, status: 'triaged' | 'cancelled') {
  acting.value[id] = status
  try {
    await $fetch(`/api/maintenance-requests/${id}/triage`, {
      method: 'POST',
      body: { status, notes: triageNote.value[id] || null },
    })
    showToast({ title: status === 'triaged' ? 'Marked triaged' : 'Cancelled' })
    triageNote.value[id] = ''
    expandedRow.value = null
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Action failed',
      icon: 'error',
    })
  } finally {
    acting.value[id] = null
  }
}

const sortedRequests = computed(() => {
  // Emergencies first, then high, then normal, then low — within each group, oldest first.
  const order: Record<Urgency, number> = { emergency: 0, high: 1, normal: 2, low: 3 }
  return [...requests.value].sort((a, b) => {
    const u = order[a.urgency] - order[b.urgency]
    if (u !== 0) return u
    return new Date(a.reported_at).getTime() - new Date(b.reported_at).getTime()
  })
})

const counts = computed(() => {
  const c = { emergency: 0, high: 0, normal: 0, low: 0 }
  for (const r of requests.value) c[r.urgency] += 1
  return c
})

function urgencyClass(u: Urgency) {
  if (u === 'emergency') return 'bg-destructive/15 text-destructive'
  if (u === 'high') return 'bg-warning/15 text-warning'
  if (u === 'normal') return 'bg-primary/15 text-primary'
  return 'bg-muted text-muted-foreground'
}

function statusClass(s: Status) {
  if (s === 'submitted') return 'bg-warning/15 text-warning'
  if (s === 'triaged' || s === 'scheduled') return 'bg-primary/15 text-primary'
  if (s === 'in_progress') return 'bg-primary/15 text-primary'
  if (s === 'resolved' || s === 'closed') return 'bg-success/15 text-success'
  return 'bg-muted text-muted-foreground'
}

function ageHours(iso: string) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000)
}

onMounted(async () => {
  const ok =
    (await hasPermission('maintenance.manage')) || (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await load()
})
</script>

<template>
  <div class="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <header>
        <h1 class="text-page-title">
          Maintenance
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Triage incoming tenant-reported issues. Sort by urgency, then by age.
        </p>
      </header>

      <!-- Urgency strip -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div
          v-for="u in (['emergency', 'high', 'normal', 'low'] as const)"
          :key="u"
          :class="['rounded-lg border p-3', urgencyClass(u)]"
        >
          <p class="text-xs font-semibold uppercase tracking-wide opacity-80">
            {{ u }}
          </p>
          <p class="mt-0.5 text-2xl font-semibold tabular-nums">
            {{ counts[u] }}
          </p>
          <p class="text-[10px] opacity-70">
            in current view
          </p>
        </div>
      </div>

      <!-- Status filter -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="opt in (
            ['submitted', 'triaged', 'scheduled', 'in_progress', 'resolved', 'closed', 'all'] as const
          )"
          :key="opt"
          type="button"
          :class="[
            'rounded-full border px-3 py-1.5 text-xs font-medium transition',
            statusFilter === opt
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
          ]"
          @click="statusFilter = opt; load()"
        >
          <span class="capitalize">{{ opt.replace('_', ' ') }}</span>
        </button>
        <button
          type="button"
          class="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
          @click="load"
        >
          Refresh
        </button>
      </div>

      <!-- Queue -->
      <section class="rounded-lg border border-border bg-card p-0 text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="sortedRequests.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No requests in this view.
        </div>
        <ul v-else class="divide-y divide-border">
          <li
            v-for="r in sortedRequests"
            :key="r.id"
            class="p-4 hover:bg-accent hover:text-accent-foreground/50 "
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="mb-1 flex flex-wrap items-center gap-2">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase', urgencyClass(r.urgency)]">
                    {{ r.urgency }}
                  </span>
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(r.status)]">
                    {{ r.status.replace('_', ' ') }}
                  </span>
                  <span class="font-mono text-xs text-muted-foreground">{{ r.request_no }}</span>
                  <span class="text-xs text-muted-foreground/70">·</span>
                  <span class="text-xs text-muted-foreground capitalize">{{ r.category }}</span>
                  <span class="text-xs text-muted-foreground/70">·</span>
                  <span class="text-xs text-muted-foreground">
                    {{ ageHours(r.reported_at) }}h ago
                  </span>
                </div>
                <p class="font-medium text-foreground">
                  {{ r.title }}
                </p>
                <p
                  v-if="r.description"
                  class="mt-1 line-clamp-2 text-sm text-muted-foreground"
                >
                  {{ r.description }}
                </p>
                <p class="mt-1 text-xs text-muted-foreground">
                  Reporter:
                  {{
                    r.reporter_external_name ||
                    (r.reported_by_user_id ? `User ${r.reported_by_user_id.slice(0, 8)}…` : '—')
                  }}
                  <span v-if="r.reporter_external_email"> · {{ r.reporter_external_email }}</span>
                  <span v-if="r.reporter_role"> · {{ r.reporter_role }}</span>
                </p>
              </div>

              <div class="flex shrink-0 items-start gap-2">
                <button
                  v-if="r.status === 'submitted'"
                  type="button"
                  class="text-xs text-primary underline-offset-2 hover:underline"
                  @click="expandedRow = expandedRow === r.id ? null : r.id"
                >
                  {{ expandedRow === r.id ? 'Cancel' : 'Triage' }}
                </button>
              </div>
            </div>

            <!-- Triage form (expanded) -->
            <div
              v-if="expandedRow === r.id && r.status === 'submitted'"
              class="mt-3 rounded-lg border border-border bg-muted/40 p-3"
            >
              <textarea
                v-model="triageNote[r.id]"
                rows="2"
                maxlength="2000"
                placeholder="Optional triage notes…"
                class="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:ring-1 focus:ring-ring"
              />
              <div class="mt-2 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  :disabled="acting[r.id] !== null && acting[r.id] !== undefined"
                  class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
                  @click="triage(r.id, 'cancelled')"
                >
                  <span v-if="acting[r.id] === 'cancelled'">Cancelling…</span>
                  <span v-else>Cancel request</span>
                </button>
                <button
                  type="button"
                  :disabled="acting[r.id] !== null && acting[r.id] !== undefined"
                  class="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring"
                  @click="triage(r.id, 'triaged')"
                >
                  <span v-if="acting[r.id] === 'triaged'">Triaging…</span>
                  <span v-else>Mark triaged</span>
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
