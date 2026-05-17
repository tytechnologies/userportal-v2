<script setup lang="ts">
/**
 * /admin/statements — owner + tenant statements queue.
 *
 * Tab switcher between owner and tenant statements. Each tab shows a
 * filterable list with click-to-expand line items and per-row "Issue"
 * action for drafts.
 *
 * Statement creation lives elsewhere (per-owner / per-lease pages, or
 * scripted bulk runs). This page is the centralised review + issue surface.
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Statements | Admin' })

type OwnerStatementStatus = 'draft' | 'issued' | 'disbursed' | 'void'
type TenantStatementStatus = 'draft' | 'issued' | 'paid' | 'overdue' | 'void'

type LineItem = Record<string, unknown> & {
  description?: string
  quantity?: number
  unit_amount_minor?: number
  total_minor?: number
  kind?: string
}

type OwnerStatement = {
  id: string
  owner_id: string
  statement_no: string
  period_start: string
  period_end: string
  currency: string
  rent_collected_minor: number
  dues_collected_minor: number
  expenses_minor: number
  management_fee_minor: number
  tax_withheld_minor: number
  net_disbursement_minor: number
  line_items: LineItem[]
  status: OwnerStatementStatus
  issued_at: string | null
  disbursed_at: string | null
  external_reference: string | null
  created_at: string
}

type TenantStatement = {
  id: string
  lease_id: string
  tenant_party_id: string | null
  statement_no: string
  period_start: string
  period_end: string
  currency: string
  rent_billed_minor: number
  other_charges_minor: number
  payments_received_minor: number
  balance_due_minor: number
  line_items: LineItem[]
  status: TenantStatementStatus
  issued_at: string | null
  due_at: string | null
  paid_at: string | null
  created_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const tab = ref<'owner' | 'tenant'>('owner')

const ownerRows = ref<OwnerStatement[]>([])
const tenantRows = ref<TenantStatement[]>([])
const loading = ref(false)
const ownerStatusFilter = ref<OwnerStatementStatus | 'all'>('all')
const tenantStatusFilter = ref<TenantStatementStatus | 'all'>('all')

const expandedRow = ref<string | null>(null)
const issuingId = ref<string | null>(null)

async function loadOwner() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (ownerStatusFilter.value !== 'all') params.status = ownerStatusFilter.value
    const res = await $fetch<{ items: OwnerStatement[] }>(
      '/api/admin/owner-statements',
      { query: params },
    )
    ownerRows.value = res.items ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load owner statements',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function loadTenant() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (tenantStatusFilter.value !== 'all') params.status = tenantStatusFilter.value
    const res = await $fetch<{ items: TenantStatement[] }>(
      '/api/admin/tenant-statements',
      { query: params },
    )
    tenantRows.value = res.items ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load tenant statements',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function load() {
  if (tab.value === 'owner') await loadOwner()
  else await loadTenant()
}

async function issueOwner(s: OwnerStatement) {
  if (s.status !== 'draft') return
  issuingId.value = s.id
  try {
    await $fetch(`/api/owner-statements/${s.id}/issue`, { method: 'POST' })
    showToast({ title: `Issued ${s.statement_no}` })
    await loadOwner()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Issue failed', icon: 'error' })
  } finally {
    issuingId.value = null
  }
}

async function issueTenant(s: TenantStatement) {
  if (s.status !== 'draft') return
  issuingId.value = s.id
  try {
    await $fetch(`/api/tenant-statements/${s.id}/issue`, { method: 'POST' })
    showToast({ title: `Issued ${s.statement_no}` })
    await loadTenant()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Issue failed', icon: 'error' })
  } finally {
    issuingId.value = null
  }
}

const ownerCounts = computed(() => {
  const c: Record<string, number> = {
    all: ownerRows.value.length,
    draft: 0,
    issued: 0,
    disbursed: 0,
    void: 0,
  }
  for (const s of ownerRows.value) c[s.status] = (c[s.status] ?? 0) + 1
  return c
})

const tenantCounts = computed(() => {
  const c: Record<string, number> = {
    all: tenantRows.value.length,
    draft: 0,
    issued: 0,
    paid: 0,
    overdue: 0,
    void: 0,
  }
  for (const s of tenantRows.value) c[s.status] = (c[s.status] ?? 0) + 1
  return c
})

const ownerTotals = computed(() => {
  let collected = 0
  let disbursed = 0
  for (const s of ownerRows.value) {
    if (s.status === 'issued' || s.status === 'disbursed')
      collected += s.rent_collected_minor + s.dues_collected_minor
    if (s.status === 'disbursed') disbursed += s.net_disbursement_minor
  }
  return { collected, disbursed }
})

const tenantTotals = computed(() => {
  let billed = 0
  let outstanding = 0
  let paid = 0
  for (const s of tenantRows.value) {
    if (s.status === 'issued' || s.status === 'overdue' || s.status === 'paid') {
      billed += s.rent_billed_minor + s.other_charges_minor
    }
    if (s.status === 'issued' || s.status === 'overdue') outstanding += s.balance_due_minor
    if (s.status === 'paid') paid += s.payments_received_minor
  }
  return { billed, outstanding, paid }
})

function formatPHP(minor: number, currency = 'PHP') {
  return (Number(minor) / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })
}

function ownerStatusClass(s: OwnerStatementStatus) {
  if (s === 'disbursed') return 'bg-success/15 text-success'
  if (s === 'issued') return 'bg-primary/15 text-primary'
  if (s === 'draft') return 'bg-warning/15 text-warning'
  return 'bg-muted text-muted-foreground'
}

function tenantStatusClass(s: TenantStatementStatus) {
  if (s === 'paid') return 'bg-success/15 text-success'
  if (s === 'overdue') return 'bg-destructive/15 text-destructive'
  if (s === 'issued') return 'bg-primary/15 text-primary'
  if (s === 'draft') return 'bg-warning/15 text-warning'
  return 'bg-muted text-muted-foreground'
}

function toggleExpand(id: string) {
  expandedRow.value = expandedRow.value === id ? null : id
}

onMounted(async () => {
  const ok =
    (await hasPermission('property.manage')) || (await hasPermission('admin.access'))
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
          Statements
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Review and issue periodic owner and tenant statements. Issued statements are
          append-only — corrections require void + new statement.
        </p>
      </header>

      <!-- Owner / Tenant tab switcher -->
      <div class="inline-flex rounded-lg border border-border p-1">
        <button
          type="button"
          :class="[
            'px-4 py-1.5 text-sm font-medium rounded-md transition',
            tab === 'owner'
              ? 'bg-primary text-white'
              : 'text-foreground hover:text-foreground/80',
          ]"
          @click="tab = 'owner'; load()"
        >
          Owner statements
          <span
            :class="[
              'ml-1.5 rounded-full px-1.5 text-[10px] font-semibold',
              tab === 'owner' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground ',
            ]"
          >{{ ownerRows.length }}</span>
        </button>
        <button
          type="button"
          :class="[
            'ml-1 px-4 py-1.5 text-sm font-medium rounded-md transition',
            tab === 'tenant'
              ? 'bg-primary text-white'
              : 'text-foreground hover:text-foreground/80',
          ]"
          @click="tab = 'tenant'; load()"
        >
          Tenant statements
          <span
            :class="[
              'ml-1.5 rounded-full px-1.5 text-[10px] font-semibold',
              tab === 'tenant' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground ',
            ]"
          >{{ tenantRows.length }}</span>
        </button>
      </div>

      <!-- ===================== OWNER TAB ===================== -->
      <template v-if="tab === 'owner'">
        <!-- Totals -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="rounded-lg border border-primary/30 bg-primary/10 p-4 ">
            <p class="text-xs font-medium text-primary">Collected (issued + disbursed)</p>
            <p class="mt-1 text-xl font-semibold tabular-nums text-primary">
              {{ formatPHP(ownerTotals.collected) }}
            </p>
          </div>
          <div class="rounded-lg border border-success/30 bg-success/10 p-4 ">
            <p class="text-xs font-medium text-success ">Disbursed</p>
            <p class="mt-1 text-xl font-semibold tabular-nums text-success">
              {{ formatPHP(ownerTotals.disbursed) }}
            </p>
          </div>
        </div>

        <!-- Owner status filter -->
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="opt in (['all', 'draft', 'issued', 'disbursed', 'void'] as const)"
            :key="opt"
            type="button"
            :class="[
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
              ownerStatusFilter === opt
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
            ]"
            @click="ownerStatusFilter = opt; loadOwner()"
          >
            <span class="capitalize">{{ opt }}</span>
            <span
              :class="[
                'rounded-full px-1.5 text-[10px] font-semibold',
                ownerStatusFilter === opt ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground ',
              ]"
            >{{ ownerCounts[opt] }}</span>
          </button>
        </div>

        <!-- Owner table -->
        <section class="rounded-lg border border-border bg-card text-card-foreground">
          <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">Loading…</div>
          <div
            v-else-if="ownerRows.length === 0"
            class="p-5 text-center text-sm text-muted-foreground"
          >
            No owner statements in this view.
          </div>
          <div v-else>
          <!-- Mobile: card list (< md). Tap row to expand totals + line items. -->
          <ul class="divide-y divide-border md:hidden">
            <li v-for="s in ownerRows" :key="s.id" class="p-4">
              <button
                type="button"
                class="flex w-full items-start justify-between gap-3 text-left"
                @click="toggleExpand(s.id)"
              >
                <div class="min-w-0">
                  <p class="font-mono text-xs text-muted-foreground">{{ s.statement_no }}</p>
                  <p class="mt-0.5 text-xs text-muted-foreground">
                    {{ new Date(s.period_start).toLocaleDateString() }} →
                    {{ new Date(s.period_end).toLocaleDateString() }}
                  </p>
                  <p class="mt-1 text-base font-semibold tabular-nums text-foreground">
                    {{ formatPHP(s.net_disbursement_minor, s.currency) }}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    Collected {{ formatPHP(s.rent_collected_minor + s.dues_collected_minor, s.currency) }}
                  </p>
                </div>
                <span :class="['inline-flex flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', ownerStatusClass(s.status)]">
                  {{ s.status }}
                </span>
              </button>
              <div class="mt-3 flex items-center gap-3">
                <button
                  v-if="s.status === 'draft'"
                  type="button"
                  :disabled="issuingId === s.id"
                  class="text-xs text-primary hover:underline disabled:opacity-50"
                  @click.stop="issueOwner(s)"
                >
                  <span v-if="issuingId === s.id">Issuing…</span>
                  <span v-else>Issue</span>
                </button>
                <span class="ml-auto text-[10px] text-muted-foreground/70">
                  {{ expandedRow === s.id ? 'Hide details â–´' : 'Show details â–¾' }}
                </span>
              </div>
              <!-- Expanded breakdown -->
              <div v-if="expandedRow === s.id" class="mt-3 rounded-lg bg-muted/40 p-3 text-xs">
                <div class="grid grid-cols-2 gap-3">
                  <div><p class="text-muted-foreground">Rent</p><p class="font-medium tabular-nums">{{ formatPHP(s.rent_collected_minor, s.currency) }}</p></div>
                  <div><p class="text-muted-foreground">Dues</p><p class="font-medium tabular-nums">{{ formatPHP(s.dues_collected_minor, s.currency) }}</p></div>
                  <div><p class="text-muted-foreground">Expenses</p><p class="font-medium tabular-nums">{{ formatPHP(s.expenses_minor, s.currency) }}</p></div>
                  <div><p class="text-muted-foreground">Mgmt fee</p><p class="font-medium tabular-nums">{{ formatPHP(s.management_fee_minor, s.currency) }}</p></div>
                  <div><p class="text-muted-foreground">Tax withheld</p><p class="font-medium tabular-nums">{{ formatPHP(s.tax_withheld_minor, s.currency) }}</p></div>
                </div>
                <div v-if="s.line_items?.length" class="mt-3">
                  <p class="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">Line items</p>
                  <ul class="space-y-1">
                    <li v-for="(li, idx) in s.line_items" :key="idx" class="flex items-center justify-between rounded border border-border px-2 py-1.5">
                      <span>
                        <span class="font-medium">{{ li.kind || 'item' }}</span>
                        <span v-if="li.description" class="ml-1 text-muted-foreground">{{ li.description }}</span>
                      </span>
                      <span class="tabular-nums">{{ formatPHP((li.total_minor as number) ?? 0, s.currency) }}</span>
                    </li>
                  </ul>
                </div>
              </div>
            </li>
          </ul>

          <!-- Desktop table (md+) -->
          <div class="hidden overflow-x-auto md:block">
            <table class="min-w-full divide-y divide-border text-sm">
              <thead class="bg-muted/40">
                <tr>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Statement</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Period</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Collected</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Net disbursement</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                <template v-for="s in ownerRows" :key="s.id">
                  <tr
                    class="cursor-pointer hover:bg-accent hover:text-accent-foreground"
                    @click="toggleExpand(s.id)"
                  >
                    <td class="px-3 py-2 font-mono text-xs">{{ s.statement_no }}</td>
                    <td class="px-3 py-2 text-xs text-muted-foreground">
                      {{ new Date(s.period_start).toLocaleDateString() }} →
                      {{ new Date(s.period_end).toLocaleDateString() }}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums">
                      {{ formatPHP(s.rent_collected_minor + s.dues_collected_minor, s.currency) }}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums font-medium">
                      {{ formatPHP(s.net_disbursement_minor, s.currency) }}
                    </td>
                    <td class="px-3 py-2">
                      <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', ownerStatusClass(s.status)]">
                        {{ s.status }}
                      </span>
                    </td>
                    <td class="px-3 py-2 text-right">
                      <button
                        v-if="s.status === 'draft'"
                        type="button"
                        :disabled="issuingId === s.id"
                        class="text-xs text-primary hover:underline disabled:opacity-50"
                        @click.stop="issueOwner(s)"
                      >
                        <span v-if="issuingId === s.id">Issuing…</span>
                        <span v-else>Issue</span>
                      </button>
                      <span v-else class="text-[10px] text-muted-foreground/70">
                        {{ expandedRow === s.id ? 'â–´' : 'â–¾' }}
                      </span>
                    </td>
                  </tr>
                  <!-- Expanded line items -->
                  <tr v-if="expandedRow === s.id" class="bg-muted/40 ">
                    <td colspan="6" class="px-4 py-3">
                      <div class="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
                        <div>
                          <p class="text-muted-foreground">Rent collected</p>
                          <p class="font-medium tabular-nums">{{ formatPHP(s.rent_collected_minor, s.currency) }}</p>
                        </div>
                        <div>
                          <p class="text-muted-foreground">Dues collected</p>
                          <p class="font-medium tabular-nums">{{ formatPHP(s.dues_collected_minor, s.currency) }}</p>
                        </div>
                        <div>
                          <p class="text-muted-foreground">Expenses</p>
                          <p class="font-medium tabular-nums">{{ formatPHP(s.expenses_minor, s.currency) }}</p>
                        </div>
                        <div>
                          <p class="text-muted-foreground">Management fee</p>
                          <p class="font-medium tabular-nums">{{ formatPHP(s.management_fee_minor, s.currency) }}</p>
                        </div>
                        <div>
                          <p class="text-muted-foreground">Tax withheld</p>
                          <p class="font-medium tabular-nums">{{ formatPHP(s.tax_withheld_minor, s.currency) }}</p>
                        </div>
                      </div>
                      <div v-if="s.line_items?.length" class="mt-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Line items</p>
                        <ul class="space-y-1">
                          <li
                            v-for="(li, idx) in s.line_items"
                            :key="idx"
                            class="flex items-center justify-between rounded border border-border px-2 py-1.5 text-xs "
                          >
                            <span>
                              <span class="font-medium">{{ li.kind || 'item' }}</span>
                              <span v-if="li.description" class="ml-1 text-muted-foreground">{{ li.description }}</span>
                            </span>
                            <span class="tabular-nums">
                              {{ formatPHP((li.total_minor as number) ?? 0, s.currency) }}
                            </span>
                          </li>
                        </ul>
                      </div>
                      <p v-else class="mt-3 text-xs text-muted-foreground">No line items recorded.</p>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            </div>
          </div>
        </section>
      </template>

      <!-- ===================== TENANT TAB ===================== -->
      <template v-else>
        <!-- Totals -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="rounded-lg border border-primary/30 bg-primary/10 p-4 ">
            <p class="text-xs font-medium text-primary">Billed</p>
            <p class="mt-1 text-xl font-semibold tabular-nums text-primary">
              {{ formatPHP(tenantTotals.billed) }}
            </p>
          </div>
          <div class="rounded-lg border border-warning/30 bg-warning/10 p-4">
            <p class="text-xs font-medium text-warning">Outstanding</p>
            <p class="mt-1 text-xl font-semibold tabular-nums text-warning">
              {{ formatPHP(tenantTotals.outstanding) }}
            </p>
          </div>
          <div class="rounded-lg border border-success/30 bg-success/10 p-4 ">
            <p class="text-xs font-medium text-success ">Paid</p>
            <p class="mt-1 text-xl font-semibold tabular-nums text-success">
              {{ formatPHP(tenantTotals.paid) }}
            </p>
          </div>
        </div>

        <!-- Tenant status filter -->
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="opt in (['all', 'draft', 'issued', 'overdue', 'paid', 'void'] as const)"
            :key="opt"
            type="button"
            :class="[
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
              tenantStatusFilter === opt
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
            ]"
            @click="tenantStatusFilter = opt; loadTenant()"
          >
            <span class="capitalize">{{ opt }}</span>
            <span
              :class="[
                'rounded-full px-1.5 text-[10px] font-semibold',
                tenantStatusFilter === opt ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground ',
              ]"
            >{{ tenantCounts[opt] }}</span>
          </button>
        </div>

        <!-- Tenant table -->
        <section class="rounded-lg border border-border bg-card text-card-foreground">
          <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">Loading…</div>
          <div
            v-else-if="tenantRows.length === 0"
            class="p-5 text-center text-sm text-muted-foreground"
          >
            No tenant statements in this view.
          </div>
          <div v-else>
          <!-- Mobile: card list (< md). -->
          <ul class="divide-y divide-border md:hidden">
            <li v-for="s in tenantRows" :key="s.id" class="p-4">
              <button
                type="button"
                class="flex w-full items-start justify-between gap-3 text-left"
                @click="toggleExpand(s.id)"
              >
                <div class="min-w-0">
                  <p class="font-mono text-xs text-muted-foreground">{{ s.statement_no }}</p>
                  <p class="mt-0.5 text-xs text-muted-foreground">
                    {{ new Date(s.period_start).toLocaleDateString() }} →
                    {{ new Date(s.period_end).toLocaleDateString() }}
                  </p>
                  <p class="mt-1 text-base font-semibold tabular-nums" :class="
                    s.balance_due_minor > 0 && (s.status === 'issued' || s.status === 'overdue')
                      ? 'text-destructive'
                      : 'text-foreground'
                  ">
                    {{ formatPHP(s.balance_due_minor, s.currency) }} <span class="text-xs font-normal text-muted-foreground">due</span>
                  </p>
                  <p class="text-xs text-muted-foreground">
                    Billed {{ formatPHP(s.rent_billed_minor + s.other_charges_minor, s.currency) }}
                    <span v-if="s.due_at"> · due {{ new Date(s.due_at).toLocaleDateString() }}</span>
                  </p>
                </div>
                <span :class="['inline-flex flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', tenantStatusClass(s.status)]">
                  {{ s.status }}
                </span>
              </button>
              <div class="mt-3 flex items-center gap-3">
                <button
                  v-if="s.status === 'draft'"
                  type="button"
                  :disabled="issuingId === s.id"
                  class="text-xs text-primary hover:underline disabled:opacity-50"
                  @click.stop="issueTenant(s)"
                >
                  <span v-if="issuingId === s.id">Issuing…</span>
                  <span v-else>Issue</span>
                </button>
                <span class="ml-auto text-[10px] text-muted-foreground/70">
                  {{ expandedRow === s.id ? 'Hide details â–´' : 'Show details â–¾' }}
                </span>
              </div>
              <div v-if="expandedRow === s.id" class="mt-3 rounded-lg bg-muted/40 p-3 text-xs">
                <div class="grid grid-cols-2 gap-3">
                  <div><p class="text-muted-foreground">Rent billed</p><p class="font-medium tabular-nums">{{ formatPHP(s.rent_billed_minor, s.currency) }}</p></div>
                  <div><p class="text-muted-foreground">Other charges</p><p class="font-medium tabular-nums">{{ formatPHP(s.other_charges_minor, s.currency) }}</p></div>
                  <div><p class="text-muted-foreground">Payments</p><p class="font-medium tabular-nums">{{ formatPHP(s.payments_received_minor, s.currency) }}</p></div>
                  <div><p class="text-muted-foreground">Issued</p><p class="font-medium">{{ s.issued_at ? new Date(s.issued_at).toLocaleDateString() : '—' }}</p></div>
                </div>
                <div v-if="s.line_items?.length" class="mt-3">
                  <p class="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">Line items</p>
                  <ul class="space-y-1">
                    <li v-for="(li, idx) in s.line_items" :key="idx" class="flex items-center justify-between rounded border border-border px-2 py-1.5">
                      <span>
                        <span class="font-medium">{{ li.kind || 'item' }}</span>
                        <span v-if="li.description" class="ml-1 text-muted-foreground">{{ li.description }}</span>
                      </span>
                      <span class="tabular-nums">{{ formatPHP((li.total_minor as number) ?? 0, s.currency) }}</span>
                    </li>
                  </ul>
                </div>
              </div>
            </li>
          </ul>

          <!-- Desktop table (md+) -->
          <div class="hidden overflow-x-auto md:block">
            <table class="min-w-full divide-y divide-border text-sm">
              <thead class="bg-muted/40">
                <tr>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Statement</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Period</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Billed</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Balance due</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Due</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                <template v-for="s in tenantRows" :key="s.id">
                  <tr
                    class="cursor-pointer hover:bg-accent hover:text-accent-foreground"
                    @click="toggleExpand(s.id)"
                  >
                    <td class="px-3 py-2 font-mono text-xs">{{ s.statement_no }}</td>
                    <td class="px-3 py-2 text-xs text-muted-foreground">
                      {{ new Date(s.period_start).toLocaleDateString() }} →
                      {{ new Date(s.period_end).toLocaleDateString() }}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums">
                      {{ formatPHP(s.rent_billed_minor + s.other_charges_minor, s.currency) }}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums">
                      <span
                        :class="
                          s.balance_due_minor > 0 && (s.status === 'issued' || s.status === 'overdue')
                            ? 'text-destructive font-medium '
                            : 'text-muted-foreground'
                        "
                      >
                        {{ formatPHP(s.balance_due_minor, s.currency) }}
                      </span>
                    </td>
                    <td class="px-3 py-2 text-xs text-muted-foreground">
                      {{ s.due_at ? new Date(s.due_at).toLocaleDateString() : '—' }}
                    </td>
                    <td class="px-3 py-2">
                      <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', tenantStatusClass(s.status)]">
                        {{ s.status }}
                      </span>
                    </td>
                    <td class="px-3 py-2 text-right">
                      <button
                        v-if="s.status === 'draft'"
                        type="button"
                        :disabled="issuingId === s.id"
                        class="text-xs text-primary hover:underline disabled:opacity-50"
                        @click.stop="issueTenant(s)"
                      >
                        <span v-if="issuingId === s.id">Issuing…</span>
                        <span v-else>Issue</span>
                      </button>
                      <span v-else class="text-[10px] text-muted-foreground/70">
                        {{ expandedRow === s.id ? 'â–´' : 'â–¾' }}
                      </span>
                    </td>
                  </tr>
                  <!-- Expanded line items -->
                  <tr v-if="expandedRow === s.id" class="bg-muted/40 ">
                    <td colspan="7" class="px-4 py-3">
                      <div class="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                        <div>
                          <p class="text-muted-foreground">Rent billed</p>
                          <p class="font-medium tabular-nums">{{ formatPHP(s.rent_billed_minor, s.currency) }}</p>
                        </div>
                        <div>
                          <p class="text-muted-foreground">Other charges</p>
                          <p class="font-medium tabular-nums">{{ formatPHP(s.other_charges_minor, s.currency) }}</p>
                        </div>
                        <div>
                          <p class="text-muted-foreground">Payments received</p>
                          <p class="font-medium tabular-nums">{{ formatPHP(s.payments_received_minor, s.currency) }}</p>
                        </div>
                        <div>
                          <p class="text-muted-foreground">Issued</p>
                          <p class="font-medium">
                            {{ s.issued_at ? new Date(s.issued_at).toLocaleDateString() : '—' }}
                          </p>
                        </div>
                      </div>
                      <div v-if="s.line_items?.length" class="mt-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Line items</p>
                        <ul class="space-y-1">
                          <li
                            v-for="(li, idx) in s.line_items"
                            :key="idx"
                            class="flex items-center justify-between rounded border border-border px-2 py-1.5 text-xs "
                          >
                            <span>
                              <span class="font-medium">{{ li.kind || 'item' }}</span>
                              <span v-if="li.description" class="ml-1 text-muted-foreground">{{ li.description }}</span>
                            </span>
                            <span class="tabular-nums">
                              {{ formatPHP((li.total_minor as number) ?? 0, s.currency) }}
                            </span>
                          </li>
                        </ul>
                      </div>
                      <p v-else class="mt-3 text-xs text-muted-foreground">No line items recorded.</p>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            </div>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
