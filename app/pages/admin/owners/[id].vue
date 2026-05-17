<script setup lang="ts">
/**
 * /admin/owners/:id — owner detail page.
 *
 * Closes the symmetry gap with the lease detail page. Surfaces:
 *   - Identity card (name, email, TIN, portal binding state)
 *   - Active units owned (read-only summary; ownership editing
 *     stays on the unit detail page)
 *   - Recent owner statements with status badge + PDF download
 *
 * Schedule policy editing + portal invitations stay on the owners
 * list page for now — this page is read-mostly.
 */

import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Owner | Admin' })

type Owner = {
  id: string
  user_id: string | null
  contact_id: number | null
  external_name: string | null
  external_email: string | null
  tax_id: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

type OwnerStatement = {
  id: string
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
  status: 'draft' | 'issued' | 'disbursed' | 'void'
  issued_at: string | null
  disbursed_at: string | null
  created_at: string
}

type UnitOwnership = {
  unit_owner_id: string
  unit_id: string
  is_primary: boolean
  share_pct: number | null
  effective_at: string
  source: string
}

const route = useRoute()
const router = useRouter()
const id = computed(() => String(route.params.id ?? ''))

const isChecking = ref(true)
const allowed = ref(false)

const owner = ref<Owner | null>(null)
const statements = ref<OwnerStatement[]>([])
const ownerships = ref<UnitOwnership[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const ownerRes = await $fetch<Owner>(`/api/property-owners/${id.value}`)
    owner.value = ownerRes

    // Side fetches — fail-soft, page still renders.
    const [stRes, uoRes] = await Promise.allSettled([
      $fetch<{ items: OwnerStatement[] }>(`/api/property-owners/${id.value}/statements`),
      // unit_owners is exposed via the active-summary view; falling back
      // to direct table read via the standard /api/property-owners/:id/units
      // path if it ever lands. For now, keep this page self-sufficient
      // by calling the table directly through the public API surface
      // that already enforces RLS.
      $fetch<{ items: UnitOwnership[] }>(`/api/property-owners/${id.value}/units`).catch(() => ({
        items: [],
      })),
    ])
    if (stRes.status === 'fulfilled') statements.value = stRes.value.items ?? []
    if (uoRes.status === 'fulfilled') ownerships.value = uoRes.value.items ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load owner',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

function formatPHP(minor: number, currency = 'PHP') {
  return ((minor || 0) / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })
}

function statementStatusClass(s: OwnerStatement['status']): string {
  switch (s) {
    case 'draft':
      return 'bg-muted text-muted-foreground'
    case 'issued':
      return 'bg-primary/15 text-primary'
    case 'disbursed':
      return 'bg-success/15 text-success'
    case 'void':
      return 'bg-destructive/15 text-destructive'
  }
}

function ownerLabel(o: Owner | null): string {
  if (!o) return ''
  if (o.external_name) return o.external_name
  if (o.user_id) return `User ${o.user_id.slice(0, 8)}…`
  if (o.contact_id) return `Contact #${o.contact_id}`
  if (o.external_email) return o.external_email
  return 'Unknown owner'
}

const totals = computed(() => {
  let rent = 0
  let dues = 0
  let exp = 0
  let net = 0
  let issued_count = 0
  for (const s of statements.value) {
    if (s.status === 'void') continue
    rent += s.rent_collected_minor
    dues += s.dues_collected_minor
    exp += s.expenses_minor
    net += s.net_disbursement_minor
    if (s.status !== 'draft') issued_count += 1
  }
  return { rent, dues, exp, net, issued_count }
})

onMounted(async () => {
  const ok =
    (await hasPermission('property.manage')) ||
    (await hasPermission('owner_statements.manage')) ||
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
  <div class="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <NuxtLink
        to="/admin/owners"
        class="inline-flex items-center text-sm text-primary hover:underline"
      >
        ← Back to owners
      </NuxtLink>

      <div
        v-if="loading"
        class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
      >
        Loading…
      </div>

      <template v-else-if="owner">
        <!-- Header card -->
        <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="text-xs uppercase tracking-wide text-muted-foreground">
                  Property Owner
                </span>
                <span
                  v-if="owner.user_id"
                  class="inline-flex rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success"
                >portal · linked</span>
              </div>
              <h1 class="text-page-title">
                {{ ownerLabel(owner) }}
              </h1>
              <p class="mt-1 text-sm text-muted-foreground">
                <span v-if="owner.external_email">{{ owner.external_email }}</span>
                <span v-if="owner.tax_id" class="ml-2 font-mono text-xs">· TIN {{ owner.tax_id }}</span>
              </p>
              <p class="mt-2 text-xs text-muted-foreground/70">
                Created {{ new Date(owner.created_at).toLocaleDateString() }}
                <span v-if="owner.updated_at !== owner.created_at">
                  · last edited {{ new Date(owner.updated_at).toLocaleDateString() }}
                </span>
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <NuxtLink
                to="/admin/owners"
                class="btn-secondary focus-ring"
              >
                Edit details
              </NuxtLink>
            </div>
          </div>

          <p v-if="owner.notes" class="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
            {{ owner.notes }}
          </p>
        </section>

        <!-- Lifetime totals -->
        <section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">
              Rent collected
            </div>
            <div class="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {{ formatPHP(totals.rent) }}
            </div>
            <div class="text-[11px] text-muted-foreground">across non-void statements</div>
          </div>
          <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Dues collected</div>
            <div class="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {{ formatPHP(totals.dues) }}
            </div>
          </div>
          <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Expenses</div>
            <div class="mt-1 text-lg font-semibold tabular-nums text-destructive">
              ({{ formatPHP(totals.exp) }})
            </div>
          </div>
          <div class="rounded-lg border border-border bg-card p-4 text-card-foreground">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Net disbursed</div>
            <div
              class="mt-1 text-lg font-semibold tabular-nums"
              :class="totals.net >= 0 ? 'text-success' : 'text-destructive'"
            >
              {{ formatPHP(totals.net) }}
            </div>
            <div class="text-[11px] text-muted-foreground">
              {{ totals.issued_count }} issued statement{{ totals.issued_count === 1 ? '' : 's' }}
            </div>
          </div>
        </section>

        <!-- Active unit ownerships -->
        <section
          v-if="ownerships.length > 0"
          class="rounded-lg border border-border bg-card p-5 text-card-foreground"
        >
          <h2 class="mb-3 text-base font-semibold text-foreground">
            Active units
            <span class="text-xs font-normal text-muted-foreground">({{ ownerships.length }})</span>
          </h2>
          <ul class="divide-y divide-border">
            <li v-for="o in ownerships" :key="o.unit_owner_id" class="py-2.5">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-xs text-foreground">
                      Unit {{ o.unit_id.slice(0, 8) }}…
                    </span>
                    <span
                      v-if="o.is_primary"
                      class="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary"
                    >primary</span>
                    <span
                      v-if="o.share_pct"
                      class="text-xs text-muted-foreground"
                    >· {{ o.share_pct }}%</span>
                  </div>
                  <p class="text-xs text-muted-foreground">
                    Effective {{ new Date(o.effective_at).toLocaleDateString() }}
                    <span v-if="o.source"> · {{ o.source.replace('_', ' ') }}</span>
                  </p>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <!-- Statements -->
        <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-base font-semibold text-foreground">
              Statements
              <span class="text-xs font-normal text-muted-foreground">({{ statements.length }})</span>
            </h2>
            <NuxtLink
              to="/admin/owners"
              class="text-xs text-primary hover:underline"
              :title="'Configure auto-statement schedule on the owners list page'"
            >
              Manage schedule
            </NuxtLink>
          </div>
          <div v-if="statements.length === 0" class="text-sm text-muted-foreground">
            No statements have been issued for this owner yet. Set up an auto-statement
            schedule on the owners list page, or use <em>Generate statements now</em>.
          </div>
          <div v-else class="overflow-x-auto">
            <table class="min-w-full divide-y divide-border text-sm">
              <thead class="bg-muted/40">
                <tr>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Statement</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Period</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Rent</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Dues</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Expenses</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Net</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                <tr v-for="s in statements" :key="s.id">
                  <td class="px-3 py-2 font-mono text-xs">{{ s.statement_no }}</td>
                  <td class="px-3 py-2 text-xs text-muted-foreground">
                    {{ new Date(s.period_start).toLocaleDateString() }}
                    → {{ new Date(s.period_end).toLocaleDateString() }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ formatPHP(s.rent_collected_minor, s.currency) }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums">
                    {{ formatPHP(s.dues_collected_minor, s.currency) }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums text-destructive">
                    ({{ formatPHP(s.expenses_minor, s.currency) }})
                  </td>
                  <td
                    class="px-3 py-2 text-right tabular-nums font-medium"
                    :class="s.net_disbursement_minor >= 0 ? 'text-success' : 'text-destructive'"
                  >
                    {{ formatPHP(s.net_disbursement_minor, s.currency) }}
                  </td>
                  <td class="px-3 py-2 text-xs">
                    <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', statementStatusClass(s.status)]">
                      {{ s.status }}
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right">
                    <a
                      :href="`/api/admin/owner-statements/${s.id}/pdf`"
                      target="_blank"
                      rel="noopener"
                      class="text-xs text-primary hover:underline"
                      title="Open PDF in a new tab (right-click → Save As to download)"
                    >
                      PDF
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
