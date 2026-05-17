<script setup lang="ts">
/**
 * /admin/late-fees — cross-lease late-fee assessment browse.
 *
 * Surfaces every late_fee_assessments row with the late-fee charge
 * + source charge it links. Filters: lease_id, date range. Drill
 * back to the lease detail page for full context.
 *
 * The per-lease policy editor stays on /admin/leases/[id] — this
 * page is purely an audit / observability surface.
 */

import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Late Fees | Admin' })

type ChargeRef = {
  id: string
  charge_no: string
  kind: string
  status: string
  total_minor: number
  currency: string
  due_at: string | null
  paid_at?: string | null
  lease_id: string | null
  unit_id?: string | null
}

type Assessment = {
  id: string
  source_charge_id: string
  late_fee_charge_id: string | null
  policy_id: string | null
  payment_run_id: string | null
  assessment_date: string
  recurrence_index: number
  amount_minor: number
  metadata: Record<string, unknown>
  created_at: string
  late_fee_charge: ChargeRef | null
  source_charge: ChargeRef | null
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const rows = ref<Assessment[]>([])
const total = ref(0)
const loading = ref(false)

const filters = reactive({
  lease_id: '',
  from: '',
  to: '',
})
const limit = 50
const offset = ref(0)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      rows: Assessment[]
      total: number
      limit: number
      offset: number
    }>('/api/admin/late-fee/assessments', {
      query: {
        lease_id: filters.lease_id.trim() || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        limit,
        offset: offset.value,
      },
    })
    rows.value = res.rows ?? []
    total.value = res.total ?? rows.value.length
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load assessments',
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

function formatPHP(minor: number, currency = 'PHP') {
  return ((minor || 0) / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })
}

const totalAmount = computed(() => rows.value.reduce((s, r) => s + (r.amount_minor || 0), 0))
const paidCount = computed(
  () => rows.value.filter((r) => r.late_fee_charge?.status === 'paid').length,
)

function statusClass(s: string | null | undefined): string {
  switch (s) {
    case 'paid':
      return 'bg-success/15 text-success'
    case 'past_due':
      return 'bg-destructive/15 text-destructive'
    case 'open':
      return 'bg-warning/15 text-warning'
    case 'void':
    case 'forgiven':
      return 'bg-muted text-muted-foreground'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

onMounted(async () => {
  const ok =
    (await hasPermission('late_fees.manage')) ||
    (await hasPermission('rent.manage')) ||
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
        <h1 class="text-page-title">Late Fees</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Cross-lease assessment ledger. Each row was created by the
          daily 04:00 UTC cron (or a manual <em>Apply now</em>) per the
          per-lease policy. Configure policies on
          <NuxtLink to="/admin/leases" class="text-primary hover:underline">/admin/leases</NuxtLink>.
        </p>
      </header>

      <!-- Filters. Lease-id is a power-user filter for deep links from
           a specific lease page; tucked behind a disclosure so the date
           range is the primary surface. -->
      <div class="space-y-2">
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            v-model="filters.from"
            type="date"
            placeholder="From"
            class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
          />
          <input
            v-model="filters.to"
            type="date"
            placeholder="To"
            class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
          />
          <button
          type="button"
          class="btn-primary"
          @click="applyFilters"
        >
          Apply
        </button>
        </div>

        <details class="group rounded-lg border border-dashed border-border px-3 py-2">
          <summary class="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
            Filter by specific lease
            <span class="ml-1 text-[10px] text-muted-foreground/70">— paste an id you copied from a lease page</span>
          </summary>
          <div class="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
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
              Apply ID filter
            </button>
          </div>
        </details>
      </div>

      <!-- Summary strip -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
            Assessments shown
          </div>
          <div class="mt-1 text-lg font-semibold tabular-nums text-foreground">
            {{ rows.length }} / {{ total }}
          </div>
        </div>
        <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
            Total fees (page)
          </div>
          <div class="mt-1 text-lg font-semibold tabular-nums text-foreground">
            {{ formatPHP(totalAmount) }}
          </div>
        </div>
        <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
            Paid (page)
          </div>
          <div class="mt-1 text-lg font-semibold tabular-nums text-success">
            {{ paidCount }} / {{ rows.length }}
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
          No assessments match the current filters. Tighten the date range or clear the lease filter.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Assessed</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Source charge</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Late-fee charge</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Fee</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Recurrence</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Lease</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="r in rows" :key="r.id" class="hover:bg-accent/30">
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ new Date(r.assessment_date).toLocaleDateString() }}
                </td>
                <td class="px-3 py-2 text-xs">
                  <div class="font-mono">{{ r.source_charge?.charge_no ?? '—' }}</div>
                  <div class="text-muted-foreground capitalize">{{ r.source_charge?.kind ?? '—' }}</div>
                </td>
                <td class="px-3 py-2 text-xs">
                  <div class="flex items-center gap-1.5">
                    <span class="font-mono">{{ r.late_fee_charge?.charge_no ?? '—' }}</span>
                    <span
                      v-if="r.late_fee_charge?.status"
                      :class="[
                        'inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase',
                        statusClass(r.late_fee_charge.status),
                      ]"
                    >
                      {{ r.late_fee_charge.status.replace('_', ' ') }}
                    </span>
                  </div>
                  <div v-if="r.late_fee_charge?.due_at" class="text-muted-foreground">
                    due {{ new Date(r.late_fee_charge.due_at).toLocaleDateString() }}
                  </div>
                </td>
                <td class="px-3 py-2 text-right tabular-nums font-medium">
                  {{ formatPHP(r.amount_minor, r.late_fee_charge?.currency ?? 'PHP') }}
                </td>
                <td class="px-3 py-2 text-xs">
                  <span
                    :class="[
                      'inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                      r.recurrence_index === 1 ? 'bg-muted text-muted-foreground' : 'bg-warning/15 text-warning',
                    ]"
                  >
                    #{{ r.recurrence_index }}
                  </span>
                </td>
                <td class="px-3 py-2 text-xs">
                  <NuxtLink
                    v-if="r.source_charge?.lease_id"
                    :to="`/admin/leases/${r.source_charge.lease_id}`"
                    class="font-mono text-primary hover:underline"
                  >
                    {{ r.source_charge.lease_id.slice(0, 8) }}…
                  </NuxtLink>
                  <span v-else class="text-muted-foreground">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
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
