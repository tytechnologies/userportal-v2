<script setup lang="ts">
/**
 * /admin/accounting — books overview.
 *
 * Read-mostly view of the platform's books:
 *   - Trial balance (one row per account)
 *   - Recent posted journal entries (limit 50)
 *
 * Journal entry creation lives in a future modal; today operators use
 * the auto-post helpers (auto_post_property_charge, auto_post_platform_fee)
 * or POST directly via the API. The "+ Manual entry" link surfaces a
 * placeholder pointing at the API path.
 */

import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'
import UiDrawer from '~/components/ui/UiDrawer.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Accounting | Admin' })

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

type TrialRow = {
  code: string
  name: string
  account_type: AccountType
  currency: string
  debit_balance_minor: number
  credit_balance_minor: number
}

type JournalEntry = {
  id: string
  entry_no: string
  entry_date: string
  description: string
  reference_kind: string
  reference_id: string | null
  currency: string
  status: 'draft' | 'posted' | 'void'
  posted_at: string | null
  reverses_entry_id: string | null
  created_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const trial = ref<TrialRow[]>([])
const trialLoading = ref(false)

const entries = ref<JournalEntry[]>([])
const entriesLoading = ref(false)
const entriesStatusFilter = ref<'posted' | 'draft' | 'void' | 'all'>('posted')

// Reverse-entry modal
const reverseModal = ref<JournalEntry | null>(null)
const reverseForm = reactive({ reversal_date: new Date().toISOString().slice(0, 10) })
const reversing = ref(false)

async function reverse() {
  if (!reverseModal.value) return
  reversing.value = true
  try {
    const res = await $fetch<{ reversal_entry_id: string }>(
      `/api/journal-entries/${reverseModal.value.id}/reverse`,
      {
        method: 'POST',
        body: { reversal_date: reverseForm.reversal_date },
      },
    )
    showToast({ title: 'Reversal entry created (draft)' })
    reverseModal.value = null
    await loadEntries()
    if (res?.reversal_entry_id) {
      // Surface the new draft so operator can post it via the existing flow.
      router.push('/admin/accounting')
    }
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Reversal failed', icon: 'error' })
  } finally {
    reversing.value = false
  }
}

const typeFilter = ref<AccountType | 'all'>('all')

async function loadTrialBalance() {
  trialLoading.value = true
  try {
    const res = await $fetch<{ items: TrialRow[] }>('/api/admin/accounting/trial-balance')
    trial.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load trial balance', icon: 'error' })
  } finally {
    trialLoading.value = false
  }
}

async function loadEntries() {
  entriesLoading.value = true
  try {
    const params: Record<string, string> = {}
    if (entriesStatusFilter.value !== 'all') params.status = entriesStatusFilter.value
    const res = await $fetch<{ items: JournalEntry[] }>('/api/journal-entries', {
      query: params,
    })
    entries.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load entries', icon: 'error' })
  } finally {
    entriesLoading.value = false
  }
}

const filteredTrial = computed(() => {
  if (typeFilter.value === 'all') return trial.value
  return trial.value.filter((r) => r.account_type === typeFilter.value)
})

const totals = computed(() => {
  let totalDebit = 0
  let totalCredit = 0
  for (const r of trial.value) {
    totalDebit += Number(r.debit_balance_minor) || 0
    totalCredit += Number(r.credit_balance_minor) || 0
  }
  return { totalDebit, totalCredit, balanced: totalDebit === totalCredit }
})

const balancedClass = computed(() =>
  totals.value.balanced
    ? 'border-success/30 bg-success/10 text-success'
    : 'border-destructive/30 bg-destructive/10 text-destructive',
)

function typeClass(t: AccountType) {
  switch (t) {
    case 'asset':
      return 'bg-primary/15 text-primary'
    case 'liability':
      return 'bg-warning/15 text-warning'
    case 'equity':
      return 'bg-primary/15 text-primary'
    case 'revenue':
      return 'bg-success/15 text-success'
    case 'expense':
      return 'bg-destructive/15 text-destructive'
  }
}

function entryStatusClass(s: 'draft' | 'posted' | 'void') {
  if (s === 'posted')
    return 'bg-success/15 text-success'
  if (s === 'draft')
    return 'bg-warning/15 text-warning'
  return 'bg-muted text-muted-foreground'
}

function formatPHP(minor: number) {
  return (Number(minor) / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
  })
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
  await Promise.all([loadTrialBalance(), loadEntries()])
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
            Accounting
          </h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Trial balance and recent journal activity. Posted entries are append-only;
            corrections via reversal.
          </p>
        </div>
        <NuxtLink
          to="/admin/journal-entry-new"
          class="inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 focus-ring"
        >
          + New journal entry
        </NuxtLink>
      </header>

      <!-- Balanced indicator -->
      <div
        :class="['rounded-lg border p-4 text-sm', balancedClass]"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="font-semibold">
              Books are
              <template v-if="totals.balanced">balanced</template>
              <template v-else>OUT OF BALANCE</template>
            </p>
            <p class="mt-0.5 text-xs opacity-80">
              Total debits = {{ formatPHP(totals.totalDebit) }} · Total credits =
              {{ formatPHP(totals.totalCredit) }}
              <template v-if="!totals.balanced">
                · Difference = {{ formatPHP(Math.abs(totals.totalDebit - totals.totalCredit)) }}
              </template>
            </p>
          </div>
          <div class="text-xs opacity-70">
            {{ trial.length }} accounts · {{ entries.length }} entries shown
          </div>
        </div>
      </div>

      <!-- Trial balance -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <h2 class="text-base font-semibold text-foreground">
            Trial balance
          </h2>
          <div class="ml-2 inline-flex rounded-lg border border-border p-1">
            <button
              v-for="opt in (['all', 'asset', 'liability', 'equity', 'revenue', 'expense'] as const)"
              :key="opt"
              type="button"
              :class="[
                'px-3 py-1 text-xs font-medium rounded-md transition capitalize',
                typeFilter === opt
                  ? 'bg-primary text-white'
                  : 'text-foreground hover:text-foreground/80',
              ]"
              @click="typeFilter = opt"
            >
              {{ opt }}
            </button>
          </div>
          <button
            type="button"
            class="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
            @click="loadTrialBalance"
          >
            Refresh
          </button>
        </div>
        <div v-if="trialLoading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="filteredTrial.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No accounts in this view.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Code</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Account</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Debit</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Credit</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="r in filteredTrial" :key="r.code" class="hover:bg-accent hover:text-accent-foreground">
                <td class="px-3 py-2 font-mono text-xs text-foreground">
                  {{ r.code }}
                </td>
                <td class="px-3 py-2 text-foreground">{{ r.name }}</td>
                <td class="px-3 py-2">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', typeClass(r.account_type)]">
                    {{ r.account_type }}
                  </span>
                </td>
                <td class="px-3 py-2 text-right tabular-nums">
                  <span v-if="Number(r.debit_balance_minor) > 0" class="text-foreground">
                    {{ formatPHP(r.debit_balance_minor) }}
                  </span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </td>
                <td class="px-3 py-2 text-right tabular-nums">
                  <span v-if="Number(r.credit_balance_minor) > 0" class="text-foreground">
                    {{ formatPHP(r.credit_balance_minor) }}
                  </span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </td>
              </tr>
            </tbody>
            <tfoot class="bg-muted/40 font-semibold">
              <tr>
                <td colspan="3" class="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Totals
                </td>
                <td class="px-3 py-2 text-right tabular-nums text-foreground">
                  {{ formatPHP(totals.totalDebit) }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums text-foreground">
                  {{ formatPHP(totals.totalCredit) }}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <!-- Recent journal entries -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <h2 class="text-base font-semibold text-foreground">
            Recent journal entries
          </h2>
          <div class="ml-2 inline-flex rounded-lg border border-border p-1">
            <button
              v-for="opt in (['posted', 'draft', 'void', 'all'] as const)"
              :key="opt"
              type="button"
              :class="[
                'px-3 py-1 text-xs font-medium rounded-md transition capitalize',
                entriesStatusFilter === opt
                  ? 'bg-primary text-white'
                  : 'text-foreground hover:text-foreground/80',
              ]"
              @click="entriesStatusFilter = opt; loadEntries()"
            >
              {{ opt }}
            </button>
          </div>
        </div>
        <div v-if="entriesLoading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="entries.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No journal entries in this view. Auto-post helpers create entries as
          property-charge / platform-fee payments settle.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Entry #</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Date</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Description</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Reference</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="e in entries" :key="e.id" class="hover:bg-accent hover:text-accent-foreground">
                <td class="px-3 py-2 font-mono text-xs">
                  {{ e.entry_no }}
                  <span
                    v-if="e.reverses_entry_id"
                    class="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                  >REV</span>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ new Date(e.entry_date).toLocaleDateString() }}
                </td>
                <td class="px-3 py-2 text-foreground">{{ e.description }}</td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <span class="capitalize">{{ e.reference_kind.replace('_', ' ') }}</span>
                  <span v-if="e.reference_id" class="ml-1 font-mono text-muted-foreground/70">
                    {{ e.reference_id.slice(0, 8) }}…
                  </span>
                </td>
                <td class="px-3 py-2">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', entryStatusClass(e.status)]">
                    {{ e.status }}
                  </span>
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    v-if="e.status === 'posted'"
                    type="button"
                    class="text-xs text-warning hover:underline"
                    @click="reverseModal = e; reverseForm.reversal_date = new Date().toISOString().slice(0, 10)"
                  >
                    Reverse
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Footer note about auto-posting -->
      <div class="rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground ">
        Most entries auto-generate via
        <code>auto_post_property_charge</code> and <code>auto_post_platform_fee</code> when
        their source charges flip to <code>paid</code>. Manual entries via
        <strong>+ New journal entry</strong>; corrections via <strong>Reverse</strong>.
      </div>

      <!-- Reverse entry drawer -->
      <UiDrawer
        :open="!!reverseModal"
        title="Reverse entry"
        width="md"
        @update:open="(v) => { if (!v) reverseModal = null }"
      >
        <template v-if="reverseModal">
          <p class="font-mono text-xs text-muted-foreground">{{ reverseModal.entry_no }}</p>
          <p class="mt-2 text-body">
            Creates a new draft entry with debits and credits swapped, linked to the
            original via <code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">reverses_entry_id</code>.
            The original stays posted.
          </p>
          <p class="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            The reversal entry is created as <strong>draft</strong>. You'll need to post
            it from the entries table for the books to actually back out.
          </p>
          <label class="mt-4 block">
            <span class="block text-xs font-medium text-muted-foreground">Reversal date</span>
            <input
              v-model="reverseForm.reversal_date"
              type="date"
              required
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25 shadow-sm focus:border-warning focus:ring-1 focus:ring-warning"
            />
          </label>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary focus-ring"
              @click="reverseModal = null"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="reversing"
              class="rounded-lg bg-warning px-3 py-2 text-sm font-semibold text-warning-foreground hover:bg-warning/90 disabled:opacity-60 focus-ring"
              @click="reverse"
            >
              <span v-if="reversing">Creating…</span>
              <span v-else>Create reversal</span>
            </button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </div>
</template>
