<script setup lang="ts">
/**
 * /admin/eis-submissions — BIR e-invoicing dashboard.
 *
 * Two sections:
 *   1. Eligible invoices — open/paid invoices with a "Submit" or
 *      "Resubmit" button per row. Inline shows the latest submission
 *      status (if any).
 *   2. Submission history — the most recent eis_submissions rows
 *      with status pills + drilldown into response_notes.
 *
 * Resubmit semantics: only enabled when the latest submission is in
 * a non-terminal state (queued/submitted/accepted) AND the operator
 * explicitly confirms. "rejected" submissions can be re-submitted
 * without confirmation since the prior is terminal.
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'
import UiDataTable from '~/components/ui/UiDataTable.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'EIS submissions | Admin' })

type SubStatus = 'queued' | 'submitted' | 'accepted' | 'rejected' | 'cancelled'

type Submission = {
  id: string
  reference_id: string
  status: SubStatus
  submitted_at: string | null
  external_reference: string | null
  response_notes: string | null
  cancel_reason: string | null
  created_at: string
  metadata?: Record<string, unknown>
  invoice?: {
    invoice_no: string
    total_minor: number
    currency: string
    status: string
  } | null
}

type EligibleInvoice = {
  id: string
  invoice_no: string
  organization_id: string
  currency: string
  total_minor: number
  status: 'open' | 'paid'
  issued_at: string | null
  paid_at: string | null
  latest_submission: {
    id: string
    status: SubStatus
    submitted_at: string | null
    response_notes: string | null
  } | null
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const eligibleLoading = ref(true)
const eligible = ref<EligibleInvoice[]>([])

const subsLoading = ref(true)
const subs = ref<Submission[]>([])
const subsFilter = ref<'all' | SubStatus>('all')
const subsQuery = ref<string>('')

// Client-side sort. Server returns a manageable page (<= 100 rows)
// so sorting in JS is fine. Shape matches UiDataTable's update:sort
// event — feeding the prop directly with no conversion.
const subsSort = ref<{ key: string; dir: 'asc' | 'desc' } | null>({
  key: 'created_at',
  dir: 'desc',
})

const subsColumns = [
  { id: 'created_at', label: 'When', tone: 'muted' as const, sortKey: 'created_at' },
  { id: 'invoice', label: 'Invoice', sortKey: 'invoice' },
  { id: 'status', label: 'Status', sortKey: 'status' },
  { id: 'external_reference', label: 'External ref', tone: 'muted' as const },
  { id: 'notes', label: 'Notes', tone: 'muted' as const },
  { id: 'action', label: '' },
]

const sortedSubs = computed(() => {
  const list = [...subs.value]
  if (!subsSort.value) return list
  const { key, dir } = subsSort.value
  const factor = dir === 'asc' ? 1 : -1
  return list.sort((a, b) => {
    let av: string | number
    let bv: string | number
    if (key === 'created_at') {
      av = a.created_at ?? ''
      bv = b.created_at ?? ''
    } else if (key === 'status') {
      av = a.status
      bv = b.status
    } else {
      // invoice — fall back to reference_id when no joined invoice
      av = a.invoice?.invoice_no ?? a.reference_id ?? ''
      bv = b.invoice?.invoice_no ?? b.reference_id ?? ''
    }
    if (av < bv) return -1 * factor
    if (av > bv) return 1 * factor
    return 0
  })
})
let subsSearchTimer: ReturnType<typeof setTimeout> | null = null

const submitting = ref<Record<string, boolean>>({})

// Columns + sort state for the eligible-invoices table. UiDataTable
// renders the sort glyph + accessibility semantics; we just hand it
// the config + the current sort, and it emits update:sort.
const eligibleColumns = [
  { id: 'invoice_no', label: 'Invoice', sortKey: 'invoice_no' },
  { id: 'status', label: 'Status', sortKey: 'status' },
  { id: 'total_minor', label: 'Total', tone: 'numeric' as const, sortKey: 'total_minor' },
  { id: 'issued_at', label: 'Issued', tone: 'muted' as const, sortKey: 'issued_at' },
  { id: 'latest', label: 'Latest EIS' },
  { id: 'action', label: '' },
]
const eligibleSort = ref<{ key: string; dir: 'asc' | 'desc' } | null>({
  key: 'issued_at',
  dir: 'desc',
})

const sortedEligible = computed(() => {
  if (!eligibleSort.value) return eligible.value
  const { key, dir } = eligibleSort.value
  const factor = dir === 'asc' ? 1 : -1
  return [...eligible.value].sort((a, b) => {
    const av = (a as any)[key]
    const bv = (b as any)[key]
    // null/undefined sort to the end regardless of direction
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (av < bv) return -1 * factor
    if (av > bv) return 1 * factor
    return 0
  })
})

async function loadEligible() {
  eligibleLoading.value = true
  try {
    const res = await $fetch<{ items: EligibleInvoice[] }>(
      '/api/admin/invoices/eligible-eis',
      { query: { limit: 100 } },
    )
    eligible.value = res.items
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load invoices', icon: 'error' })
  } finally {
    eligibleLoading.value = false
  }
}

async function loadSubs() {
  subsLoading.value = true
  try {
    const params: Record<string, string | number> = { limit: 100 }
    if (subsFilter.value !== 'all') params.status = subsFilter.value
    if (subsQuery.value.trim()) params.q = subsQuery.value.trim()
    const res = await $fetch<{ items: Submission[] }>('/api/admin/eis-submissions', {
      query: params,
    })
    subs.value = res.items
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load submissions', icon: 'error' })
  } finally {
    subsLoading.value = false
  }
}

// Debounce search input — operators type a few chars, we don't want
// to fire a request per keystroke.
function onSearchInput() {
  if (subsSearchTimer) clearTimeout(subsSearchTimer)
  subsSearchTimer = setTimeout(loadSubs, 250)
}

function fmtMoney(minor: number, currency: string): string {
  if (minor == null) return '—'
  return `${currency} ${(minor / 100).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function fmtSince(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function statusClass(s: SubStatus): string {
  switch (s) {
    case 'accepted':
      return 'bg-success/15 text-success'
    case 'submitted':
      return 'bg-primary/15 text-primary'
    case 'queued':
      return 'bg-warning/15 text-warning'
    case 'rejected':
      return 'bg-destructive/15 text-destructive'
    case 'cancelled':
      return 'bg-muted text-muted-foreground'
  }
}

function isTerminal(s: SubStatus): boolean {
  return s === 'rejected' || s === 'cancelled'
}

async function submit(invoice: EligibleInvoice) {
  const last = invoice.latest_submission
  let resubmit = false
  if (last && !isTerminal(last.status)) {
    const confirm = window.confirm(
      `This invoice already has a non-terminal EIS submission (status=${last.status}). ` +
        `Resubmit anyway?`,
    )
    if (!confirm) return
    resubmit = true
  }
  submitting.value[invoice.id] = true
  try {
    await $fetch('/api/admin/eis-submissions/submit', {
      method: 'POST',
      body: { invoice_id: invoice.id, resubmit },
    })
    showToast({ title: `Queued ${invoice.invoice_no}` })
    await Promise.all([loadEligible(), loadSubs()])
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Submit failed', icon: 'error' })
  } finally {
    submitting.value[invoice.id] = false
  }
}

const cancelling = ref<Record<string, boolean>>({})

async function cancel(s: Submission) {
  if (s.status === 'rejected' || s.status === 'cancelled') return
  if (s.status === 'accepted') {
    showToast({
      title: 'Accepted submissions cannot be cancelled — contact BIR',
      icon: 'warning',
    })
    return
  }
  const reason = window.prompt(
    `Cancel submission ${s.invoice?.invoice_no ?? s.reference_id.slice(0, 8)}? Enter a reason:`,
    '',
  )
  if (reason === null) return
  cancelling.value[s.id] = true
  try {
    await $fetch(`/api/admin/eis-submissions/${s.id}/cancel`, {
      method: 'POST',
      body: { reason: reason.trim() || undefined },
    })
    showToast({ title: 'Submission cancelled' })
    await Promise.all([loadEligible(), loadSubs()])
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Cancel failed', icon: 'error' })
  } finally {
    cancelling.value[s.id] = false
  }
}

const eligibleCount = computed(() => eligible.value.length)
const queuedSubs = computed(() => subs.value.filter((s) => s.status === 'queued').length)
const acceptedSubs = computed(() => subs.value.filter((s) => s.status === 'accepted').length)

onMounted(async () => {
  const ok = await hasPermission('admin.access')
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await Promise.all([loadEligible(), loadSubs()])
})
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <header>
        <h1 class="text-page-title">
          BIR e-Invoicing (EIS)
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Submit eligible invoices to BIR's Electronic Invoicing System and track
          their status. The submitter worker drains queued rows on its own; this
          page just queues them.
        </p>
      </header>

      <!-- Stat strip -->
      <section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg border border-border bg-card px-4 py-3 text-card-foreground">
          <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Eligible</div>
          <div class="mt-1 text-xl font-semibold tabular-nums">{{ eligibleCount }}</div>
        </div>
        <div class="rounded-lg border border-border bg-card px-4 py-3 text-card-foreground">
          <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Queued</div>
          <div class="mt-1 text-xl font-semibold tabular-nums">{{ queuedSubs }}</div>
        </div>
        <div class="rounded-lg border border-border bg-card px-4 py-3 text-card-foreground">
          <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Accepted</div>
          <div class="mt-1 text-xl font-semibold tabular-nums">{{ acceptedSubs }}</div>
        </div>
        <div class="rounded-lg border border-border bg-card px-4 py-3 text-card-foreground">
          <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Total recent</div>
          <div class="mt-1 text-xl font-semibold tabular-nums">{{ subs.length }}</div>
        </div>
      </section>

      <!-- Eligible invoices -->
      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-base font-semibold text-foreground">
            Eligible invoices
          </h2>
          <button
            type="button"
            class="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            @click="loadEligible"
          >
            Refresh
          </button>
        </div>

        <UiDataTable
          :columns="eligibleColumns"
          :rows="sortedEligible"
          :loading="eligibleLoading"
          :sort="eligibleSort"
          :row-key="(r) => r.id"
          @update:sort="eligibleSort = $event"
        >
          <template #empty>
            <p class="text-meta">No eligible (open/paid) invoices.</p>
          </template>
          <template #cell-invoice_no="{ row }">
            <span class="font-mono text-xs">{{ row.invoice_no }}</span>
          </template>
          <template #cell-status="{ row }">
            <span class="text-xs capitalize">{{ row.status }}</span>
          </template>
          <template #cell-total_minor="{ row }">
            <span class="tabular-nums">{{ fmtMoney(row.total_minor, row.currency) }}</span>
          </template>
          <template #cell-issued_at="{ row }">
            <span class="text-xs text-muted-foreground">
              {{ row.issued_at ? new Date(row.issued_at).toLocaleDateString() : '—' }}
            </span>
          </template>
          <template #cell-latest="{ row }">
            <span
              v-if="row.latest_submission"
              class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
              :class="statusClass(row.latest_submission.status)"
            >
              {{ row.latest_submission.status }}
            </span>
            <span v-else class="text-muted-foreground/70">—</span>
          </template>
          <template #cell-action="{ row }">
            <button
              type="button"
              :disabled="submitting[row.id]"
              class="rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60 focus-ring"
              @click="submit(row)"
            >
              <span v-if="submitting[row.id]">…</span>
              <span v-else-if="row.latest_submission && !isTerminal(row.latest_submission.status)">
                Resubmit
              </span>
              <span v-else-if="row.latest_submission?.status === 'rejected'">Resubmit</span>
              <span v-else>Submit</span>
            </button>
          </template>
        </UiDataTable>
      </section>

      <!-- Submission history -->
      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-base font-semibold text-foreground">
            Submission history
          </h2>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="subsQuery"
              type="search"
              placeholder="Search reason / notes / external ref"
              class="w-56 rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:ring-1 focus:ring-ring"
              @input="onSearchInput"
            />
            <select
              v-model="subsFilter"
              class="rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-foreground"
              @change="loadSubs"
            >
              <option value="all">All statuses</option>
              <option value="queued">Queued</option>
              <option value="submitted">Submitted</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button
              type="button"
              class="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              @click="loadSubs"
            >
              Refresh
            </button>
          </div>
        </div>

        <UiDataTable
          :columns="subsColumns"
          :rows="sortedSubs"
          :loading="subsLoading"
          :sort="subsSort"
          :row-key="(r) => r.id"
          @update:sort="subsSort = $event"
        >
          <template #empty>
            <p class="text-meta">No submissions.</p>
          </template>
          <template #cell-created_at="{ row }">
            <span class="text-xs text-muted-foreground">{{ fmtSince(row.created_at) }}</span>
          </template>
          <template #cell-invoice="{ row }">
            <span v-if="row.invoice" class="font-mono text-xs">{{ row.invoice.invoice_no }}</span>
            <span v-else class="font-mono text-xs text-muted-foreground/70">
              {{ row.reference_id.slice(0, 8) }}…
            </span>
          </template>
          <template #cell-status="{ row }">
            <span
              class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
              :class="statusClass(row.status)"
            >
              {{ row.status }}
            </span>
            <span
              v-if="row.metadata && (row.metadata as any).noop_provider"
              class="ml-1 inline-flex rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              title="Stamped without contacting BIR"
            >
              noop
            </span>
          </template>
          <template #cell-external_reference="{ row }">
            <span class="font-mono text-[10px] text-muted-foreground">
              {{ row.external_reference || '—' }}
            </span>
          </template>
          <template #cell-notes="{ row }">
            <div class="text-xs text-muted-foreground max-w-md">
              <div v-if="row.response_notes" class="truncate" :title="row.response_notes">
                {{ row.response_notes }}
              </div>
              <div
                v-if="row.cancel_reason"
                class="mt-0.5 truncate text-[10px] text-destructive"
                :title="row.cancel_reason"
              >
                Cancelled: {{ row.cancel_reason }}
              </div>
            </div>
          </template>
          <template #cell-action="{ row }">
            <button
              v-if="row.status !== 'rejected' && row.status !== 'cancelled' && row.status !== 'accepted'"
              type="button"
              :disabled="cancelling[row.id]"
              class="text-xs text-destructive hover:underline disabled:opacity-50 focus-ring"
              @click="cancel(row)"
            >
              {{ cancelling[row.id] ? 'Cancelling…' : 'Cancel' }}
            </button>
          </template>
        </UiDataTable>
      </section>
    </template>
  </div>
</template>
