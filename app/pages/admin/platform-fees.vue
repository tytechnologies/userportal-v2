<script setup lang="ts">
/**
 * /admin/platform-fees — platform commission revenue dashboard.
 *
 * Post-pivot (2026-05-08) the platform earns by taking a configured
 * % of broker net commission per closed deal. Each deal's projected
 * fee lands here as a 'projected' platform_fee_charges row (auto by
 * the deals_create_platform_fee_projection trigger).
 *
 * What this page does:
 *   - Lists charges with status filter (projected / invoiced / paid / void)
 *   - Shows aggregate totals per status
 *   - "Run settlement" creates B6 invoices per agent for projected charges
 *   - Links to the commission-rule editor at /admin/platform-commission-rule
 *
 * Access: gated by has_permission('platform_fees.manage') OR admin.access.
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Platform Fees | Admin' })

type ChargeStatus = 'projected' | 'invoiced' | 'paid' | 'void'

type Charge = {
  id: string
  charge_no: string
  deal_id: string
  organization_id: string | null
  user_id: string | null
  basis_kind: string
  basis_value: number
  basis_reference_minor: number | null
  amount_minor: number
  currency: string
  status: ChargeStatus
  invoice_id: string | null
  invoiced_at: string | null
  paid_at: string | null
  voided_at: string | null
  void_reason: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const charges = ref<Charge[]>([])
const loading = ref(false)
const statusFilter = ref<ChargeStatus | 'all'>('all')

const settlementRunning = ref(false)
const settlementResult = ref<null | {
  period_end: string
  invoices_created: number
  charges_invoiced: number
  agents_skipped_no_org: number
}>(null)
const settlementPeriodEnd = ref<string>(new Date().toISOString().slice(0, 10))

async function load() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    const res = await $fetch<{ items: Charge[] }>('/api/admin/platform-fees', {
      query: params,
    })
    charges.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load fees', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function runSettlement() {
  settlementRunning.value = true
  settlementResult.value = null
  try {
    const res = await $fetch<{
      period_end: string
      invoices_created: number
      charges_invoiced: number
      agents_skipped_no_org: number
    }>('/api/admin/platform-fees/settlement-run', {
      method: 'POST',
      body: { period_end: settlementPeriodEnd.value },
    })
    settlementResult.value = res
    showToast({
      title: `Settlement complete: ${res.invoices_created} invoices, ${res.charges_invoiced} charges`,
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Settlement run failed',
      icon: 'error',
    })
  } finally {
    settlementRunning.value = false
  }
}

const totals = computed(() => {
  const t = { projected: 0, invoiced: 0, paid: 0, void: 0 }
  for (const c of charges.value) {
    if (c.status in t) t[c.status as keyof typeof t] += c.amount_minor
  }
  return t
})

const counts = computed(() => {
  const c = { projected: 0, invoiced: 0, paid: 0, void: 0 }
  for (const ch of charges.value) {
    if (ch.status in c) c[ch.status as keyof typeof c] += 1
  }
  return c
})

function formatPHP(minor: number): string {
  const major = minor / 100
  return major.toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function statusBadgeClass(s: ChargeStatus): string {
  switch (s) {
    case 'projected':
      return 'bg-warning/15 text-warning'
    case 'invoiced':
      return 'bg-primary/15 text-primary'
    case 'paid':
      return 'bg-success/15 text-success'
    case 'void':
      return 'bg-muted text-muted-foreground'
  }
}

onMounted(async () => {
  const ok = await hasPermission('platform_fees.manage')
  const okAdmin = ok || (await hasPermission('admin.access'))
  isChecking.value = false
  if (!okAdmin) {
    showToast({
      title: 'You do not have access to platform fees.',
      icon: 'warning',
    })
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
      <!-- Header -->
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-page-title">
            Platform Fees
          </h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Commission earned per closed deal · run monthly settlements to bill agents.
          </p>
        </div>
        <NuxtLink
          to="/admin/platform-commission-rule"
          class="inline-flex items-center rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
        >
          Edit commission rule →
        </NuxtLink>
      </div>

      <!-- Summary cards -->
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg border border-warning/30 bg-warning/10 p-4">
          <p class="text-xs font-medium text-warning">Projected</p>
          <p class="mt-1 text-xl font-semibold text-warning">
            {{ formatPHP(totals.projected) }}
          </p>
          <p class="mt-0.5 text-xs text-warning ">
            {{ counts.projected }} charge<span v-if="counts.projected !== 1">s</span>
          </p>
        </div>
        <div class="rounded-lg border border-primary/30 bg-primary/10 p-4 ">
          <p class="text-xs font-medium text-primary">Invoiced</p>
          <p class="mt-1 text-xl font-semibold text-primary">
            {{ formatPHP(totals.invoiced) }}
          </p>
          <p class="mt-0.5 text-xs text-primary">
            {{ counts.invoiced }} charge<span v-if="counts.invoiced !== 1">s</span>
          </p>
        </div>
        <div class="rounded-lg border border-success/30 bg-success/10 p-4 ">
          <p class="text-xs font-medium text-success ">Paid</p>
          <p class="mt-1 text-xl font-semibold text-success">
            {{ formatPHP(totals.paid) }}
          </p>
          <p class="mt-0.5 text-xs text-success">
            {{ counts.paid }} charge<span v-if="counts.paid !== 1">s</span>
          </p>
        </div>
        <div class="rounded-lg border border-border bg-muted/40 p-4">
          <p class="text-xs font-medium text-foreground">Voided</p>
          <p class="mt-1 text-xl font-semibold text-foreground">
            {{ formatPHP(totals.void) }}
          </p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ counts.void }} charge<span v-if="counts.void !== 1">s</span>
          </p>
        </div>
      </div>

      <!-- Settlement run -->
      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <h2 class="text-base font-semibold text-foreground">
          Run settlement
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Sweeps projected charges with created_at on or before the period end and creates
          one B6 invoice per agent. Invoices flow through the existing payment webhook; when
          the gateway settles, charges flip to <code>paid</code>.
        </p>
        <div class="mt-4 flex flex-wrap items-end gap-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Period end</span>
            <input
              v-model="settlementPeriodEnd"
              type="date"
              class="mt-1 block rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
            />
          </label>
          <button
            type="button"
            :disabled="settlementRunning"
            class="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
            @click="runSettlement"
          >
            <span v-if="settlementRunning">Running…</span>
            <span v-else>Run settlement now</span>
          </button>
        </div>
        <div
          v-if="settlementResult"
          class="mt-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success "
        >
          Settlement run complete:
          <strong>{{ settlementResult.invoices_created }}</strong> invoice<span v-if="settlementResult.invoices_created !== 1">s</span>
          created from <strong>{{ settlementResult.charges_invoiced }}</strong> charge<span v-if="settlementResult.charges_invoiced !== 1">s</span>.
          <span v-if="settlementResult.agents_skipped_no_org">
            ({{ settlementResult.agents_skipped_no_org }} agent<span v-if="settlementResult.agents_skipped_no_org !== 1">s</span> skipped — no org membership.)
          </span>
        </div>
      </section>

      <!-- Filter + table -->
      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <h2 class="mr-2 text-base font-semibold text-foreground">
            Charges
          </h2>
          <div class="inline-flex rounded-lg border border-border p-1">
            <button
              v-for="opt in (['all', 'projected', 'invoiced', 'paid', 'void'] as const)"
              :key="opt"
              type="button"
              :class="[
                'px-3 py-1 text-xs font-medium rounded-md transition',
                statusFilter === opt
                  ? 'bg-primary text-white'
                  : 'text-foreground hover:text-foreground/80',
              ]"
              @click="statusFilter = opt; load()"
            >
              {{ opt }}
            </button>
          </div>
          <button
            type="button"
            class="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
            @click="load"
          >
            Refresh
          </button>
        </div>

        <div v-if="loading" class="py-8 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="charges.length === 0"
          class="py-8 text-center text-sm text-muted-foreground"
        >
          No charges match the current filter.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Charge #</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Amount</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Basis</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Created</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Invoice</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="c in charges" :key="c.id" class="hover:bg-accent hover:text-accent-foreground">
                <td class="px-3 py-2 font-mono text-xs text-foreground">
                  {{ c.charge_no }}
                </td>
                <td class="px-3 py-2">
                  <span
                    :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusBadgeClass(c.status)]"
                  >{{ c.status }}</span>
                </td>
                <td class="px-3 py-2 text-right font-medium tabular-nums text-foreground">
                  {{ formatPHP(c.amount_minor) }}
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ c.basis_value }}<span v-if="c.basis_kind !== 'fixed'">%</span>
                  <span class="text-muted-foreground/70"> · {{ c.basis_kind }}</span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <span v-if="c.user_id" class="font-mono">{{ c.user_id.slice(0, 8) }}…</span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ new Date(c.created_at).toLocaleDateString() }}
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <span v-if="c.invoice_id" class="font-mono">{{ c.invoice_id.slice(0, 8) }}…</span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
