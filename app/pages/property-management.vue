<script setup lang="ts">
/**
 * /property-management — domain dashboard.
 *
 * Real PM-manager landing rather than a tile menu:
 *   - KPI strip: active leases, expiring in 30d, open work orders
 *   - "Expiring soon" panel — leases past `expires_at - 30d`
 *   - "Open work orders" panel — assigned + in_progress, sorted recent
 *   - Jump-to chips for the rest of the PM surface
 *
 * Uses /api/leases?status=active and /api/work-orders?status=…; both
 * RLS-scoped. KPI counts are derived client-side from the same lists
 * so we don't fan out extra count queries.
 */
import { computed, onMounted, ref } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Property Management | Housing Interactive' })

type Lease = {
  id: string
  unit_id: string
  status: 'draft' | 'pending_signature' | 'active' | 'expired' | 'terminated' | 'cancelled'
  rent_minor: number
  currency: string
  effective_at: string
  expires_at: string
}
type WorkOrder = {
  id: string
  unit_id: string
  status: 'draft' | 'pending_assignment' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'
  priority?: string | null
  title?: string | null
  description?: string | null
  scheduled_at?: string | null
  created_at: string
}

const activeLeases = ref<Lease[]>([])
const openOrders   = ref<WorkOrder[]>([])
const loading      = ref(true)

async function load() {
  loading.value = true
  try {
    // Two parallel pulls. Endpoints don't paginate today; if a
    // brokerage outgrows the in-memory list, we'll switch to a
    // dashboard-specific count endpoint.
    const [leasesRes, ordersAssigned, ordersInProgress] = await Promise.all([
      $fetch<{ data: Lease[] }>('/api/leases', { query: { status: 'active' } }).catch(() => ({ data: [] })),
      $fetch<{ data: WorkOrder[] }>('/api/work-orders', { query: { status: 'assigned' } }).catch(() => ({ data: [] })),
      $fetch<{ data: WorkOrder[] }>('/api/work-orders', { query: { status: 'in_progress' } }).catch(() => ({ data: [] })),
    ])
    activeLeases.value = leasesRes.data ?? []
    openOrders.value = [...(ordersAssigned.data ?? []), ...(ordersInProgress.data ?? [])]
  } catch {
    activeLeases.value = []
    openOrders.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Expiring within 30 days; sorted earliest-first so the broker sees
// what's most urgent at the top.
const expiringSoon = computed<Lease[]>(() => {
  const now = Date.now()
  const thirtyDaysOut = now + 30 * 24 * 60 * 60 * 1000
  return activeLeases.value
    .filter((l) => {
      const t = new Date(l.expires_at).getTime()
      return Number.isFinite(t) && t >= now && t <= thirtyDaysOut
    })
    .sort((a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime())
    .slice(0, 6)
})
const expiringSoonCount = computed(() => {
  const now = Date.now()
  const thirtyDaysOut = now + 30 * 24 * 60 * 60 * 1000
  return activeLeases.value.filter((l) => {
    const t = new Date(l.expires_at).getTime()
    return Number.isFinite(t) && t >= now && t <= thirtyDaysOut
  }).length
})

const recentOpenOrders = computed<WorkOrder[]>(() => {
  return [...openOrders.value]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 6)
})

function formatMoney(minor: number, currency: string): string {
  const major = (Number(minor) || 0) / 100
  const sym = currency === 'PHP' ? '₱' : currency
  return `${sym} ${major.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function relativeDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diffDays = Math.round((t - Date.now()) / (24 * 60 * 60 * 1000))
  if (diffDays < 0) return `${-diffDays}d ago`
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  if (diffDays < 30) return `in ${diffDays}d`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusVariant(s: WorkOrder['status']): 'primary' | 'warning' | 'success' | 'neutral' | 'destructive' {
  switch (s) {
    case 'in_progress': return 'primary'
    case 'assigned':    return 'warning'
    case 'completed':   return 'success'
    case 'cancelled':   return 'destructive'
    default:            return 'neutral'
  }
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="6xl">
    <UiPageHeader title="Property Management">
      <template #description>
        Active leases, lease renewals, and the maintenance pipeline at a glance.
      </template>
    </UiPageHeader>

    <!-- KPI strip -->
    <div class="grid gap-3 sm:grid-cols-3">
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Active leases</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          {{ loading ? '—' : activeLeases.length }}
        </p>
      </UiCard>
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Expiring in 30d</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          <span :class="expiringSoonCount > 0 ? 'text-warning' : ''">
            {{ loading ? '—' : expiringSoonCount }}
          </span>
        </p>
      </UiCard>
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Open work orders</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          {{ loading ? '—' : openOrders.length }}
        </p>
      </UiCard>
    </div>

    <!-- Expiring + Recent orders -->
    <div class="grid gap-4 lg:grid-cols-2">
      <UiCard padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Leases expiring in 30 days</h2>
          <NuxtLink to="/admin/leases" class="text-xs font-medium text-primary hover:underline focus-ring rounded">
            All leases →
          </NuxtLink>
        </header>
        <p v-if="loading" class="text-xs text-muted-foreground">Loading…</p>
        <p
          v-else-if="expiringSoon.length === 0"
          class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
        >
          Nothing expiring in the next month — clean slate.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="l in expiringSoon"
            :key="l.id"
            class="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs"
          >
            <div class="flex flex-wrap items-baseline gap-2">
              <span class="font-mono text-[10px] text-muted-foreground">{{ l.unit_id.slice(0, 8) }}…</span>
              <span class="font-semibold text-foreground">
                {{ formatMoney(l.rent_minor, l.currency) }} / {{ l.currency }}
              </span>
              <span class="ml-auto text-[10px] tabular-nums text-warning">
                expires {{ relativeDate(l.expires_at) }}
              </span>
            </div>
          </li>
        </ul>
      </UiCard>

      <UiCard padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Open work orders</h2>
          <NuxtLink to="/admin/work-orders" class="text-xs font-medium text-primary hover:underline focus-ring rounded">
            All orders →
          </NuxtLink>
        </header>
        <p v-if="loading" class="text-xs text-muted-foreground">Loading…</p>
        <p
          v-else-if="recentOpenOrders.length === 0"
          class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
        >
          No open work orders — properties are running smoothly.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="w in recentOpenOrders"
            :key="w.id"
            class="rounded-md border border-border bg-card px-3 py-2 text-xs"
          >
            <div class="flex flex-wrap items-baseline gap-2">
              <UiBadge :variant="statusVariant(w.status)" size="xs">
                {{ w.status.replace('_', ' ') }}
              </UiBadge>
              <span class="min-w-0 flex-1 truncate font-semibold text-foreground">
                {{ w.title || `Order ${w.id.slice(0, 8)}` }}
              </span>
              <span class="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {{ relativeDate(w.created_at) }}
              </span>
            </div>
          </li>
        </ul>
      </UiCard>
    </div>

    <!-- Jump-to chips -->
    <section class="border-t border-border pt-4">
      <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Jump to
      </p>
      <div class="flex flex-wrap gap-2">
        <NuxtLink to="/admin/leases" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Leases</NuxtLink>
        <NuxtLink to="/admin/units" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Units</NuxtLink>
        <NuxtLink to="/admin/work-orders" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Work orders</NuxtLink>
        <NuxtLink to="/admin/maintenance" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Maintenance</NuxtLink>
        <NuxtLink to="/admin/inspections" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Inspections</NuxtLink>
        <NuxtLink to="/admin/vendors" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Vendors</NuxtLink>
        <NuxtLink to="/admin/owners" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Owners</NuxtLink>
        <NuxtLink to="/admin/property-charges" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Charges</NuxtLink>
        <NuxtLink to="/admin/late-fees" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Late fees</NuxtLink>
      </div>
    </section>
  </AdminPageShell>
</template>
