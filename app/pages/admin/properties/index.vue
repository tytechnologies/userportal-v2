<script setup lang="ts">
/**
 * /admin/properties — paginated browser for the canonical property entity.
 *
 * Reads from /api/admin/properties (paginated, filterable). Each row
 * surfaces variant count, source mix, primary-pin state, and the
 * internal_authoritative trust flag. Click-through goes to
 * /admin/properties/[id] for the detail view + variant actions.
 *
 * Filters are intentionally minimal in v1 — q (name/address trigram),
 * city, category, "needs primary pin", "internal only". Power-user
 * filters (variant count threshold, source mix) can come later.
 */

import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Properties | Admin' })

type Property = {
  id: number
  name: string | null
  slug: string | null
  street_address: string | null
  category: string | null
  type: string | null
  primary_listing_id: number | null
  internal_authoritative: boolean
  created_at: string | null
  updated_at: string | null
  city:     { id: number; name: string | null; slug: string | null } | null
  barangay: { id: number; name: string | null; slug: string | null } | null
  variants: { total: number; live: number; internal: number; source: number }
}

const router = useRouter()

const filters = reactive<{
  q: string
  category: '' | 'residential' | 'commercial'
  has_pinned_primary: '' | 'true' | 'false'
  internal_only: '' | 'true'
  page: number
  page_size: number
}>({
  q: '',
  category: '',
  has_pinned_primary: '',
  internal_only: '',
  page: 1,
  page_size: 25,
})

const loading = ref(false)
const properties = ref<Property[]>([])
const total = ref(0)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / filters.page_size)))

async function load() {
  loading.value = true
  try {
    const query: Record<string, unknown> = {
      page: filters.page,
      page_size: filters.page_size,
    }
    if (filters.q.trim())             query.q = filters.q.trim()
    if (filters.category)             query.category = filters.category
    if (filters.has_pinned_primary)   query.has_pinned_primary = filters.has_pinned_primary
    if (filters.internal_only)        query.internal_only = filters.internal_only

    const res = await $fetch<{ properties: Property[]; total: number }>(
      '/api/admin/properties',
      { query },
    )
    properties.value = res.properties ?? []
    total.value      = res.total ?? 0
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load properties', icon: 'error' })
  } finally {
    loading.value = false
  }
}

function gotoDetail(p: Property) {
  router.push(`/admin/properties/${p.id}`)
}

// Reload when any filter (except q which debounces) changes.
watch(
  () => [filters.category, filters.has_pinned_primary, filters.internal_only, filters.page],
  () => load(),
)

// Debounce q.
let qTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => filters.q,
  () => {
    if (qTimer) clearTimeout(qTimer)
    qTimer = setTimeout(() => {
      filters.page = 1
      load()
    }, 350)
  },
)

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['admin.access']" max-width="wide">
    <UiPageHeader
      title="Properties"
      description="The canonical property entity (db-main-reference/tables.sql). Each property collects one or more listing variants. Click any row for the variant view, primary-pin controls, and internal-authoritative toggle."
    >
      <template #actions>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          @click="load"
        >
          Refresh
        </button>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <UiStatCard label="Total (filtered)" :value="total.toLocaleString()" />
      <UiStatCard label="Page" :value="`${filters.page} / ${totalPages}`" />
      <UiStatCard label="Per page" :value="filters.page_size" />
    </div>

    <UiCard variant="surface" padding="md">
      <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <label class="block">
          <span class="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Search (name / address)</span>
          <input
            v-model="filters.q"
            type="text"
            class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
            placeholder="e.g. The Residences"
          />
        </label>
        <label class="block">
          <span class="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Category</span>
          <select
            v-model="filters.category"
            class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          >
            <option value="">Any</option>
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
          </select>
        </label>
        <label class="block">
          <span class="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Primary pin</span>
          <select
            v-model="filters.has_pinned_primary"
            class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          >
            <option value="">Any</option>
            <option value="true">Pinned</option>
            <option value="false">Unpinned (elected fallback)</option>
          </select>
        </label>
        <label class="block">
          <span class="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Internal-authoritative</span>
          <select
            v-model="filters.internal_only"
            class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          >
            <option value="">Any</option>
            <option value="true">Internal-authoritative only</option>
          </select>
        </label>
      </div>
    </UiCard>

    <UiCard variant="surface" padding="none">
      <div v-if="loading" class="p-5 text-center text-meta">Loading…</div>
      <UiEmptyState
        v-else-if="properties.length === 0"
        title="No properties match these filters"
        description="Clear the filters above to see the full set."
      />
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-muted/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Property</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Location</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</th>
              <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Variants</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Primary</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Trust</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Updated</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="p in properties"
              :key="p.id"
              class="cursor-pointer hover:bg-accent/50"
              @click="gotoDetail(p)"
            >
              <td class="px-3 py-2 max-w-xs">
                <div class="font-medium text-foreground truncate">{{ p.name || `Property #${p.id}` }}</div>
                <div class="text-[11px] text-muted-foreground truncate">{{ p.street_address || '—' }}</div>
              </td>
              <td class="px-3 py-2 text-xs">
                <div class="text-foreground">{{ p.city?.name || '—' }}</div>
                <div class="text-muted-foreground">{{ p.barangay?.name || '—' }}</div>
              </td>
              <td class="px-3 py-2 text-xs">
                <UiBadge variant="neutral">{{ p.type || '—' }}</UiBadge>
                <div class="text-[11px] text-muted-foreground mt-0.5">{{ p.category || '—' }}</div>
              </td>
              <td class="px-3 py-2 text-right tabular-nums text-xs">
                <div class="font-medium">{{ p.variants.total }}</div>
                <div class="text-[11px] text-muted-foreground">
                  {{ p.variants.live }} live · {{ p.variants.internal }}/{{ p.variants.source }} int/src
                </div>
              </td>
              <td class="px-3 py-2 text-xs">
                <UiBadge v-if="p.primary_listing_id" variant="info">
                  #{{ p.primary_listing_id }}
                </UiBadge>
                <UiBadge v-else variant="neutral">elected</UiBadge>
              </td>
              <td class="px-3 py-2">
                <UiBadge v-if="p.internal_authoritative" variant="success">internal</UiBadge>
                <span v-else class="text-[11px] text-muted-foreground">—</span>
              </td>
              <td class="px-3 py-2 text-xs text-muted-foreground">
                {{ p.updated_at ? new Date(p.updated_at).toLocaleDateString() : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <div class="flex items-center justify-between text-xs text-muted-foreground" v-if="!loading && properties.length > 0">
      <div>
        Showing {{ ((filters.page - 1) * filters.page_size + 1).toLocaleString() }} –
        {{ Math.min(filters.page * filters.page_size, total).toLocaleString() }}
        of {{ total.toLocaleString() }}
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded border border-border px-3 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
          :disabled="filters.page <= 1"
          @click="filters.page = Math.max(1, filters.page - 1)"
        >
          ← Prev
        </button>
        <button
          type="button"
          class="rounded border border-border px-3 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
          :disabled="filters.page >= totalPages"
          @click="filters.page = Math.min(totalPages, filters.page + 1)"
        >
          Next →
        </button>
      </div>
    </div>
  </AdminPageShell>
</template>
