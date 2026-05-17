<script setup lang="ts">
/**
 * /admin/bank-reconciliation — match imported bank statement lines to
 * journal_lines on the bank's GL account.
 *
 * Three sub-flows:
 *   - Pick a bank account (dropdown of all bank_accounts)
 *   - Import: paste CSV → POST one bank_transaction per row
 *   - Match: per-row "Find match" → modal lists candidates from
 *     /api/bank-accounts/:id/transactions/:txId/match-candidates →
 *     operator picks one → POST .../match
 *
 * "Mark as ignored" (e.g., bank fees the operator doesn't book)
 * supported via direct UPDATE — repo doesn't yet have an explicit
 * endpoint so the page omits that toggle for now (deferred).
 */

import { ref, computed, onMounted, reactive, watch } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'
import UiDrawer from '~/components/ui/UiDrawer.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Bank Reconciliation | Admin' })

type BankAccount = {
  id: string
  account_id: string
  bank_name: string
  account_number: string
  account_name: string
  currency: string
  account_type: string
  status: string
  opening_balance_minor: number
}

type TxStatus = 'unmatched' | 'matched' | 'manual' | 'ignored'

type BankTx = {
  id: string
  bank_account_id: string
  posted_at: string
  description: string | null
  reference: string | null
  amount_minor: number
  balance_minor: number | null
  source: 'manual' | 'csv_import' | 'api_import'
  matched_journal_line_id: string | null
  matched_at: string | null
  status: TxStatus
  created_at: string
}

type Candidate = {
  id: string
  journal_entry_id: string
  debit_minor: number
  credit_minor: number
  currency: string
  description: string | null
  entry_no: string
  entry_description: string
  entry_date: string
  day_distance: number
}

type AccountBalance = {
  account_id: string
  code: string
  name: string
  account_type: string
  currency: string
  net_balance_minor: number
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const bankAccounts = ref<BankAccount[]>([])
const selectedBankId = ref<string | null>(null)

const transactions = ref<BankTx[]>([])
const loading = ref(false)
const statusFilter = ref<TxStatus | 'all'>('unmatched')
const glBalance = ref<number | null>(null)
const latestBankBalance = ref<number | null>(null)

// Match modal
const matchModal = ref<BankTx | null>(null)
const candidates = ref<Candidate[]>([])
const candidatesLoading = ref(false)
const matchingId = ref<string | null>(null)

// Import section
const showImport = ref(false)
const csvText = ref('')
const importing = ref(false)
const importProgress = ref<{ ok: number; failed: number; total: number } | null>(null)

const selectedBank = computed(
  () => bankAccounts.value.find((b) => b.id === selectedBankId.value) ?? null,
)

async function loadBankAccounts() {
  try {
    const res = await $fetch<{ items: BankAccount[] }>('/api/bank-accounts')
    bankAccounts.value = res.items ?? []
    if (!selectedBankId.value && bankAccounts.value.length > 0) {
      selectedBankId.value = bankAccounts.value[0]!.id
    }
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load bank accounts', icon: 'error' })
  }
}

async function loadTransactions() {
  if (!selectedBankId.value) {
    transactions.value = []
    latestBankBalance.value = null
    return
  }
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    const res = await $fetch<{ items: BankTx[] }>(
      `/api/bank-accounts/${selectedBankId.value}/transactions`,
      { query: params },
    )
    transactions.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load transactions', icon: 'error' })
  } finally {
    loading.value = false
  }
  // Always pull the most recent balance_minor across ALL statuses for
  // the drift card — the filtered table view shouldn't suppress it.
  await loadLatestBalance()
  await loadGlBalance()
}

async function loadLatestBalance() {
  if (!selectedBankId.value) return
  try {
    const res = await $fetch<{ items: BankTx[] }>(
      `/api/bank-accounts/${selectedBankId.value}/transactions`,
      { query: {} },
    )
    // Find most recent row with non-null balance_minor.
    const sorted = (res.items ?? [])
      .filter((t) => t.balance_minor !== null)
      .sort(
        (a, b) =>
          new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime(),
      )
    latestBankBalance.value = sorted[0]?.balance_minor ?? null
  } catch {
    latestBankBalance.value = null
  }
}

async function loadGlBalance() {
  if (!selectedBank.value) return
  try {
    const res = await $fetch<{ items: AccountBalance[] }>(
      '/api/admin/accounting/account-balances',
      { query: { account_id: selectedBank.value.account_id } },
    )
    glBalance.value = res.items?.[0]?.net_balance_minor ?? null
  } catch {
    glBalance.value = null
  }
}

const driftMinor = computed(() => {
  if (glBalance.value === null || latestBankBalance.value === null) return null
  return latestBankBalance.value - glBalance.value
})

watch([selectedBankId, statusFilter], loadTransactions)

async function openMatch(tx: BankTx) {
  matchModal.value = tx
  candidates.value = []
  candidatesLoading.value = true
  try {
    const res = await $fetch<{ items: Candidate[]; already_matched: boolean }>(
      `/api/bank-accounts/${tx.bank_account_id}/transactions/${tx.id}/match-candidates`,
    )
    candidates.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load candidates', icon: 'error' })
  } finally {
    candidatesLoading.value = false
  }
}

async function confirmMatch(candidateId: string) {
  if (!matchModal.value) return
  matchingId.value = candidateId
  try {
    await $fetch(
      `/api/bank-accounts/${matchModal.value.bank_account_id}/transactions/${matchModal.value.id}/match`,
      {
        method: 'POST',
        body: { journal_line_id: candidateId },
      },
    )
    showToast({ title: 'Matched' })
    matchModal.value = null
    await loadTransactions()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Match failed', icon: 'error' })
  } finally {
    matchingId.value = null
  }
}

// CSV import: expects header row with at minimum
//   posted_at, amount   (optionally: description, reference, balance)
// Posted_at format: ISO date (YYYY-MM-DD).
// Amount: signed decimal; we convert to centavos.
async function runImport() {
  if (!selectedBankId.value) return
  const lines = csvText.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 2) {
    showToast({ title: 'CSV needs a header row + at least one data row', icon: 'warning' })
    return
  }
  const header = lines[0]!.split(',').map((s) => s.trim().toLowerCase())
  const idx = (col: string) => header.indexOf(col)
  const iPosted = idx('posted_at')
  const iAmount = idx('amount')
  if (iPosted < 0 || iAmount < 0) {
    showToast({
      title: 'CSV header must include posted_at and amount columns',
      icon: 'warning',
    })
    return
  }
  const iDesc = idx('description')
  const iRef = idx('reference')
  const iBalance = idx('balance')

  importing.value = true
  importProgress.value = { ok: 0, failed: 0, total: lines.length - 1 }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((s) => s.trim())
    const postedAt = cols[iPosted]
    const amount = Number(cols[iAmount])
    if (!postedAt || Number.isNaN(amount)) {
      importProgress.value.failed += 1
      continue
    }
    try {
      await $fetch(`/api/bank-accounts/${selectedBankId.value}/transactions`, {
        method: 'POST',
        body: {
          posted_at: postedAt,
          description: iDesc >= 0 ? cols[iDesc] || null : null,
          reference: iRef >= 0 ? cols[iRef] || null : null,
          amount_minor: Math.round(amount * 100),
          balance_minor: iBalance >= 0 && cols[iBalance]
            ? Math.round(Number(cols[iBalance]) * 100)
            : null,
          source: 'csv_import',
        },
      })
      importProgress.value.ok += 1
    } catch {
      importProgress.value.failed += 1
    }
  }

  importing.value = false
  showToast({
    title: `Imported ${importProgress.value.ok} of ${importProgress.value.total}` +
      (importProgress.value.failed > 0 ? ` (${importProgress.value.failed} failed)` : ''),
  })
  csvText.value = ''
  await loadTransactions()
}

const counts = computed(() => {
  const c = { all: transactions.value.length, unmatched: 0, matched: 0, manual: 0, ignored: 0 }
  for (const t of transactions.value) c[t.status] = (c[t.status] ?? 0) + 1
  return c
})

const totals = computed(() => {
  let inflow = 0
  let outflow = 0
  let unmatchedAbs = 0
  for (const t of transactions.value) {
    if (t.amount_minor > 0) inflow += t.amount_minor
    else outflow += Math.abs(t.amount_minor)
    if (t.status === 'unmatched') unmatchedAbs += Math.abs(t.amount_minor)
  }
  return { inflow, outflow, unmatchedAbs }
})

function formatPHP(minor: number, currency = 'PHP') {
  return (minor / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })
}

function statusClass(s: TxStatus) {
  if (s === 'matched') return 'bg-success/15 text-success'
  if (s === 'manual') return 'bg-primary/15 text-primary'
  if (s === 'ignored') return 'bg-muted text-muted-foreground'
  return 'bg-warning/15 text-warning'
}

onMounted(async () => {
  const ok =
    (await hasPermission('accounting.manage')) || (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await loadBankAccounts()
  if (selectedBankId.value) await loadTransactions()
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
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-page-title">
            Bank Reconciliation
          </h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Match imported bank statement lines to journal entries on the bank's GL account.
          </p>
        </div>
        <button
          type="button"
          class="inline-flex items-center rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
          @click="showImport = !showImport"
        >
          {{ showImport ? 'Hide import' : 'Import CSV' }}
        </button>
      </header>

      <!-- Bank picker + filters -->
      <div class="flex flex-wrap items-end gap-3">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Bank account</span>
          <select
            v-model="selectedBankId"
            class="mt-1 block w-80 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
          >
            <option v-if="bankAccounts.length === 0" :value="null">
              No bank accounts — add one first
            </option>
            <option v-for="b in bankAccounts" :key="b.id" :value="b.id">
              {{ b.bank_name }} · {{ b.account_number }} ({{ b.currency }})
            </option>
          </select>
        </label>
        <div class="inline-flex rounded-lg border border-border p-1">
          <button
            v-for="opt in (['unmatched', 'matched', 'manual', 'ignored', 'all'] as const)"
            :key="opt"
            type="button"
            :class="[
              'inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md transition',
              statusFilter === opt
                ? 'bg-primary text-white'
                : 'text-foreground hover:text-foreground/80',
            ]"
            @click="statusFilter = opt"
          >
            <span class="capitalize">{{ opt }}</span>
            <span
              :class="[
                'rounded-full px-1.5 text-[10px] font-semibold',
                statusFilter === opt
                  ? 'bg-white/20 text-white'
                  : 'bg-muted text-muted-foreground',
              ]"
            >{{ counts[opt] }}</span>
          </button>
        </div>
      </div>

      <!-- Totals -->
      <div v-if="selectedBank" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-lg border border-success/30 bg-success/10 p-4 ">
          <p class="text-xs font-medium text-success ">Inflows (current view)</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-success">
            {{ formatPHP(totals.inflow, selectedBank.currency) }}
          </p>
        </div>
        <div class="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p class="text-xs font-medium text-destructive ">Outflows (current view)</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-destructive">
            {{ formatPHP(totals.outflow, selectedBank.currency) }}
          </p>
        </div>
        <div class="rounded-lg border border-warning/30 bg-warning/10 p-4">
          <p class="text-xs font-medium text-warning">Unmatched amount</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-warning">
            {{ formatPHP(totals.unmatchedAbs, selectedBank.currency) }}
          </p>
        </div>
      </div>

      <!-- Bank â†” GL drift card -->
      <div
        v-if="selectedBank && (latestBankBalance !== null || glBalance !== null)"
        :class="[
          'rounded-lg border p-4',
          driftMinor === null
            ? 'border-border bg-muted/40'
            : driftMinor === 0
              ? 'border-success/30 bg-success/10'
              : 'border-destructive/30 bg-destructive/10  ',
        ]"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-wide opacity-80">
              Bank â†” GL drift
            </p>
            <p
              v-if="driftMinor === null"
              class="mt-1 text-sm text-muted-foreground"
            >
              Need both bank statement balance and GL balance to compute drift.
            </p>
            <p
              v-else-if="driftMinor === 0"
              class="mt-1 text-lg font-semibold text-success"
            >
              In sync — {{ formatPHP(latestBankBalance!, selectedBank.currency) }}
            </p>
            <p
              v-else
              class="mt-1 text-lg font-semibold text-destructive"
            >
              Out of sync by {{ formatPHP(Math.abs(driftMinor), selectedBank.currency) }}
              <span class="text-xs font-normal text-destructive">
                · bank says {{ formatPHP(latestBankBalance!, selectedBank.currency) }},
                GL says {{ formatPHP(glBalance!, selectedBank.currency) }}
              </span>
            </p>
          </div>
          <div
            v-if="driftMinor !== null && driftMinor !== 0"
            class="text-xs text-destructive"
          >
            Reconcile unmatched txns above to close the gap.
          </div>
        </div>
      </div>

      <!-- CSV import (collapsible) -->
      <section
        v-if="showImport && selectedBankId"
        class="rounded-lg border border-primary/30 bg-primary/10 p-5 "
      >
        <h2 class="text-base font-semibold text-primary ">
          Import CSV
        </h2>
        <p class="mt-1 text-xs text-primary">
          Paste a CSV with header row. Required columns:
          <code>posted_at</code>, <code>amount</code>.
          Optional: <code>description</code>, <code>reference</code>, <code>balance</code>.
          Amount is a signed decimal (positive = inflow); converted to centavos automatically.
        </p>
        <textarea
          v-model="csvText"
          rows="6"
          placeholder="posted_at,description,reference,amount,balance&#10;2026-05-01,Salary deposit,REF12345,15000.00,15000.00&#10;2026-05-02,Electric bill,MERALCO,-2350.50,12649.50"
          class="mt-3 block w-full rounded-lg border border-primary/40 bg-background px-3 py-2 font-mono text-xs text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring "
        />
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            :disabled="importing || !csvText.trim()"
            class="inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-60"
            @click="runImport"
          >
            <span v-if="importing">Importing…</span>
            <span v-else>Import to {{ selectedBank?.bank_name }}</span>
          </button>
          <span
            v-if="importProgress"
            class="text-xs text-primary"
          >
            {{ importProgress.ok }} / {{ importProgress.total }} imported
            <template v-if="importProgress.failed > 0">
              · {{ importProgress.failed }} failed
            </template>
          </span>
        </div>
      </section>

      <!-- Transactions table -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div v-if="!selectedBankId" class="p-5 text-center text-sm text-muted-foreground">
          Pick a bank account to start.
        </div>
        <div v-else-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="transactions.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No transactions in this view.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Date</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Description</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Ref</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Amount</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="t in transactions" :key="t.id" class="hover:bg-accent hover:text-accent-foreground">
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ new Date(t.posted_at).toLocaleDateString() }}
                </td>
                <td class="px-3 py-2">
                  <p class="text-foreground">{{ t.description || '—' }}</p>
                  <p class="text-[10px] text-muted-foreground/70">
                    {{ t.source }} · {{ new Date(t.created_at).toLocaleDateString() }}
                  </p>
                </td>
                <td class="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {{ t.reference || '—' }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums">
                  <span
                    :class="
                      t.amount_minor > 0
                        ? 'text-success font-medium'
                        : 'text-destructive font-medium'
                    "
                  >
                    {{ formatPHP(t.amount_minor, selectedBank?.currency ?? 'PHP') }}
                  </span>
                </td>
                <td class="px-3 py-2">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(t.status)]">
                    {{ t.status }}
                  </span>
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    v-if="t.status === 'unmatched'"
                    type="button"
                    class="text-xs text-primary hover:underline"
                    @click="openMatch(t)"
                  >
                    Find match
                  </button>
                  <span v-else-if="t.matched_journal_line_id" class="font-mono text-[10px] text-muted-foreground/70">
                    JL {{ t.matched_journal_line_id.slice(0, 8) }}…
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Match drawer -->
      <UiDrawer
        :open="!!matchModal"
        title="Find match"
        width="lg"
        @update:open="(v) => { if (!v) matchModal = null }"
      >
        <template v-if="matchModal">
          <div class="grid grid-cols-3 gap-3 rounded-lg border border-border p-3 text-sm">
            <div>
              <p class="text-xs text-muted-foreground">Bank txn date</p>
              <p>{{ new Date(matchModal.posted_at).toLocaleDateString() }}</p>
            </div>
            <div>
              <p class="text-xs text-muted-foreground">Amount</p>
              <p
                :class="
                  matchModal.amount_minor > 0
                    ? 'text-success font-medium'
                    : 'text-destructive font-medium'
                "
              >
                {{ formatPHP(matchModal.amount_minor, selectedBank?.currency ?? 'PHP') }}
              </p>
            </div>
            <div class="text-xs text-muted-foreground">
              <p>Description</p>
              <p class="mt-0.5 line-clamp-2 text-foreground">
                {{ matchModal.description || '—' }}
              </p>
            </div>
          </div>

          <h4 class="mt-4 text-card-title">Candidates</h4>
          <p class="mt-1 text-xs text-muted-foreground">
            Posted journal lines on this bank's GL account, same currency, same absolute
            amount, within ±30 days.
          </p>

          <div v-if="candidatesLoading" class="mt-3 py-6 text-center text-sm text-muted-foreground">
            Searching…
          </div>
          <div
            v-else-if="candidates.length === 0"
            class="mt-3 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground "
          >
            No matching journal lines found. Auto-post a property charge or platform fee
            payment first, or create a manual journal entry that records this transaction.
          </div>
          <ul v-else class="mt-3 space-y-2">
            <li
              v-for="c in candidates"
              :key="c.id"
              class="flex items-start justify-between gap-3 rounded-lg border border-border p-3 "
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-xs">{{ c.entry_no }}</span>
                  <span class="text-xs text-muted-foreground">{{ new Date(c.entry_date).toLocaleDateString() }}</span>
                  <span
                    v-if="c.day_distance > 0"
                    class="text-[10px] text-muted-foreground/70"
                  >({{ c.day_distance }}d off)</span>
                </div>
                <p class="text-sm text-foreground">
                  {{ c.entry_description }}
                </p>
                <p v-if="c.description" class="text-xs text-muted-foreground">
                  Line: {{ c.description }}
                </p>
              </div>
              <div class="flex shrink-0 flex-col items-end gap-1">
                <span class="tabular-nums text-sm">
                  {{ formatPHP(c.debit_minor || c.credit_minor, c.currency) }}
                  <span class="ml-1 text-[10px] text-muted-foreground/70">
                    {{ c.debit_minor > 0 ? 'DR' : 'CR' }}
                  </span>
                </span>
                <button
                  type="button"
                  :disabled="matchingId !== null"
                  class="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-success-foreground hover:bg-success/90 disabled:opacity-60 focus-ring"
                  @click="confirmMatch(c.id)"
                >
                  <span v-if="matchingId === c.id">Matching…</span>
                  <span v-else>Match</span>
                </button>
              </div>
            </li>
          </ul>
        </template>
        <template #footer>
          <div class="flex justify-end">
            <button
              type="button"
              class="btn-secondary focus-ring"
              @click="matchModal = null"
            >
              Close
            </button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </div>
</template>
