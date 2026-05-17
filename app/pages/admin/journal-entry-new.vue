<script setup lang="ts">
/**
 * /admin/journal-entry-new — manual journal entry form.
 *
 * Operator-driven journal-entry creation. The page-level workflow:
 *   1. Pick entry date + description
 *   2. Add â‰¥ 2 lines (debit / credit per line) with account picker
 *   3. Live-validate: sum(debits) === sum(credits), exactly one of
 *      debit/credit > 0 per line
 *   4. Submit → POST /api/journal-entries (creates as draft)
 *   5. If "Post immediately" checked, also call POST /api/journal-entries/:id/post
 *
 * After post the entry is append-only — corrections via reversal.
 */

import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'New Journal Entry | Admin' })

type Account = {
  id: string
  code: string
  name: string
  account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  currency: string
  is_active: boolean
}

type LineForm = {
  account_id: string
  debit_minor: number
  credit_minor: number
  description: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const accounts = ref<Account[]>([])

const form = reactive({
  entry_date: new Date().toISOString().slice(0, 10),
  description: '',
  reference_kind: 'manual' as string,
  reference_id: '' as string,
  currency: 'PHP',
  post_immediately: true,
})

const lines = ref<LineForm[]>([
  { account_id: '', debit_minor: 0, credit_minor: 0, description: '' },
  { account_id: '', debit_minor: 0, credit_minor: 0, description: '' },
])

const submitting = ref(false)

async function loadAccounts() {
  try {
    const res = await $fetch<{ items: Account[] }>('/api/accounts', {
      query: { active: '1' },
    })
    accounts.value = (res.items ?? []).filter((a) => a.is_active)
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load accounts', icon: 'error' })
  }
}

function addLine() {
  lines.value.push({ account_id: '', debit_minor: 0, credit_minor: 0, description: '' })
}

function removeLine(idx: number) {
  if (lines.value.length <= 2) {
    showToast({ title: 'Need at least 2 lines per entry', icon: 'warning' })
    return
  }
  lines.value.splice(idx, 1)
}

const totals = computed(() => {
  let debit = 0
  let credit = 0
  for (const l of lines.value) {
    debit += Number(l.debit_minor) || 0
    credit += Number(l.credit_minor) || 0
  }
  return { debit, credit, balanced: debit === credit, hasMoney: debit > 0 || credit > 0 }
})

const validation = computed(() => {
  const issues: string[] = []
  if (!form.description.trim()) issues.push('Description is required.')
  if (!form.entry_date) issues.push('Entry date is required.')
  if (lines.value.length < 2) issues.push('At least 2 lines required.')
  for (let i = 0; i < lines.value.length; i++) {
    const l = lines.value[i]!
    if (!l.account_id) issues.push(`Line ${i + 1}: pick an account.`)
    const d = Number(l.debit_minor) || 0
    const c = Number(l.credit_minor) || 0
    if (d > 0 && c > 0) issues.push(`Line ${i + 1}: enter debit OR credit, not both.`)
    if (d === 0 && c === 0) issues.push(`Line ${i + 1}: amount required.`)
  }
  if (totals.value.hasMoney && !totals.value.balanced) {
    issues.push(
      `Out of balance — debits ${formatPHP(totals.value.debit)} â‰  credits ${formatPHP(totals.value.credit)}.`,
    )
  }
  return issues
})

const canSubmit = computed(() => validation.value.length === 0 && !submitting.value)

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const created = await $fetch<{
      entry: { id: string; entry_no: string; status: string }
      lines_inserted: number
    }>('/api/journal-entries', {
      method: 'POST',
      body: {
        entry_date: form.entry_date,
        description: form.description.trim(),
        reference_kind: form.reference_kind,
        reference_id: form.reference_id.trim() || null,
        currency: form.currency,
        lines: lines.value.map((l) => ({
          account_id: l.account_id,
          debit_minor: Number(l.debit_minor) || 0,
          credit_minor: Number(l.credit_minor) || 0,
          description: l.description.trim() || null,
        })),
      },
    })

    if (form.post_immediately) {
      try {
        await $fetch(`/api/journal-entries/${created.entry.id}/post`, {
          method: 'POST',
        })
        showToast({ title: `Posted ${created.entry.entry_no}` })
      } catch (postErr: any) {
        showToast({
          title: `Created as draft (${created.entry.entry_no}) — post failed: ${postErr?.statusMessage}`,
          icon: 'warning',
        })
      }
    } else {
      showToast({ title: `Draft created: ${created.entry.entry_no}` })
    }

    router.push('/admin/accounting')
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not create entry', icon: 'error' })
  } finally {
    submitting.value = false
  }
}

function formatPHP(minor: number) {
  return (Number(minor) / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency: form.currency || 'PHP',
    minimumFractionDigits: 2,
  })
}

const accountById = computed(() => {
  const m: Record<string, Account> = {}
  for (const a of accounts.value) m[a.id] = a
  return m
})

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
  await loadAccounts()
})
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <NuxtLink
        to="/admin/accounting"
        class="text-sm text-primary hover:underline"
      >
        ← Back to Accounting
      </NuxtLink>

      <header>
        <h1 class="text-page-title">
          New Journal Entry
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Create a manual journal entry. Posted entries are append-only — corrections
          require reversal.
        </p>
      </header>

      <!-- Header form -->
      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Entry date</span>
            <input
              v-model="form.entry_date"
              type="date"
              required
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Reference kind</span>
            <select
              v-model="form.reference_kind"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            >
              <option value="manual">manual</option>
              <option value="opening_balance">opening_balance</option>
              <option value="reconciliation">reconciliation</option>
              <option value="invoice">invoice</option>
              <option value="property_charge">property_charge</option>
              <option value="platform_fee">platform_fee</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Reference id (optional)</span>
            <input
              v-model="form.reference_id"
              type="text"
              maxlength="120"
              placeholder="e.g., INV-2026-001234"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <label class="mt-3 block">
          <span class="block text-xs font-medium text-muted-foreground">Description</span>
          <input
            v-model="form.description"
            type="text"
            required
            maxlength="500"
            placeholder="e.g., Q2 owner disbursement adjustment"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
      </section>

      <!-- Lines -->
      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-base font-semibold text-foreground">
            Lines
          </h2>
          <button
            type="button"
            class="text-xs text-primary hover:underline"
            @click="addLine"
          >
            + Add line
          </button>
        </div>

        <div class="space-y-2">
          <div
            v-for="(line, idx) in lines"
            :key="idx"
            class="grid grid-cols-12 gap-2 rounded-lg border border-border p-2"
          >
            <select
              v-model="line.account_id"
              required
              class="col-span-5 rounded-md border border-border bg-background px-2 py-1.5 text-xs shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
            >
              <option value="">— Pick account —</option>
              <optgroup label="Assets">
                <option
                  v-for="a in accounts.filter((x) => x.account_type === 'asset')"
                  :key="a.id"
                  :value="a.id"
                >{{ a.code }} · {{ a.name }}</option>
              </optgroup>
              <optgroup label="Liabilities">
                <option
                  v-for="a in accounts.filter((x) => x.account_type === 'liability')"
                  :key="a.id"
                  :value="a.id"
                >{{ a.code }} · {{ a.name }}</option>
              </optgroup>
              <optgroup label="Equity">
                <option
                  v-for="a in accounts.filter((x) => x.account_type === 'equity')"
                  :key="a.id"
                  :value="a.id"
                >{{ a.code }} · {{ a.name }}</option>
              </optgroup>
              <optgroup label="Revenue">
                <option
                  v-for="a in accounts.filter((x) => x.account_type === 'revenue')"
                  :key="a.id"
                  :value="a.id"
                >{{ a.code }} · {{ a.name }}</option>
              </optgroup>
              <optgroup label="Expense">
                <option
                  v-for="a in accounts.filter((x) => x.account_type === 'expense')"
                  :key="a.id"
                  :value="a.id"
                >{{ a.code }} · {{ a.name }}</option>
              </optgroup>
            </select>
            <input
              v-model.number="line.debit_minor"
              type="number"
              min="0"
              step="100"
              placeholder="Debit"
              class="col-span-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-right tabular-nums shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
            />
            <input
              v-model.number="line.credit_minor"
              type="number"
              min="0"
              step="100"
              placeholder="Credit"
              class="col-span-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-right tabular-nums shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
            />
            <input
              v-model="line.description"
              type="text"
              maxlength="200"
              placeholder="Line description"
              class="col-span-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              class="col-span-1 text-xs text-destructive hover:underline disabled:opacity-30"
              :disabled="lines.length <= 2"
              @click="removeLine(idx)"
            >
              ✕
            </button>
          </div>
        </div>

        <!-- Totals row -->
        <div
          :class="[
            'mt-3 grid grid-cols-12 gap-2 rounded-lg border-2 border-dashed p-2 text-sm font-semibold',
            totals.balanced && totals.hasMoney
              ? 'border-success/40 bg-success/10 '
              : 'border-border bg-muted/40  ',
          ]"
        >
          <span class="col-span-5 text-muted-foreground">Totals</span>
          <span class="col-span-2 text-right tabular-nums">{{ formatPHP(totals.debit) }}</span>
          <span class="col-span-2 text-right tabular-nums">{{ formatPHP(totals.credit) }}</span>
          <span class="col-span-3 text-right">
            <span v-if="totals.balanced && totals.hasMoney" class="text-success">
              ✓ Balanced
            </span>
            <span v-else-if="totals.hasMoney" class="text-destructive">
              Diff: {{ formatPHP(Math.abs(totals.debit - totals.credit)) }}
            </span>
            <span v-else class="text-muted-foreground/70">—</span>
          </span>
        </div>
      </section>

      <!-- Validation surface -->
      <div
        v-if="validation.length > 0"
        class="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning "
      >
        <p class="font-semibold">Fix before submit:</p>
        <ul class="mt-1 list-disc pl-5 space-y-0.5 text-xs">
          <li v-for="(v, i) in validation" :key="i">{{ v }}</li>
        </ul>
      </div>

      <!-- Submit bar -->
      <div class="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-card px-4 py-3 sm:-mx-6 lg:-mx-8">
        <label class="mr-auto flex items-center gap-2 text-sm text-foreground">
          <input
            v-model="form.post_immediately"
            type="checkbox"
            class="h-4 w-4 rounded border-border"
          />
          Post immediately (otherwise stays draft)
        </label>
        <NuxtLink
          to="/admin/accounting"
          class="btn-secondary"
        >
          Cancel
        </NuxtLink>
        <button
          type="button"
          :disabled="!canSubmit"
          class="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          @click="submit"
        >
          <span v-if="submitting">Submitting…</span>
          <span v-else-if="form.post_immediately">Create + post</span>
          <span v-else>Create draft</span>
        </button>
      </div>
    </template>
  </div>
</template>
