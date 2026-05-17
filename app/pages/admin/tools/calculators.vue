<script setup lang="ts">
/**
 * /admin/tools/calculators — Philippine real-estate calculators.
 *
 * Tabbed admin tool. One tab per calculator. Each tab posts to the
 * shared dispatcher endpoint and renders the structured result + a
 * breakdown table. Pure advisory — no DB writes.
 *
 * Operators bring this up in client meetings to walk through DST/CGT
 * costs, mortgage payments, ROI projections, and broker take-home
 * after VAT/WHT.
 */

import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Calculators | Admin' })

type Tab =
  | 'dst'
  | 'cgt'
  | 'transfer_tax'
  | 'mortgage'
  | 'amortization'
  | 'roi'
  | 'commission_tax'
  | 'all_in'

type BreakdownRow = { label: string; amount: number }

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const activeTab = ref<Tab>('dst')

// One reactive object per tab — keep input state local to each tool.
const dstForm = reactive({ selling_price: 5_000_000, zonal_or_fair_value: 5_500_000, rate: 0.015 })
const cgtForm = reactive({ selling_price: 5_000_000, zonal_or_fair_value: 5_500_000, rate: 0.06 })
const transferForm = reactive({ selling_price: 5_000_000, rate: 0.0075 })
const mortgageForm = reactive({ principal: 4_000_000, annual_rate: 0.075, term_years: 20 })
const amortForm = reactive({ principal: 4_000_000, annual_rate: 0.075, term_years: 20, max_rows: 24 })
const roiForm = reactive({
  annual_rental_income: 360_000,
  annual_operating_expenses: 90_000,
  property_value: 5_000_000,
})
const commissionForm = reactive({
  commission_amount: 250_000,
  vat_registered: true,
  withholding_applies: true,
})
const allInForm = reactive({
  selling_price: 5_000_000,
  zonal_or_fair_value: 5_500_000,
  commission_rate: 0.05,
  transfer_rate: 0.0075,
  dst_rate: 0.015,
  cgt_rate: 0.06,
})

// Result state — shared bag with the kind so the renderer can branch.
const result = ref<{ kind: Tab; data: any } | null>(null)
const computing = ref(false)

const tabs: Array<{ id: Tab; label: string; description: string }> = [
  { id: 'dst', label: 'DST', description: 'Documentary Stamp Tax (1.5% of higher of selling price or zonal value)' },
  { id: 'cgt', label: 'CGT', description: 'Capital Gains Tax (6%)' },
  { id: 'transfer_tax', label: 'Transfer tax', description: 'LGU transfer tax (typ. 0.5–0.75%)' },
  { id: 'mortgage', label: 'Mortgage', description: 'Monthly principal + interest payment' },
  { id: 'amortization', label: 'Amortization', description: 'First N rows of the schedule' },
  { id: 'roi', label: 'ROI', description: 'Cap rate + gross yield from rental income' },
  { id: 'commission_tax', label: 'Commission tax', description: 'VAT + creditable WHT impact on broker take-home' },
  { id: 'all_in', label: 'All-in', description: 'Full transaction cost: DST + CGT + transfer + commission' },
]

async function compute() {
  computing.value = true
  result.value = null
  let inputs: any
  switch (activeTab.value) {
    case 'dst':
      inputs = { ...dstForm }
      break
    case 'cgt':
      inputs = { ...cgtForm }
      break
    case 'transfer_tax':
      inputs = { ...transferForm }
      break
    case 'mortgage':
      inputs = { ...mortgageForm }
      break
    case 'amortization':
      inputs = { ...amortForm }
      break
    case 'roi':
      inputs = { ...roiForm }
      break
    case 'commission_tax':
      inputs = { ...commissionForm }
      break
    case 'all_in':
      inputs = { ...allInForm }
      break
  }
  try {
    const res = await $fetch<{ kind: Tab; result: any }>('/api/admin/calculators', {
      method: 'POST',
      body: { kind: activeTab.value, inputs },
    })
    result.value = { kind: res.kind, data: res.result }
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Calculation failed', icon: 'error' })
  } finally {
    computing.value = false
  }
}

function fmtPHP(amount: number, signed = false): string {
  const formatted = (amount || 0).toLocaleString('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
  })
  if (signed && amount > 0) return `+${formatted}`
  return formatted
}

const breakdown = computed<BreakdownRow[]>(() => {
  if (!result.value) return []
  const d = result.value.data
  if (Array.isArray(d.breakdown)) return d.breakdown as BreakdownRow[]
  return []
})

onMounted(async () => {
  const ok =
    (await hasPermission('admin.access')) ||
    (await hasPermission('property.manage')) ||
    (await hasPermission('listings.manage'))
  isChecking.value = false
  // Calculators are advisory — broaden access to any auth'd role.
  // requireRole on the endpoint enforces 'agent' or above.
  allowed.value = true
  void ok
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Loading…
    </div>

    <template v-else-if="allowed">
      <header>
        <h1 class="text-page-title">Calculators</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Philippine real-estate cost + financing tools. Default rates match BIR / LGU
          practice as of 2026; override per-transaction when needed. Pure-advisory —
          nothing here writes to the ledger.
        </p>
      </header>

      <!-- Tab strip -->
      <div class="flex flex-wrap gap-1 border-b border-border">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          :class="[
            'rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition',
            activeTab === t.id
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          ]"
          :title="t.description"
          @click="activeTab = t.id; result = null"
        >
          {{ t.label }}
        </button>
      </div>

      <section class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <!-- Inputs -->
        <div class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <h2 class="text-base font-semibold text-foreground">Inputs</h2>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ tabs.find((t) => t.id === activeTab)?.description }}
          </p>

          <!-- DST / CGT (same shape) -->
          <div v-if="activeTab === 'dst' || activeTab === 'cgt'" class="mt-4 space-y-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Selling price (PHP)</span>
              <input
                v-model.number="(activeTab === 'dst' ? dstForm : cgtForm).selling_price"
                type="number"
                min="0"
                step="1000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Zonal / fair-market value (PHP, optional)</span>
              <input
                v-model.number="(activeTab === 'dst' ? dstForm : cgtForm).zonal_or_fair_value"
                type="number"
                min="0"
                step="1000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
              <span class="mt-1 block text-[11px] text-muted-foreground">
                BIR uses the higher of selling price or zonal/fair value as the tax base.
              </span>
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Rate (default {{ activeTab === 'dst' ? '1.5%' : '6%' }})
              </span>
              <input
                v-model.number="(activeTab === 'dst' ? dstForm : cgtForm).rate"
                type="number"
                min="0"
                max="1"
                step="0.001"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
          </div>

          <!-- Transfer tax -->
          <div v-else-if="activeTab === 'transfer_tax'" class="mt-4 space-y-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Selling price (PHP)</span>
              <input
                v-model.number="transferForm.selling_price"
                type="number"
                min="0"
                step="1000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                LGU rate (typical 0.50–0.75%; default 0.75%)
              </span>
              <input
                v-model.number="transferForm.rate"
                type="number"
                min="0"
                max="1"
                step="0.0001"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
          </div>

          <!-- Mortgage / Amortization (similar inputs) -->
          <div v-else-if="activeTab === 'mortgage' || activeTab === 'amortization'" class="mt-4 space-y-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Principal (PHP)</span>
              <input
                v-model.number="(activeTab === 'mortgage' ? mortgageForm : amortForm).principal"
                type="number"
                min="0"
                step="10000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Annual rate (decimal — 0.075 = 7.5%)
              </span>
              <input
                v-model.number="(activeTab === 'mortgage' ? mortgageForm : amortForm).annual_rate"
                type="number"
                min="0"
                max="1"
                step="0.001"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Term (years)</span>
              <input
                v-model.number="(activeTab === 'mortgage' ? mortgageForm : amortForm).term_years"
                type="number"
                min="1"
                max="40"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label v-if="activeTab === 'amortization'" class="block">
              <span class="block text-xs font-medium text-muted-foreground">First N rows of schedule (max 600)</span>
              <input
                v-model.number="amortForm.max_rows"
                type="number"
                min="1"
                max="600"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
          </div>

          <!-- ROI -->
          <div v-else-if="activeTab === 'roi'" class="mt-4 space-y-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Annual rental income (PHP)</span>
              <input
                v-model.number="roiForm.annual_rental_income"
                type="number"
                min="0"
                step="1000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Annual operating expenses (PHP)</span>
              <input
                v-model.number="roiForm.annual_operating_expenses"
                type="number"
                min="0"
                step="1000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
              <span class="mt-1 block text-[11px] text-muted-foreground">
                Management fee + condo dues + maintenance + property tax.
              </span>
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Property value (PHP)</span>
              <input
                v-model.number="roiForm.property_value"
                type="number"
                min="0"
                step="10000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
          </div>

          <!-- Commission tax -->
          <div v-else-if="activeTab === 'commission_tax'" class="mt-4 space-y-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Gross commission (PHP)</span>
              <input
                v-model.number="commissionForm.commission_amount"
                type="number"
                min="0"
                step="1000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="flex items-start gap-2 text-sm text-foreground">
              <input
                v-model="commissionForm.vat_registered"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                VAT-registered broker (output VAT @ 12%; creditable WHT @ 5%)
              </span>
            </label>
            <label class="flex items-start gap-2 text-sm text-foreground">
              <input
                v-model="commissionForm.withholding_applies"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>Client withholds creditable WHT</span>
            </label>
          </div>

          <!-- All-in -->
          <div v-else-if="activeTab === 'all_in'" class="mt-4 space-y-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Selling price (PHP)</span>
              <input
                v-model.number="allInForm.selling_price"
                type="number"
                min="0"
                step="1000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Zonal / fair-market value (PHP)</span>
              <input
                v-model.number="allInForm.zonal_or_fair_value"
                type="number"
                min="0"
                step="1000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Commission rate (default 5%)</span>
                <input
                  v-model.number="allInForm.commission_rate"
                  type="number"
                  min="0"
                  max="1"
                  step="0.001"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Transfer rate (default 0.75%)</span>
                <input
                  v-model.number="allInForm.transfer_rate"
                  type="number"
                  min="0"
                  max="1"
                  step="0.0001"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
            </div>
          </div>

          <button
            type="button"
            :disabled="computing"
            class="mt-5 w-full btn-primary disabled:opacity-60"
            @click="compute"
          >
            <span v-if="computing">Calculating…</span>
            <span v-else>Calculate</span>
          </button>
        </div>

        <!-- Result -->
        <div class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <h2 class="text-base font-semibold text-foreground">Result</h2>
          <p class="mt-0.5 text-xs text-muted-foreground">
            All amounts in PHP. Round to 2 decimals; rates shown to 2–3 decimals.
          </p>

          <div v-if="!result" class="mt-6 text-sm text-muted-foreground">
            Enter inputs and click Calculate.
          </div>

          <!-- Headline metric per kind -->
          <div v-else class="mt-4 space-y-4">
            <div v-if="result.kind === 'dst' || result.kind === 'cgt' || result.kind === 'transfer_tax'">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
                Tax owed
              </div>
              <div class="mt-1 text-3xl font-semibold tabular-nums text-foreground">
                {{ fmtPHP(result.data.tax) }}
              </div>
            </div>
            <div v-else-if="result.kind === 'mortgage'">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
                Monthly payment
              </div>
              <div class="mt-1 text-3xl font-semibold tabular-nums text-foreground">
                {{ fmtPHP(result.data.monthly_payment) }}
              </div>
              <div class="mt-2 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span class="text-muted-foreground">Total paid: </span>
                  <span class="tabular-nums">{{ fmtPHP(result.data.total_paid) }}</span>
                </div>
                <div>
                  <span class="text-muted-foreground">Total interest: </span>
                  <span class="tabular-nums text-warning">{{ fmtPHP(result.data.total_interest) }}</span>
                </div>
              </div>
            </div>
            <div v-else-if="result.kind === 'roi'">
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Cap rate</div>
                  <div class="mt-1 text-2xl font-semibold tabular-nums text-success">
                    {{ result.data.cap_rate_pct.toFixed(2) }}%
                  </div>
                </div>
                <div>
                  <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Gross yield</div>
                  <div class="mt-1 text-2xl font-semibold tabular-nums text-primary">
                    {{ result.data.gross_yield_pct.toFixed(2) }}%
                  </div>
                </div>
              </div>
            </div>
            <div v-else-if="result.kind === 'commission_tax'">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Net received</div>
              <div class="mt-1 text-3xl font-semibold tabular-nums text-success">
                {{ fmtPHP(result.data.net_received) }}
              </div>
            </div>
            <div v-else-if="result.kind === 'all_in'">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Net to seller</div>
              <div
                class="mt-1 text-3xl font-semibold tabular-nums"
                :class="result.data.net_to_seller >= 0 ? 'text-success' : 'text-destructive'"
              >
                {{ fmtPHP(result.data.net_to_seller) }}
              </div>
              <div class="mt-2 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span class="text-muted-foreground">Total taxes: </span>
                  <span class="tabular-nums text-destructive">{{ fmtPHP(result.data.total_taxes) }}</span>
                </div>
                <div>
                  <span class="text-muted-foreground">Commission: </span>
                  <span class="tabular-nums">{{ fmtPHP(result.data.commission) }}</span>
                </div>
              </div>
            </div>

            <!-- Breakdown table -->
            <div v-if="breakdown.length > 0" class="border-t border-border pt-3">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Breakdown</div>
              <table class="mt-2 w-full text-sm">
                <tbody class="divide-y divide-border">
                  <tr v-for="(row, i) in breakdown" :key="i">
                    <td class="py-1.5 text-xs text-foreground">{{ row.label }}</td>
                    <td class="py-1.5 text-right tabular-nums text-foreground">
                      <span v-if="result.kind === 'roi' && (row.label === 'Cap rate' || row.label === 'Gross rental yield')">
                        {{ row.amount.toFixed(2) }}%
                      </span>
                      <span v-else-if="row.amount < 0" class="text-destructive">
                        ({{ fmtPHP(Math.abs(row.amount)) }})
                      </span>
                      <span v-else>
                        {{ fmtPHP(row.amount) }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Amortization schedule -->
            <div v-if="result.kind === 'amortization'" class="border-t border-border pt-3">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
                Schedule ({{ result.data.rows.length }} rows{{ result.data.truncated ? ' — truncated' : '' }})
              </div>
              <div class="mt-2 max-h-96 overflow-auto rounded border border-border">
                <table class="w-full text-xs">
                  <thead class="sticky top-0 bg-muted/40">
                    <tr>
                      <th class="px-2 py-1 text-left font-medium uppercase tracking-wide text-muted-foreground">Mo.</th>
                      <th class="px-2 py-1 text-right font-medium uppercase tracking-wide text-muted-foreground">Payment</th>
                      <th class="px-2 py-1 text-right font-medium uppercase tracking-wide text-muted-foreground">Interest</th>
                      <th class="px-2 py-1 text-right font-medium uppercase tracking-wide text-muted-foreground">Principal</th>
                      <th class="px-2 py-1 text-right font-medium uppercase tracking-wide text-muted-foreground">Balance</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-border">
                    <tr v-for="row in result.data.rows" :key="row.month">
                      <td class="px-2 py-1 tabular-nums">{{ row.month }}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{{ fmtPHP(row.payment) }}</td>
                      <td class="px-2 py-1 text-right tabular-nums text-warning">{{ fmtPHP(row.interest) }}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{{ fmtPHP(row.principal) }}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{{ fmtPHP(row.balance) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
