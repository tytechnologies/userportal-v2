<script setup lang="ts">
/**
 * /admin/duplicates — review queue for the dedup detector.
 *
 * Data sources:
 *   GET  /api/admin/duplicates                       — paginated pairs + listing hydration
 *   PATCH /api/admin/duplicates/:id                  — verdict (mig 20260507000037)
 *   POST  /api/admin/duplicates/:id/merge            — listing-level merge (mig 20260507000042)
 *   POST  /api/admin/properties/:id/attach-variant   — property-level reparent (mig 20260510000001)
 *
 * Two merge actions are surfaced explicitly so the operator picks the
 * right one for the situation; see the descriptions on the buttons.
 */

import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Duplicates | Admin' })

type Listing = {
  id: number
  property_id: number | null
  title: string | null
  sale_price: number | null
  rent_price: number | null
  bedrooms: number | null
  bathrooms: number | null
  floor_area: number | null
  is_online: boolean
  deleted_at: string | null
  source_id: number | null
  created_by: string | null
  created_at: string | null
  broker: { id: string; full_name: string | null } | null
}

type Pair = {
  id: string
  a_listing_id: number
  b_listing_id: number
  confidence: number
  signals: Record<string, number>
  status: 'pending' | 'confirmed_duplicate' | 'distinct' | 'dismissed'
  detected_at: string
  detected_run: string | null
  reviewed_at: string | null
  review_notes: string | null
  canonical_listing_id: number | null
  merged_listing_id: number | null
  merged_at: string | null
  a: Listing | null
  b: Listing | null
}

const pairs = ref<Pair[]>([])
const total = ref(0)
const loading = ref(false)
const acting = ref<Record<string, boolean>>({})
const tab = ref<'pending' | 'confirmed_duplicate' | 'distinct' | 'dismissed'>('pending')

const pendingCount = computed(() =>
  tab.value === 'pending' ? total.value : pairs.value.length,
)
const avgConfidence = computed(() => {
  if (pairs.value.length === 0) return 0
  return Math.round(
    pairs.value.reduce((sum, p) => sum + (p.confidence ?? 0), 0) / pairs.value.length,
  )
})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      pairs: Pair[]
      candidates?: Pair[]
      total: number
    }>('/api/admin/duplicates', {
      query: { status: tab.value, page: 1, page_size: 50 },
    })
    // Existing endpoint returns `candidates`; treat both shapes.
    pairs.value = res.pairs ?? res.candidates ?? []
    total.value = res.total ?? 0
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load duplicates', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function setVerdict(pair: Pair, status: 'distinct' | 'dismissed') {
  acting.value[pair.id] = true
  try {
    await $fetch(`/api/admin/duplicates/${pair.id}`, {
      method: 'PATCH',
      body: { status },
    })
    pairs.value = pairs.value.filter((p) => p.id !== pair.id)
    total.value = Math.max(0, total.value - 1)
    showToast({ title: `Marked as ${status === 'distinct' ? 'distinct' : 'dismissed'}`, icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Verdict failed', icon: 'error' })
  } finally {
    acting.value[pair.id] = false
  }
}

async function mergeAsSameListing(pair: Pair, canonicalListingId: number) {
  if (!confirm(`Soft-delete the other listing and point it at #${canonicalListingId}? This is reversible only via SQL.`)) return
  acting.value[pair.id] = true
  try {
    // The existing endpoint requires status='confirmed_duplicate' first.
    if (pair.status !== 'confirmed_duplicate') {
      await $fetch(`/api/admin/duplicates/${pair.id}`, {
        method: 'PATCH',
        body: { status: 'confirmed_duplicate' },
      })
    }
    await $fetch(`/api/admin/duplicates/${pair.id}/merge`, {
      method: 'POST',
      body: { canonical_listing_id: canonicalListingId },
    })
    pairs.value = pairs.value.filter((p) => p.id !== pair.id)
    total.value = Math.max(0, total.value - 1)
    showToast({ title: 'Merged as the same listing', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Merge failed', icon: 'error' })
  } finally {
    acting.value[pair.id] = false
  }
}

async function attachAsVariant(pair: Pair, sourceListingId: number, targetPropertyId: number) {
  if (!targetPropertyId) {
    showToast({ title: 'Target listing has no property_id', icon: 'error' })
    return
  }
  if (!confirm(`Reparent listing #${sourceListingId} under property #${targetPropertyId}? Both listings stay live.`)) return
  acting.value[pair.id] = true
  try {
    await $fetch(`/api/admin/properties/${targetPropertyId}/attach-variant`, {
      method: 'POST',
      body: { listing_id: sourceListingId, pair_id: pair.id },
    })
    pairs.value = pairs.value.filter((p) => p.id !== pair.id)
    total.value = Math.max(0, total.value - 1)
    showToast({ title: 'Reparented as variant', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Attach failed', icon: 'error' })
  } finally {
    acting.value[pair.id] = false
  }
}

function priceLabel(l: Listing | null): string {
  if (!l) return '—'
  if (l.sale_price) return `₱${l.sale_price.toLocaleString()} sale`
  if (l.rent_price) return `₱${l.rent_price.toLocaleString()} rent`
  return '—'
}

function bedBath(l: Listing | null): string {
  if (!l) return '—'
  const parts: string[] = []
  if (l.bedrooms != null) parts.push(`${l.bedrooms}BR`)
  if (l.bathrooms != null) parts.push(`${l.bathrooms}BA`)
  if (l.floor_area != null) parts.push(`${l.floor_area}sqm`)
  return parts.join(' · ') || '—'
}

function signalChips(signals: Record<string, number>): Array<{ key: string; value: number }> {
  return Object.entries(signals ?? {})
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => ({ key: k, value: Number(v) }))
}

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['admin.access']" max-width="wide">
    <UiPageHeader
      title="Duplicate Review Queue"
      description="Pair candidates emitted by find_listing_duplicate_candidates (within-building, confidence ≥ 50). For each pair pick one of three actions: distinct (different listings), merge (literally the same listing posted twice — soft-deletes the loser), or attach-variant (different listings for the same property — reparents property_id, both stay live)."
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
      <UiStatCard label="Pairs (current tab)" :value="pendingCount" />
      <UiStatCard label="Avg confidence" :value="`${avgConfidence}`" tone="primary" />
      <UiStatCard label="Currently viewing" :value="tab.replace('_', ' ')" />
    </div>

    <!-- Tab strip -->
    <div class="flex gap-2 border-b border-border">
      <button
        v-for="t in (['pending','confirmed_duplicate','distinct','dismissed'] as const)"
        :key="t"
        type="button"
        :class="[
          'px-3 py-2 text-sm font-medium transition-colors',
          tab === t
            ? 'border-b-2 border-primary text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        ]"
        @click="tab = t; load()"
      >
        {{ t.replace('_', ' ') }}
      </button>
    </div>

    <UiCard variant="surface" padding="none">
      <div v-if="loading" class="p-5 text-center text-meta">Loading…</div>
      <UiEmptyState
        v-else-if="pairs.length === 0"
        title="No pairs in this state"
        description="The detector cron runs nightly (full) and every 30 minutes (recent). New pairs appear here automatically."
      />
      <div v-else class="divide-y divide-border">
        <div
          v-for="pair in pairs"
          :key="pair.id"
          class="p-4 grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_auto] gap-4 items-stretch"
        >
          <!-- Side A -->
          <div class="rounded-lg border border-border bg-card p-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="font-medium text-foreground truncate">
                  #{{ pair.a?.id }} — {{ pair.a?.title || 'Untitled' }}
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  Property #{{ pair.a?.property_id ?? '—' }} · {{ bedBath(pair.a) }}
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ priceLabel(pair.a) }}</div>
                <div v-if="pair.a?.broker" class="text-xs text-muted-foreground mt-0.5">
                  Broker: {{ pair.a.broker.full_name || '—' }}
                </div>
              </div>
              <div class="flex flex-col gap-1 items-end shrink-0">
                <UiBadge v-if="pair.a?.is_online" variant="success">online</UiBadge>
                <UiBadge v-else variant="warning">offline</UiBadge>
                <UiBadge v-if="pair.a?.source_id" variant="info">source #{{ pair.a.source_id }}</UiBadge>
                <UiBadge v-else variant="neutral">internal</UiBadge>
              </div>
            </div>
            <div class="mt-3 flex flex-wrap gap-1">
              <button
                v-if="pair.a && pair.b"
                type="button"
                class="text-[11px] rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
                :disabled="acting[pair.id] || !pair.b.property_id"
                @click="attachAsVariant(pair, pair.a.id, pair.b!.property_id!)"
              >
                Reparent A → B's property
              </button>
              <button
                v-if="pair.a && pair.b"
                type="button"
                class="text-[11px] rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
                :disabled="acting[pair.id]"
                @click="mergeAsSameListing(pair, pair.b!.id)"
              >
                Merge: keep B, kill A
              </button>
            </div>
          </div>

          <!-- Center signals + confidence -->
          <div class="flex flex-col items-center justify-center gap-2 text-center">
            <div class="text-3xl font-semibold text-foreground tabular-nums">
              {{ pair.confidence }}
            </div>
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">confidence</div>
            <div class="flex flex-wrap justify-center gap-1 max-w-[12rem]">
              <UiBadge
                v-for="s in signalChips(pair.signals)"
                :key="s.key"
                variant="neutral"
              >
                {{ s.key }} +{{ s.value }}
              </UiBadge>
            </div>
            <div class="flex gap-1 mt-1">
              <button
                type="button"
                class="text-[11px] rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
                :disabled="acting[pair.id]"
                @click="setVerdict(pair, 'distinct')"
              >
                Distinct
              </button>
              <button
                type="button"
                class="text-[11px] rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
                :disabled="acting[pair.id]"
                @click="setVerdict(pair, 'dismissed')"
              >
                Dismiss
              </button>
            </div>
          </div>

          <!-- Side B -->
          <div class="rounded-lg border border-border bg-card p-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="font-medium text-foreground truncate">
                  #{{ pair.b?.id }} — {{ pair.b?.title || 'Untitled' }}
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  Property #{{ pair.b?.property_id ?? '—' }} · {{ bedBath(pair.b) }}
                </div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ priceLabel(pair.b) }}</div>
                <div v-if="pair.b?.broker" class="text-xs text-muted-foreground mt-0.5">
                  Broker: {{ pair.b.broker.full_name || '—' }}
                </div>
              </div>
              <div class="flex flex-col gap-1 items-end shrink-0">
                <UiBadge v-if="pair.b?.is_online" variant="success">online</UiBadge>
                <UiBadge v-else variant="warning">offline</UiBadge>
                <UiBadge v-if="pair.b?.source_id" variant="info">source #{{ pair.b.source_id }}</UiBadge>
                <UiBadge v-else variant="neutral">internal</UiBadge>
              </div>
            </div>
            <div class="mt-3 flex flex-wrap gap-1">
              <button
                v-if="pair.a && pair.b"
                type="button"
                class="text-[11px] rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
                :disabled="acting[pair.id] || !pair.a.property_id"
                @click="attachAsVariant(pair, pair.b.id, pair.a!.property_id!)"
              >
                Reparent B → A's property
              </button>
              <button
                v-if="pair.a && pair.b"
                type="button"
                class="text-[11px] rounded border border-border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
                :disabled="acting[pair.id]"
                @click="mergeAsSameListing(pair, pair.a!.id)"
              >
                Merge: keep A, kill B
              </button>
            </div>
          </div>

          <!-- Spacer for grid alignment on wide screens -->
          <div class="hidden lg:block" />
        </div>
      </div>
    </UiCard>
  </AdminPageShell>
</template>
