<script setup lang="ts">
/**
 * /admin/property-charges — billing visibility across all charges.
 *
 * Filterable list of every property charge (rent / dues / pass-through
 * maintenance / late fees / etc.). Per-row "Record payment" action for
 * open or past_due charges — calls record_property_charge_payment RPC.
 *
 * Charges with status='void' or 'forgiven' are filtered out by default.
 */

import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Property Charges | Admin' })

type ChargeStatus = 'draft' | 'open' | 'paid' | 'past_due' | 'void' | 'forgiven'

type ChargeKind =
  | 'rent'
  | 'dues'
  | 'maintenance_pass_through'
  | 'damage'
  | 'late_fee'
  | 'security_deposit'
  | 'adjustment'

type Charge = {
  id: string
  charge_no: string
  kind: ChargeKind
  unit_id: string
  lease_id: string | null
  charged_to_user_id: string | null
  charged_to_external_name: string | null
  charged_to_external_email: string | null
  billing_target: 'owner' | 'tenant'
  period_start: string | null
  period_end: string | null
  currency: string
  total_minor: number
  amount_paid_minor: number
  status: ChargeStatus
  due_at: string | null
  paid_at: string | null
  created_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const charges = ref<Charge[]>([])
const loading = ref(false)
const statusFilter = ref<ChargeStatus | 'open_and_past_due'>('open_and_past_due')
const kindFilter = ref<ChargeKind | ''>('')

// Record payment modal
const payModal = ref<Charge | null>(null)
const payForm = reactive({
  amount_minor: 0,
})
const recording = ref(false)

async function load() {
  loading.value = true
  try {
    // 'open_and_past_due' isn't a server status — fetch each individually
    // and merge to keep the API contract simple.
    if (statusFilter.value === 'open_and_past_due') {
      const params: Record<string, string> = {}
      if (kindFilter.value) params.kind = kindFilter.value
      const [openRes, pastDueRes] = await Promise.all([
        $fetch<{ items: Charge[] }>('/api/property-charges', {
          query: { ...params, status: 'open' },
        }),
        $fetch<{ items: Charge[] }>('/api/property-charges', {
          query: { ...params, status: 'past_due' },
        }),
      ])
      charges.value = [...(openRes.items ?? []), ...(pastDueRes.items ?? [])]
    } else {
      const params: Record<string, string> = { status: statusFilter.value }
      if (kindFilter.value) params.kind = kindFilter.value
      const res = await $fetch<{ items: Charge[] }>('/api/property-charges', {
        query: params,
      })
      charges.value = res.items ?? []
    }
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load charges', icon: 'error' })
  } finally {
    loading.value = false
  }
}

function openPay(c: Charge) {
  payModal.value = c
  payForm.amount_minor = c.total_minor - c.amount_paid_minor
}

async function recordPayment() {
  if (!payModal.value) return
  if (payForm.amount_minor <= 0) {
    showToast({ title: 'Amount must be greater than zero', icon: 'warning' })
    return
  }
  recording.value = true
  try {
    await $fetch(`/api/property-charges/${payModal.value.id}/record-payment`, {
      method: 'POST',
      body: { amount_minor: payForm.amount_minor },
    })
    showToast({ title: 'Payment recorded' })
    payModal.value = null
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not record', icon: 'error' })
  } finally {
    recording.value = false
  }
}

const sortedCharges = computed(() => {
  // Past_due first, then open by due_at ascending.
  return [...charges.value].sort((a, b) => {
    const sortPriority = (s: ChargeStatus) => (s === 'past_due' ? 0 : s === 'open' ? 1 : 2)
    const p = sortPriority(a.status) - sortPriority(b.status)
    if (p !== 0) return p
    const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity
    const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity
    return ad - bd
  })
})

const totals = computed(() => {
  let openTotal = 0
  let pastDueTotal = 0
  let paidTotal = 0
  for (const c of charges.value) {
    if (c.status === 'open') openTotal += c.total_minor - c.amount_paid_minor
    else if (c.status === 'past_due') pastDueTotal += c.total_minor - c.amount_paid_minor
    else if (c.status === 'paid') paidTotal += c.amount_paid_minor
  }
  return { openTotal, pastDueTotal, paidTotal }
})

function statusClass(s: ChargeStatus) {
  if (s === 'paid') return 'bg-success/15 text-success'
  if (s === 'past_due') return 'bg-destructive/15 text-destructive'
  if (s === 'open') return 'bg-warning/15 text-warning'
  if (s === 'void' || s === 'forgiven') return 'bg-muted text-muted-foreground'
  return 'bg-primary/15 text-primary'
}

function formatPHP(minor: number, currency = 'PHP') {
  return (minor / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })
}

function dueLabel(c: Charge): string {
  if (!c.due_at) return '—'
  const d = new Date(c.due_at)
  const days = Math.round((d.getTime() - Date.now()) / 86400000)
  if (c.status === 'past_due') return `${Math.abs(days)}d overdue`
  if (days <= 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days}d`
}

onMounted(async () => {
  const ok =
    (await hasPermission('rent.manage')) ||
    (await hasPermission('dues.manage')) ||
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
        <h1 class="text-page-title">
          Property Charges
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Rent, dues, maintenance pass-through, and ad-hoc charges. Past-due rows always
          float to the top.
        </p>
      </header>

      <!-- Totals -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p class="text-xs font-medium text-destructive">Past due</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-destructive">
            {{ formatPHP(totals.pastDueTotal) }}
          </p>
        </div>
        <div class="rounded-lg border border-warning/30 bg-warning/10 p-4">
          <p class="text-xs font-medium text-warning">Open</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-warning">
            {{ formatPHP(totals.openTotal) }}
          </p>
        </div>
        <div class="rounded-lg border border-success/30 bg-success/10 p-4 ">
          <p class="text-xs font-medium text-success ">Paid</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-success">
            {{ formatPHP(totals.paidTotal) }}
          </p>
        </div>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="statusFilter"
          class="rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
          @change="load"
        >
          <option value="open_and_past_due">Open + past due</option>
          <option value="open">Open only</option>
          <option value="past_due">Past due only</option>
          <option value="paid">Paid</option>
          <option value="draft">Draft</option>
          <option value="void">Void</option>
          <option value="forgiven">Forgiven</option>
        </select>
        <select
          v-model="kindFilter"
          class="rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
          @change="load"
        >
          <option value="">All kinds</option>
          <option value="rent">Rent</option>
          <option value="dues">Dues</option>
          <option value="maintenance_pass_through">Maintenance pass-through</option>
          <option value="late_fee">Late fee</option>
          <option value="damage">Damage</option>
          <option value="security_deposit">Security deposit</option>
          <option value="adjustment">Adjustment</option>
        </select>
        <button
          type="button"
          class="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
          @click="load"
        >
          Refresh
        </button>
      </div>

      <!-- Table -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">Loading…</div>
        <div
          v-else-if="sortedCharges.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No charges in this view. Set up a rent or dues schedule (or wait for the daily
          generation cron) to populate this page.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Charge #</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Kind</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Total</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Balance</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Period</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Due</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Charged to</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr
                v-for="c in sortedCharges"
                :key="c.id"
                class="hover:bg-accent hover:text-accent-foreground"
              >
                <td class="px-3 py-2 font-mono text-xs">{{ c.charge_no }}</td>
                <td class="px-3 py-2 text-xs capitalize text-foreground">
                  {{ c.kind.replace(/_/g, ' ') }}
                </td>
                <td class="px-3 py-2">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(c.status)]">
                    {{ c.status.replace('_', ' ') }}
                  </span>
                </td>
                <td class="px-3 py-2 text-right tabular-nums text-foreground">
                  {{ formatPHP(c.total_minor, c.currency) }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums">
                  <span
                    :class="
                      c.total_minor - c.amount_paid_minor > 0 && c.status !== 'paid'
                        ? 'text-destructive font-medium'
                        : 'text-muted-foreground'
                    "
                  >
                    {{ formatPHP(c.total_minor - c.amount_paid_minor, c.currency) }}
                  </span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <span v-if="c.period_start && c.period_end">
                    {{ new Date(c.period_start).toLocaleDateString() }} →
                    {{ new Date(c.period_end).toLocaleDateString() }}
                  </span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </td>
                <td class="px-3 py-2 text-xs">
                  <span
                    :class="
                      c.status === 'past_due'
                        ? 'text-destructive font-medium '
                        : 'text-muted-foreground'
                    "
                  >{{ dueLabel(c) }}</span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <span v-if="c.charged_to_external_name">{{ c.charged_to_external_name }}</span>
                  <span v-else-if="c.charged_to_user_id" class="font-mono">
                    User {{ c.charged_to_user_id.slice(0, 8) }}…
                  </span>
                  <span v-else class="text-muted-foreground/70">—</span>
                  <span class="ml-1 text-[10px] text-muted-foreground/70">({{ c.billing_target }})</span>
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    v-if="c.status === 'open' || c.status === 'past_due'"
                    type="button"
                    class="text-xs text-primary hover:underline"
                    @click="openPay(c)"
                  >
                    Record payment
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Record payment — Phase 5 Operations primitive -->
      <UiModal
        :open="!!payModal"
        title="Record payment"
        :subtitle="payModal?.charge_no"
        width="md"
        @update:open="(v) => { if (!v) payModal = null }"
      >
        <div v-if="payModal" class="space-y-3">
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-xs text-muted-foreground">Total</p>
              <p class="font-medium tabular-nums">{{ formatPHP(payModal.total_minor, payModal.currency) }}</p>
            </div>
            <div>
              <p class="text-xs text-muted-foreground">Already paid</p>
              <p class="font-medium tabular-nums">{{ formatPHP(payModal.amount_paid_minor, payModal.currency) }}</p>
            </div>
          </div>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">
              Amount paid (centavos · {{ formatPHP(payForm.amount_minor, payModal.currency) }})
            </span>
            <input
              v-model.number="payForm.amount_minor"
              type="number"
              min="0"
              step="100"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <p class="mt-1 text-xs text-muted-foreground">
              Defaults to outstanding balance. Charge flips to <code>paid</code> on success.
            </p>
          </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="payModal = null"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="recording"
              class="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-success px-3.5 text-sm font-medium text-success-foreground transition-colors hover:bg-success/90 disabled:opacity-60 focus-ring"
              @click="recordPayment"
            >
              <span v-if="recording">Recording…</span>
              <span v-else>Confirm payment</span>
            </button>
          </div>
        </template>
      </UiModal>
    </template>
  </div>
</template>
