<script setup lang="ts">
/**
 * /admin/bir-2306 — BIR Form 2306 (Final Tax Withheld at Source).
 *
 * Sister to 2307. Difference: 2307 covers *creditable* withholding
 * (vendor uses it to offset their income tax), 2306 covers *final*
 * withholding (already settled). Vendors must have
 * final_withholding_rate_bps + final_withholding_atc_code set.
 *
 * Same period-picker → preview → save → CSV pattern.
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'BIR Form 2306 | Admin' })

type Form2306Row = {
  vendor_id: string
  vendor_name: string
  vendor_tin: string
  vendor_email: string
  atc_code: string
  rate_pct: number
  gross_income_paid: number
  tax_withheld: number
}

type Run = {
  id: string
  period_start: string
  period_end: string
  totals: { gross_income_paid: number; final_tax_withheld: number; row_count: number }
  generated_at: string
  notes: string | null
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const today = new Date()
const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1)
const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86_400_000)
const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1)

const periodStart = ref(firstOfPrevMonth.toISOString().slice(0, 10))
const periodEnd = ref(lastOfPrevMonth.toISOString().slice(0, 10))
const notes = ref('')

const previewing = ref(false)
const saving = ref(false)
const previewRows = ref<Form2306Row[]>([])
const previewTotals = ref<{
  gross_income_paid: number
  final_tax_withheld: number
  row_count: number
} | null>(null)

const runs = ref<Run[]>([])
const runsLoading = ref(true)

async function loadRuns() {
  runsLoading.value = true
  try {
    const res = await $fetch<{ items: Run[] }>('/api/admin/bir-2306/runs')
    runs.value = res.items
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load runs', icon: 'error' })
  } finally {
    runsLoading.value = false
  }
}

async function preview() {
  previewing.value = true
  try {
    const res = await $fetch<{ rows: Form2306Row[]; totals: any }>(
      '/api/admin/bir-2306/generate',
      {
        method: 'POST',
        body: {
          period_start: periodStart.value,
          period_end: periodEnd.value,
          save: false,
          notes: notes.value || null,
        },
      },
    )
    previewRows.value = res.rows ?? []
    previewTotals.value = res.totals
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Preview failed', icon: 'error' })
  } finally {
    previewing.value = false
  }
}

async function saveRun() {
  if (!previewTotals.value) {
    showToast({ title: 'Preview first to confirm rows', icon: 'warning' })
    return
  }
  saving.value = true
  try {
    await $fetch('/api/admin/bir-2306/generate', {
      method: 'POST',
      body: {
        period_start: periodStart.value,
        period_end: periodEnd.value,
        save: true,
        notes: notes.value || null,
      },
    })
    showToast({ title: 'Form 2306 run saved' })
    await loadRuns()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Save failed', icon: 'error' })
  } finally {
    saving.value = false
  }
}

function downloadCsv(runId: string) {
  window.location.href = `/api/admin/bir-2306/${runId}?format=csv`
}

function fmtPHP(n: number): string {
  return `₱ ${(n ?? 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

const dayCount = computed(() => {
  const a = new Date(periodStart.value).getTime()
  const b = new Date(periodEnd.value).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0
  return Math.round((b - a) / 86_400_000) + 1
})

onMounted(async () => {
  const ok = await hasPermission('admin.access')
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await loadRuns()
})
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <header>
        <h1 class="text-page-title">
          BIR Form 2306 — Final Tax Withheld
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Aggregates final-withholding tax per (vendor × ATC × period).
          Final-withholding settles the vendor's tax obligation in full
          (unlike 2307, which is creditable against income tax due).
        </p>
      </header>

      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Period start</span>
            <input
              v-model="periodStart"
              type="date"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Period end</span>
            <input
              v-model="periodEnd"
              type="date"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Notes (optional)</span>
            <input
              v-model="notes"
              type="text"
              maxlength="500"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <p class="mt-3 text-xs text-muted-foreground">
          Window: <strong>{{ dayCount }} day<span v-if="dayCount !== 1">s</span></strong>.
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            :disabled="previewing || dayCount === 0"
            class="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            @click="preview"
          >
            <span v-if="previewing">Loading…</span>
            <span v-else>Preview</span>
          </button>
          <button
            type="button"
            :disabled="saving || !previewTotals || previewTotals.row_count === 0"
            class="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-60"
            @click="saveRun"
          >
            <span v-if="saving">Saving…</span>
            <span v-else>Save run</span>
          </button>
        </div>
      </section>

      <section
        v-if="previewTotals"
        class="rounded-lg border border-border bg-card p-5 text-card-foreground"
      >
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Gross income paid</div>
            <div class="mt-1 text-xl font-semibold tabular-nums">{{ fmtPHP(previewTotals.gross_income_paid) }}</div>
          </div>
          <div>
            <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Final tax withheld</div>
            <div class="mt-1 text-xl font-semibold tabular-nums text-primary">
              {{ fmtPHP(previewTotals.final_tax_withheld) }}
            </div>
          </div>
          <div>
            <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Vendor rows</div>
            <div class="mt-1 text-xl font-semibold tabular-nums">{{ previewTotals.row_count }}</div>
          </div>
        </div>

        <div v-if="previewRows.length > 0" class="mt-4 overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Vendor</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">TIN</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">ATC</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Rate</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Gross paid</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Final WH</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="(r, idx) in previewRows" :key="idx">
                <td class="px-3 py-2 font-medium">{{ r.vendor_name }}</td>
                <td class="px-3 py-2 font-mono text-xs">{{ r.vendor_tin || '—' }}</td>
                <td class="px-3 py-2 font-mono text-xs">{{ r.atc_code }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ Number(r.rate_pct).toFixed(2) }}%</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ fmtPHP(r.gross_income_paid) }}</td>
                <td class="px-3 py-2 text-right tabular-nums text-primary">
                  {{ fmtPHP(r.tax_withheld) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="mt-4 text-sm text-muted-foreground">
          No vendor rows in this period. (Vendors without a final-withholding rate are excluded.)
        </div>
      </section>

      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-base font-semibold text-foreground">Saved runs</h2>
          <button
            type="button"
            class="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            @click="loadRuns"
          >
            Refresh
          </button>
        </div>

        <div v-if="runsLoading" class="text-sm text-muted-foreground">Loading…</div>
        <div v-else-if="runs.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">No saved runs yet.</div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Period</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Vendors</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Final WH</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Generated</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="r in runs" :key="r.id">
                <td class="px-3 py-2 text-xs">{{ r.period_start }} → {{ r.period_end }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ r.totals?.row_count ?? 0 }}</td>
                <td class="px-3 py-2 text-right tabular-nums text-primary">
                  {{ fmtPHP(r.totals?.final_tax_withheld ?? 0) }}
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ new Date(r.generated_at).toLocaleString() }}
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">
                  {{ r.notes || '' }}
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    type="button"
                    class="text-xs text-primary hover:underline"
                    @click="downloadCsv(r.id)"
                  >
                    â†“ CSV
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
