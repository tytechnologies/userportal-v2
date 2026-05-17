<script setup lang="ts">
/**
 * /admin/leases — lease inventory.
 *
 * Filterable table of every lease the caller can see (RLS gates by
 * party/admin). Status pills, rent at-a-glance, click-row to detail.
 *
 * Detail / lifecycle actions live on /admin/leases/:id.
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Leases | Admin' })

type LeaseStatus =
  | 'draft'
  | 'pending_signature'
  | 'active'
  | 'expired'
  | 'terminated'
  | 'cancelled'

type Lease = {
  id: string
  unit_id: string
  listing_id: number | null
  deal_id: string | null
  parent_lease_id: string | null
  lease_type: string
  currency: string
  rent_minor: number
  rent_period: 'monthly' | 'quarterly' | 'annual'
  security_deposit_minor: number
  effective_at: string
  expires_at: string
  status: LeaseStatus
  activated_at: string | null
  terminated_at: string | null
  created_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const leases = ref<Lease[]>([])
const loading = ref(false)
const statusFilter = ref<LeaseStatus | 'all'>('all')
const search = ref('')

async function load() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    const res = await $fetch<{ items: Lease[] }>('/api/leases', { query: params })
    leases.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load leases', icon: 'error' })
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return leases.value
  return leases.value.filter(
    (l) =>
      l.id.toLowerCase().includes(q) ||
      l.unit_id.toLowerCase().includes(q) ||
      (l.lease_type ?? '').toLowerCase().includes(q),
  )
})

const counts = computed(() => {
  const c: Record<string, number> = {
    all: leases.value.length,
    active: 0,
    expired: 0,
    draft: 0,
    pending_signature: 0,
    terminated: 0,
    cancelled: 0,
  }
  for (const l of leases.value) c[l.status] = (c[l.status] ?? 0) + 1
  return c
})

function formatPHP(minor: number, currency = 'PHP') {
  return (minor / 100).toLocaleString('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })
}

function statusClass(s: LeaseStatus) {
  switch (s) {
    case 'active':
      return 'bg-success/15 text-success'
    case 'expired':
      return 'bg-muted text-muted-foreground'
    case 'draft':
      return 'bg-primary/15 text-primary'
    case 'pending_signature':
      return 'bg-warning/15 text-warning'
    case 'terminated':
      return 'bg-destructive/15 text-destructive'
    case 'cancelled':
      return 'bg-muted text-muted-foreground'
  }
}

onMounted(async () => {
  const ok =
    (await hasPermission('leases.manage')) || (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({
      title: 'You do not have access to leases.',
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
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-page-title">
            Leases
          </h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Active and historical lease contracts. Click a row to manage parties, rent
            schedule, and lifecycle.
          </p>
        </div>
      </header>

      <!-- Status filter strip -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="opt in (
            ['all', 'active', 'pending_signature', 'draft', 'expired', 'terminated', 'cancelled'] as const
          )"
          :key="opt"
          type="button"
          :class="[
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
            statusFilter === opt
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
          ]"
          @click="statusFilter = opt; load()"
        >
          <span class="capitalize">{{ opt.replace('_', ' ') }}</span>
          <span
            v-if="counts[opt] !== undefined"
            :class="[
              'rounded-full px-1.5 text-[10px] font-semibold',
              statusFilter === opt
                ? 'bg-white/20 text-white'
                : 'bg-muted text-muted-foreground',
            ]"
          >{{ counts[opt] }}</span>
        </button>
        <input
          v-model="search"
          type="search"
          placeholder="Filter by id, unit, or type…"
          class="ml-auto w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
        />
      </div>

      <!-- Table -->
      <section class="rounded-lg border border-border bg-card p-0 text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="filtered.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No leases match the current filter.
        </div>
        <div v-else>
          <!-- Mobile: stacked card list (< md). Each card carries the
               same fields as a row but vertical, thumb-friendly tap target. -->
          <ul class="divide-y divide-border md:hidden">
            <li
              v-for="l in filtered"
              :key="l.id"
              class="cursor-pointer p-4 transition-colors hover:bg-accent hover:text-accent-foreground"
              @click="router.push(`/admin/leases/${l.id}`)"
            >
              <div class="flex items-start justify-between gap-2">
                <span class="font-mono text-xs text-muted-foreground">{{ l.id.slice(0, 8) }}…</span>
                <span
                  :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(l.status)]"
                >{{ l.status.replace('_', ' ') }}</span>
              </div>
              <p class="mt-1 capitalize text-sm font-medium text-foreground">{{ l.lease_type }}</p>
              <p class="mt-0.5 text-sm tabular-nums text-foreground">
                {{ formatPHP(l.rent_minor, l.currency) }}
                <span class="text-xs text-muted-foreground"> / {{ l.rent_period }}</span>
              </p>
              <p class="mt-2 text-xs text-muted-foreground">
                {{ new Date(l.effective_at).toLocaleDateString() }} →
                {{ new Date(l.expires_at).toLocaleDateString() }}
              </p>
              <p class="mt-0.5 font-mono text-xs text-muted-foreground/80">
                Unit {{ l.unit_id.slice(0, 8) }}…
              </p>
            </li>
          </ul>

          <!-- Desktop table (md+). Same data, tabular layout. -->
          <div class="hidden overflow-x-auto md:block">
            <table class="min-w-full divide-y divide-border text-sm">
              <thead class="bg-muted/40">
                <tr>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Lease</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</th>
                  <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Rent</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Term</th>
                  <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Unit</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                <tr
                  v-for="l in filtered"
                  :key="l.id"
                  class="cursor-pointer hover:bg-accent hover:text-accent-foreground"
                  @click="router.push(`/admin/leases/${l.id}`)"
                >
                  <td class="px-3 py-2 font-mono text-xs text-foreground">
                    {{ l.id.slice(0, 8) }}…
                  </td>
                  <td class="px-3 py-2">
                    <span
                      :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(l.status)]"
                    >{{ l.status.replace('_', ' ') }}</span>
                  </td>
                  <td class="px-3 py-2 capitalize text-foreground">
                    {{ l.lease_type }}
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums text-foreground">
                    {{ formatPHP(l.rent_minor, l.currency) }}
                    <span class="text-xs text-muted-foreground"> / {{ l.rent_period }}</span>
                  </td>
                  <td class="px-3 py-2 text-xs text-muted-foreground">
                    {{ new Date(l.effective_at).toLocaleDateString() }} →
                    {{ new Date(l.expires_at).toLocaleDateString() }}
                  </td>
                  <td class="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {{ l.unit_id.slice(0, 8) }}…
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
