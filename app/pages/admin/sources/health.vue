<script setup lang="ts">
/**
 * /admin/sources/health — partner ingest SLO dashboard.
 *
 * Reads from public.source_health (mig 510000006) populated by
 * record_source_health (mig 513000003), called from
 * /api/admin/listings/ingest after every batch.
 *
 * Columns:
 *   alert_state         — ok / warning / alert / no_data
 *   rolling_success_pct — over the last 50 ingest runs
 *   consecutive_failures
 *   last_success_at / last_failure_at
 *   avg_duration_ms     — EWMA over recent runs
 *
 * Sources with no health row yet (e.g. just registered, no ingest
 * traffic yet) render as alert_state='no_data' with all metrics blank.
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
useHead({ title: 'Source Health | Admin' })

type SourceHealth = {
  id: number
  slug: string
  display_name: string | null
  enabled: boolean
  last_ingested_at: string | null
  staleness_ttl_hours: number | null
  last_success_at: string | null
  last_failure_at: string | null
  consecutive_failures: number
  rolling_success_pct: number | null
  avg_duration_ms: number | null
  alert_state: 'ok' | 'warning' | 'alert' | 'no_data'
  health_updated_at: string | null
}

type Summary = {
  total: number
  enabled: number
  alerting: number
  warning: number
}

const sources = ref<SourceHealth[]>([])
const summary = ref<Summary>({ total: 0, enabled: 0, alerting: 0, warning: 0 })
const loading = ref(false)

const alertVariant = (state: SourceHealth['alert_state']) => {
  if (state === 'alert') return 'destructive' as const
  if (state === 'warning') return 'warning' as const
  if (state === 'ok') return 'success' as const
  return 'neutral' as const
}

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ sources: SourceHealth[]; summary: Summary }>(
      '/api/admin/sources/health',
    )
    sources.value = res.sources ?? []
    summary.value = res.summary ?? { total: 0, enabled: 0, alerting: 0, warning: 0 }
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load source health', icon: 'error' })
  } finally {
    loading.value = false
  }
}

function durationMs(n: number | null): string {
  if (n == null) return '—'
  if (n < 1000) return `${n}ms`
  return `${(n / 1000).toFixed(1)}s`
}

function pct(n: number | null): string {
  if (n == null) return '—'
  return `${Number(n).toFixed(1)}%`
}

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['admin.access']" max-width="wide">
    <UiPageHeader
      title="Source Health"
      description="Per-source ingest SLOs. last_success / last_failure / consecutive failures / rolling success rate. Updated automatically by the ingest endpoint on every batch — pure observability, no operator action required unless alert_state is firing."
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

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <UiStatCard label="Sources" :value="summary.total" />
      <UiStatCard label="Enabled" :value="summary.enabled" tone="success" />
      <UiStatCard
        label="Warning"
        :value="summary.warning"
        :tone="summary.warning > 0 ? 'warning' : 'neutral'"
      />
      <UiStatCard
        label="Alerting"
        :value="summary.alerting"
        :tone="summary.alerting > 0 ? 'destructive' : 'neutral'"
      />
    </div>

    <UiCard variant="surface" padding="none">
      <div v-if="loading" class="p-5 text-center text-meta">Loading…</div>
      <UiEmptyState
        v-else-if="sources.length === 0"
        title="No partner sources registered"
        description="Sources are managed via /admin/sources (CRUD) and start showing health after the first ingest call."
      />
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-muted/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">State</th>
              <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Success %</th>
              <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Consecutive failures</th>
              <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Avg duration</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Last success</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Last failure</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Last ingest</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="s in sources" :key="s.id" :class="!s.enabled ? 'opacity-60' : ''">
              <td class="px-3 py-2">
                <div class="font-medium text-foreground">{{ s.display_name || s.slug }}</div>
                <div class="text-[11px] text-muted-foreground font-mono">{{ s.slug }}</div>
              </td>
              <td class="px-3 py-2">
                <UiBadge :variant="alertVariant(s.alert_state)">
                  {{ s.alert_state.replace('_', ' ') }}
                </UiBadge>
                <UiBadge v-if="!s.enabled" variant="neutral" class="ml-2">
                  disabled
                </UiBadge>
              </td>
              <td class="px-3 py-2 text-right tabular-nums">{{ pct(s.rolling_success_pct) }}</td>
              <td
                class="px-3 py-2 text-right tabular-nums"
                :class="s.consecutive_failures > 0 ? 'text-destructive' : ''"
              >
                {{ s.consecutive_failures }}
              </td>
              <td class="px-3 py-2 text-right tabular-nums">{{ durationMs(s.avg_duration_ms) }}</td>
              <td class="px-3 py-2 text-xs text-muted-foreground">
                {{ s.last_success_at ? new Date(s.last_success_at).toLocaleString() : '—' }}
              </td>
              <td class="px-3 py-2 text-xs text-muted-foreground">
                {{ s.last_failure_at ? new Date(s.last_failure_at).toLocaleString() : '—' }}
              </td>
              <td class="px-3 py-2 text-xs text-muted-foreground">
                {{ s.last_ingested_at ? new Date(s.last_ingested_at).toLocaleString() : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>
  </AdminPageShell>
</template>
