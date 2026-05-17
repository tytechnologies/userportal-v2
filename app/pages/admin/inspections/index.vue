<script setup lang="ts">
/**
 * /admin/inspections — cross-lease inspection browse.
 *
 * Surfaces every inspection across the portfolio with filters
 * (status, kind, unit, lease). Click-through to the inspection detail
 * page for findings + actions.
 */

import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Inspections | Admin' })

type Status =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'tenant_signed'
  | 'cancelled'
type Kind = 'move_in' | 'move_out' | 'mid_tenancy' | 'maintenance' | 'annual'

type Row = {
  id: string
  inspection_no: string
  unit_id: string
  lease_id: string | null
  inspection_kind: Kind
  status: Status
  inspector_user_id: string | null
  inspector_external_name: string | null
  scheduled_at: string | null
  conducted_at: string | null
  overall_condition: string | null
  total_damage_estimate_minor: number
  tenant_signed_at: string | null
  summary_notes: string | null
  created_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const rows = ref<Row[]>([])
const total = ref(0)
const loading = ref(false)

const filters = reactive({
  status: '' as Status | '',
  kind: '' as Kind | '',
  unit_id: '',
  lease_id: '',
})
const limit = 50
const offset = ref(0)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      rows: Row[]
      total: number
      limit: number
      offset: number
    }>('/api/admin/inspections', {
      query: {
        status: filters.status || undefined,
        kind: filters.kind || undefined,
        unit_id: filters.unit_id.trim() || undefined,
        lease_id: filters.lease_id.trim() || undefined,
        limit,
        offset: offset.value,
      },
    })
    rows.value = res.rows ?? []
    total.value = res.total ?? rows.value.length
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load inspections',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

function applyFilters() {
  offset.value = 0
  void load()
}
function nextPage() {
  if (offset.value + limit >= total.value) return
  offset.value += limit
  void load()
}
function prevPage() {
  offset.value = Math.max(0, offset.value - limit)
  void load()
}

function statusClass(s: Status): string {
  switch (s) {
    case 'scheduled':
      return 'bg-muted text-muted-foreground'
    case 'in_progress':
      return 'bg-primary/15 text-primary'
    case 'completed':
      return 'bg-warning/15 text-warning'
    case 'tenant_signed':
      return 'bg-success/15 text-success'
    case 'cancelled':
      return 'bg-destructive/15 text-destructive'
  }
}

function formatPHP(minor: number) {
  return ((minor || 0) / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
  })
}

const counts = computed(() => {
  const c: Record<string, number> = {
    scheduled: 0,
    in_progress: 0,
    completed: 0,
    tenant_signed: 0,
    cancelled: 0,
  }
  for (const r of rows.value) c[r.status] = (c[r.status] ?? 0) + 1
  return c
})

const totalDamage = computed(() => rows.value.reduce((s, r) => s + (r.total_damage_estimate_minor || 0), 0))

onMounted(async () => {
  const ok =
    (await hasPermission('inspections.manage')) ||
    (await hasPermission('property.manage')) ||
    (await hasPermission('admin.access'))
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
        <h1 class="text-page-title">Inspections</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Cross-lease browse. Schedule new inspections from the relevant lease detail
          (<NuxtLink to="/admin/leases" class="text-primary hover:underline">/admin/leases</NuxtLink>).
        </p>
      </header>

      <!-- Filters -->
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-[180px_180px_1fr_1fr_auto]">
        <select
          v-model="filters.status"
          class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
        >
          <option value="">All statuses</option>
          <option value="scheduled">scheduled</option>
          <option value="in_progress">in progress</option>
          <option value="completed">completed</option>
          <option value="tenant_signed">tenant signed</option>
          <option value="cancelled">cancelled</option>
        </select>
        <select
          v-model="filters.kind"
          class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
        >
          <option value="">All kinds</option>
          <option value="move_in">move-in</option>
          <option value="move_out">move-out</option>
          <option value="mid_tenancy">mid-tenancy</option>
          <option value="maintenance">maintenance</option>
          <option value="annual">annual</option>
        </select>
        <button
          type="button"
          class="btn-primary"
          @click="applyFilters"
        >
          Apply
        </button>
      </div>

      <!-- Power-user filters by id. Most operators reach the inspections
           list via a "View inspections" link from a unit or lease page,
           which deep-links with these params already set. Keeping them
           accessible (but tucked away) so manual-paste workflows still
           work without hitting non-operators with raw uuid inputs. -->
      <details class="group rounded-lg border border-dashed border-border px-3 py-2">
        <summary class="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
          Filter by specific unit or lease
          <span class="ml-1 text-[10px] text-muted-foreground/70">— paste an id you copied from a unit or lease page</span>
        </summary>
        <div class="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            v-model="filters.unit_id"
            type="text"
            placeholder="Unit id"
            class="rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
          />
          <input
            v-model="filters.lease_id"
            type="text"
            placeholder="Lease id"
            class="rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
          />
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-accent/40"
            @click="applyFilters"
          >
            Apply ID filters
          </button>
        </div>
      </details>

      <!-- Summary strip -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Shown</div>
          <div class="mt-1 text-lg font-semibold tabular-nums">{{ rows.length }} / {{ total }}</div>
        </div>
        <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Awaiting signature</div>
          <div class="mt-1 text-lg font-semibold tabular-nums text-warning">
            {{ counts.completed }}
          </div>
        </div>
        <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">In progress</div>
          <div class="mt-1 text-lg font-semibold tabular-nums text-primary">
            {{ counts.in_progress }}
          </div>
        </div>
        <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Damage est. (page)</div>
          <div class="mt-1 text-lg font-semibold tabular-nums text-destructive">
            {{ formatPHP(totalDamage) }}
          </div>
        </div>
      </div>

      <!-- Table -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="rows.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No inspections match the current filters.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">No.</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Kind</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Scheduled</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Condition</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Damage est.</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Lease</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr
                v-for="r in rows"
                :key="r.id"
                class="cursor-pointer hover:bg-accent/30"
                @click="router.push(`/admin/inspections/${r.id}`)"
              >
                <td class="px-3 py-2 font-mono text-xs">{{ r.inspection_no }}</td>
                <td class="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
                  {{ r.inspection_kind.replace('_', '-') }}
                </td>
                <td class="px-3 py-2 text-xs">
                  <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', statusClass(r.status)]">
                    {{ r.status.replace('_', ' ') }}
                  </span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ r.scheduled_at ? new Date(r.scheduled_at).toLocaleString() : '—' }}
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ r.overall_condition ?? '—' }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums text-xs">
                  <span v-if="r.total_damage_estimate_minor > 0" class="text-destructive">
                    {{ formatPHP(r.total_damage_estimate_minor) }}
                  </span>
                  <span v-else class="text-muted-foreground">—</span>
                </td>
                <td class="px-3 py-2 text-xs">
                  <NuxtLink
                    v-if="r.lease_id"
                    :to="`/admin/leases/${r.lease_id}`"
                    class="font-mono text-primary hover:underline"
                    @click.stop
                  >
                    {{ r.lease_id.slice(0, 8) }}…
                  </NuxtLink>
                  <span v-else class="text-muted-foreground">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          v-if="total > limit"
          class="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground"
        >
          <span>
            Showing {{ offset + 1 }}–{{ Math.min(offset + limit, total) }} of {{ total }}
          </span>
          <div class="flex gap-2">
            <button
              type="button"
              :disabled="offset === 0"
              class="rounded-md border border-border px-2 py-1 hover:bg-accent disabled:opacity-50"
              @click="prevPage"
            >
              Prev
            </button>
            <button
              type="button"
              :disabled="offset + limit >= total"
              class="rounded-md border border-border px-2 py-1 hover:bg-accent disabled:opacity-50"
              @click="nextPage"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
