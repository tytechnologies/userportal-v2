<script setup lang="ts">
/**
 * /admin/raw-ingest — raw + normalized ingest queue overview.
 *
 * Visualizes the B-3 dual-write staging:
 *   listings_raw         — verbatim partner payloads (idempotent on
 *                          (source_id, foreign_id, raw_hash))
 *   listings_normalized  — resolved foreign keys + match_status state
 *                          machine, drained by
 *                          /api/internal/normalize-raw-batch
 *   listings (B-3.1)     — applied via apply_listings_normalized_batch
 *                          (shadow mode; runs alongside direct ingest
 *                          write during the parity-verification window)
 *
 * Manual drain buttons trigger the workers without waiting for cron —
 * useful before cron is scheduled and for ad-hoc testing.
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
useHead({ title: 'Raw Ingest | Admin' })

type RawRow = {
  id: string
  source_id: number
  foreign_id: string
  normalize_status: 'pending' | 'normalized' | 'rejected'
  rejection_reason: string | null
  ingested_at: string
  normalized_at: string | null
}

type NormRow = {
  id: string
  raw_id: string | null
  source_id: number | null
  foreign_id: string | null
  title: string | null
  match_status: string
  resolved_property_id: number | null
  resolved_listing_id: number | null
  ingested_at: string
  matched_at: string | null
  match_notes: string | null
}

type ApplyCounts = {
  pending_apply: number
  applied: number
  skipped_stale: number
  skipped_collision: number
  apply_errors: number
  terminal_other: number
}

const loading = ref(false)
const draining = ref<'normalize' | 'apply' | null>(null)
const rawCounts = ref<Record<string, number>>({ pending: 0, normalized: 0, rejected: 0 })
const normCounts = ref<Record<string, number>>({})
const applyCounts = ref<ApplyCounts>({
  pending_apply: 0, applied: 0, skipped_stale: 0,
  skipped_collision: 0, apply_errors: 0, terminal_other: 0,
})
const recentRaw = ref<RawRow[]>([])
const recentNorm = ref<NormRow[]>([])

const pendingRaw = computed(() => rawCounts.value.pending ?? 0)
const pendingApply = computed(() => applyCounts.value.pending_apply)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      raw_status_counts: Record<string, number>
      normalized_status_counts: Record<string, number>
      apply_counts: ApplyCounts
      recent_raw: RawRow[]
      recent_normalized: NormRow[]
    }>('/api/admin/raw-ingest')
    rawCounts.value = res.raw_status_counts ?? {}
    normCounts.value = res.normalized_status_counts ?? {}
    applyCounts.value = res.apply_counts ?? {
      pending_apply: 0, applied: 0, skipped_stale: 0,
      skipped_collision: 0, apply_errors: 0, terminal_other: 0,
    }
    recentRaw.value = res.recent_raw ?? []
    recentNorm.value = res.recent_normalized ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load raw ingest queue', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function drainNormalize() {
  draining.value = 'normalize'
  try {
    const res = await $fetch<{ ok: true; result: { processed: number; normalized: number; rejected: number } | null }>(
      '/api/admin/raw-ingest/normalize',
      { method: 'POST', body: { max: 500 } },
    )
    const r = res.result
    showToast({
      title: r ? `Normalize: processed ${r.processed}, normalized ${r.normalized}, rejected ${r.rejected}` : 'Normalize complete',
      icon: 'success',
    })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Normalize failed', icon: 'error' })
  } finally {
    draining.value = null
  }
}

async function drainApply() {
  draining.value = 'apply'
  try {
    const res = await $fetch<{
      ok: true
      result: {
        processed: number; updated_existing: number; inserted_new: number;
        skipped_stale: number; skipped_collision: number; errors: number
      } | null
    }>('/api/admin/raw-ingest/apply', { method: 'POST', body: { max: 500 } })
    const r = res.result
    showToast({
      title: r
        ? `Apply: ${r.processed} processed (${r.updated_existing} upd / ${r.inserted_new} new / ${r.skipped_stale} stale / ${r.skipped_collision} coll / ${r.errors} err)`
        : 'Apply complete',
      icon: 'success',
    })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Apply failed', icon: 'error' })
  } finally {
    draining.value = null
  }
}

function rawVariant(status: string) {
  if (status === 'normalized') return 'success'
  if (status === 'rejected') return 'destructive'
  return 'warning'
}
function matchVariant(status: string) {
  if (status === 'matched_existing_listing') return 'success'
  if (status === 'matched_existing_property') return 'info'
  if (status === 'new_property') return 'primary'
  if (status === 'queued_for_review') return 'warning'
  if (status === 'rejected') return 'destructive'
  return 'neutral'
}
function applyStateOf(n: NormRow): { label: string; variant: ReturnType<typeof matchVariant> } {
  const eligible =
    n.match_status === 'matched_existing_listing' ||
    n.match_status === 'matched_existing_property'
  if (!eligible) return { label: 'n/a', variant: 'neutral' }
  if (n.matched_at == null) return { label: 'pending', variant: 'warning' }
  const notes = String(n.match_notes ?? '')
  if (notes.includes('apply error')) return { label: 'error', variant: 'destructive' }
  if (notes.includes('skipped (listings.source_observed_at fresher)'))
    return { label: 'stale skip', variant: 'neutral' }
  if (notes.includes('skipped (collision') || notes.includes('listings row gone'))
    return { label: 'coll. skip', variant: 'neutral' }
  return { label: 'applied', variant: 'success' }
}

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['admin.access']" max-width="wide">
    <UiPageHeader
      title="Raw Ingest"
      description="Dual-write staging for partner pushes. Verbatim payloads land in listings_raw → normalize worker resolves FKs into listings_normalized → apply worker (B-3.1) writes into listings. Direct ingest into listings is still active in parallel; staleness + collision guards make the apply worker a no-op when direct ingest already won."
    >
      <template #actions>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring disabled:opacity-60"
          :disabled="!!draining"
          @click="drainNormalize"
        >
          {{ draining === 'normalize' ? 'Normalizing…' : 'Drain normalize' }}
        </button>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring disabled:opacity-60"
          :disabled="!!draining"
          @click="drainApply"
        >
          {{ draining === 'apply' ? 'Applying…' : 'Drain apply' }}
        </button>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          @click="load"
        >
          Refresh
        </button>
      </template>
    </UiPageHeader>

    <!-- Stage 1: raw -->
    <UiCard variant="surface" padding="md">
      <div class="font-medium text-foreground mb-2">Stage 1 — listings_raw</div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <UiStatCard label="Pending" :value="pendingRaw" :tone="pendingRaw > 0 ? 'warning' : 'neutral'" />
        <UiStatCard label="Normalized" :value="rawCounts.normalized ?? 0" tone="success" />
        <UiStatCard label="Rejected" :value="rawCounts.rejected ?? 0" :tone="(rawCounts.rejected ?? 0) > 0 ? 'destructive' : 'neutral'" />
      </div>
    </UiCard>

    <!-- Stage 2: normalized -->
    <UiCard variant="surface" padding="md">
      <div class="font-medium text-foreground mb-2">Stage 2 — listings_normalized (match_status)</div>
      <div class="flex flex-wrap gap-2">
        <UiBadge
          v-for="[status, count] in Object.entries(normCounts)"
          :key="status"
          :variant="matchVariant(status)"
        >
          {{ status }} · {{ count }}
        </UiBadge>
        <UiBadge v-if="Object.keys(normCounts).length === 0" variant="neutral">
          (no normalized rows yet)
        </UiBadge>
      </div>
    </UiCard>

    <!-- Stage 3: apply (B-3.1) -->
    <UiCard variant="surface" padding="md">
      <div class="font-medium text-foreground mb-2">Stage 3 — apply (B-3.1)</div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <UiStatCard label="Pending apply" :value="pendingApply" :tone="pendingApply > 0 ? 'warning' : 'neutral'" />
        <UiStatCard label="Applied" :value="applyCounts.applied" tone="success" />
        <UiStatCard label="Stale skips" :value="applyCounts.skipped_stale" />
        <UiStatCard label="Collision skips" :value="applyCounts.skipped_collision" />
        <UiStatCard
          label="Errors"
          :value="applyCounts.apply_errors"
          :tone="applyCounts.apply_errors > 0 ? 'destructive' : 'neutral'"
        />
      </div>
      <div class="text-[11px] text-muted-foreground mt-2">
        During the dual-write window, stale-skips dominate — they mean the direct ingest path wrote first and the apply worker correctly stood down. Applied + Inserted = work the apply worker did on its own.
      </div>
    </UiCard>

    <!-- Recent raw -->
    <UiCard variant="surface" padding="none">
      <div class="px-3 py-2 border-b border-border font-medium text-foreground">Recent raw</div>
      <div v-if="loading" class="p-5 text-center text-meta">Loading…</div>
      <UiEmptyState
        v-else-if="recentRaw.length === 0"
        title="No raw rows yet"
        description="Once the modified ingest endpoint receives a partner push, rows appear here."
      />
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-muted/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Foreign id</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Ingested</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Normalized</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="r in recentRaw" :key="r.id">
              <td class="px-3 py-2 tabular-nums">#{{ r.source_id }}</td>
              <td class="px-3 py-2 font-mono text-xs">{{ r.foreign_id }}</td>
              <td class="px-3 py-2">
                <UiBadge :variant="rawVariant(r.normalize_status)">{{ r.normalize_status }}</UiBadge>
                <span v-if="r.rejection_reason" class="ml-2 text-[11px] text-muted-foreground">
                  {{ r.rejection_reason }}
                </span>
              </td>
              <td class="px-3 py-2 text-xs text-muted-foreground">{{ new Date(r.ingested_at).toLocaleString() }}</td>
              <td class="px-3 py-2 text-xs text-muted-foreground">
                {{ r.normalized_at ? new Date(r.normalized_at).toLocaleString() : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Recent normalized -->
    <UiCard variant="surface" padding="none">
      <div class="px-3 py-2 border-b border-border font-medium text-foreground">Recent normalized</div>
      <UiEmptyState
        v-if="recentNorm.length === 0 && !loading"
        title="No normalized rows yet"
        description="The /api/internal/normalize-raw-batch worker drains pending raw rows here. Schedule a 5-min cron on it once partner traffic ramps."
      />
      <div v-else-if="recentNorm.length > 0" class="overflow-x-auto">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-muted/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Listing</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Match</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Apply</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Resolved</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Ingested</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="n in recentNorm" :key="n.id">
              <td class="px-3 py-2 max-w-xs">
                <div class="text-foreground truncate">{{ n.title || '(no title)' }}</div>
                <div class="text-[11px] text-muted-foreground font-mono">{{ n.foreign_id }}</div>
              </td>
              <td class="px-3 py-2">
                <UiBadge :variant="matchVariant(n.match_status)">{{ n.match_status }}</UiBadge>
              </td>
              <td class="px-3 py-2">
                <UiBadge :variant="applyStateOf(n).variant">{{ applyStateOf(n).label }}</UiBadge>
              </td>
              <td class="px-3 py-2 text-xs">
                <span v-if="n.resolved_listing_id">listing #{{ n.resolved_listing_id }}</span>
                <span v-else-if="n.resolved_property_id">property #{{ n.resolved_property_id }}</span>
                <span v-else class="text-muted-foreground">—</span>
              </td>
              <td class="px-3 py-2 text-xs text-muted-foreground">{{ new Date(n.ingested_at).toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>
  </AdminPageShell>
</template>
