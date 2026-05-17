<script setup lang="ts">
/**
 * Admin — hybrid live-search dashboard.
 *
 * Surfaces:
 *   - Connector toggles + trust scoring + daily budget.
 *   - Cache health (size, expired %, hit count).
 *   - 24h event rollup (p50/p95 latencies, degraded %, dedup totals).
 *   - Candidate corpus rollup (operator state, dedup state).
 *
 * Read-only metrics + a few action buttons (toggle connector, purge
 * cache, sweep events). Mirrors the [[admin-page-primitive-recipe]].
 */

definePageMeta({ layout: 'default' })
useHead({ title: 'Live search · Admin' })

import { ref, computed } from 'vue'

type Overview = {
  connectors: Array<{
    slug: string; display_name: string; provider_kind: string;
    enabled: boolean; trust_score: number; daily_budget: number;
    default_ttl_seconds: number; notes: string | null; updated_at: string;
  }>
  cache_stats: {
    total: number; expired: number; hits: number;
    by_provider: Record<string, { rows: number; expired: number; hits: number }>
  }
  events_24h: null | {
    total: number; degraded: number; degraded_pct: number;
    internal_p50: number | null; internal_p95: number | null;
    external_p50: number | null; external_p95: number | null;
    total_p50:    number | null; total_p95:    number | null;
    dedup_total:  number;
    internal_total: number; external_total: number;
    provider_appearances: Record<string, number>;
  }
  candidates: {
    by_operator_status: Record<string, number>;
    by_dedup_status:    Record<string, number>;
  }
  degraded?: boolean
}

const { data, refresh, pending } = await useFetch<Overview>(
  '/api/admin/live-search/overview',
  { server: false, default: () => null as Overview | null },
)

const overview = computed<Overview | null>(() => data.value)

const busy = ref<string | null>(null)
async function toggleConnector(slug: string, enabled: boolean) {
  busy.value = slug
  try {
    await $fetch('/api/admin/live-search/connectors', {
      method: 'PATCH',
      body: { slug, enabled },
    })
    await refresh()
  } catch (err) {
    console.error('toggleConnector failed', err)
  } finally {
    busy.value = null
  }
}

async function purgeAllExpired() {
  busy.value = 'purge'
  try {
    await $fetch('/api/admin/live-search/cache-purge', {
      method: 'POST',
      body: { sweep_events: false },
    })
    await refresh()
  } finally {
    busy.value = null
  }
}

async function purgeProvider(slug: string) {
  if (!confirm(`Force re-fetch by purging cached rows for ${slug}?`)) return
  busy.value = slug
  try {
    await $fetch('/api/admin/live-search/cache-purge', {
      method: 'POST',
      body: { provider_slug: slug },
    })
    await refresh()
  } finally {
    busy.value = null
  }
}

function fmtMs(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${Math.round(n)}ms`
}
</script>

<template>
  <AdminPageShell max-width="wide">
    <UiPageHeader
      title="Live search"
      description="Hybrid orchestrator: internal-first, external-enriched. Tune connectors, watch cache, and trace degraded queries."
    >
      <template #actions>
        <UiButton variant="ghost" :disabled="pending" @click="refresh()">
          Refresh
        </UiButton>
        <UiButton
          variant="outline"
          :disabled="busy === 'purge'"
          @click="purgeAllExpired"
        >
          Sweep expired cache
        </UiButton>
      </template>
    </UiPageHeader>

    <div v-if="!overview" class="grid place-items-center py-12">
      <UiEmptyState title="No data yet" description="The hybrid search hasn't recorded any events." />
    </div>

    <div v-else class="grid gap-6">
      <!-- KPIs -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <UiStatCard
          label="Internal p95"
          :value="fmtMs(overview.events_24h?.internal_p95)"
          :description="`p50 ${fmtMs(overview.events_24h?.internal_p50)}`"
        />
        <UiStatCard
          label="External p95"
          :value="fmtMs(overview.events_24h?.external_p95)"
          :description="`p50 ${fmtMs(overview.events_24h?.external_p50)}`"
        />
        <UiStatCard
          label="Degraded queries"
          :value="`${overview.events_24h?.degraded ?? 0}`"
          :description="`${overview.events_24h?.degraded_pct ?? 0}% of last 24h`"
        />
        <UiStatCard
          label="Dedup collapses"
          :value="`${overview.events_24h?.dedup_total ?? 0}`"
          :description="`${overview.events_24h?.external_total ?? 0} external hits surfaced`"
        />
      </div>

      <!-- Connectors -->
      <UiCard>
        <template #header>
          <h2 class="text-h3">Connectors</h2>
          <p class="text-meta text-muted-foreground">
            Disable to stop live calls; trust score nudges ranking weight; budget caps daily burn.
          </p>
        </template>
        <table class="w-full text-sm">
          <thead class="text-meta text-muted-foreground">
            <tr>
              <th class="text-left py-2 px-3">Slug</th>
              <th class="text-left">Kind</th>
              <th class="text-right">Trust</th>
              <th class="text-right">Daily budget</th>
              <th class="text-right">TTL</th>
              <th class="text-left px-3">Status</th>
              <th />
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="c in overview.connectors" :key="c.slug">
              <td class="py-2 px-3 font-medium">{{ c.display_name }}<br>
                <span class="text-meta text-muted-foreground">{{ c.slug }}</span>
              </td>
              <td>{{ c.provider_kind }}</td>
              <td class="text-right">{{ c.trust_score }}</td>
              <td class="text-right">{{ c.daily_budget.toLocaleString() }}</td>
              <td class="text-right">{{ Math.round(c.default_ttl_seconds / 60) }}min</td>
              <td class="px-3">
                <UiBadge :variant="c.enabled ? 'success' : 'neutral'">
                  {{ c.enabled ? 'Enabled' : 'Disabled' }}
                </UiBadge>
              </td>
              <td class="text-right pr-3">
                <!-- Solid CTA when disabled (the action they want);
                     subtle ghost when enabled (state already correct,
                     just an off-ramp). Makes the toggle visually
                     unambiguous on first scan. -->
                <UiButton
                  size="sm"
                  :variant="c.enabled ? 'outline' : 'default'"
                  :disabled="busy === c.slug"
                  @click="toggleConnector(c.slug, !c.enabled)"
                >
                  {{ busy === c.slug ? '…' : c.enabled ? 'Disable' : 'Enable' }}
                </UiButton>
                <UiButton
                  size="sm"
                  variant="ghost"
                  :disabled="busy === c.slug"
                  @click="purgeProvider(c.slug)"
                >
                  Purge
                </UiButton>
              </td>
            </tr>
          </tbody>
        </table>
        <UiEmptyState
          v-if="overview.connectors.length === 0"
          title="No connectors yet"
          description="Seed `tavily_ph_real_estate` (migration 20260514000002) and enable it from here."
        />
      </UiCard>

      <!-- Cache + candidates -->
      <div class="grid md:grid-cols-2 gap-6">
        <UiCard>
          <template #header>
            <h2 class="text-h3">Cache</h2>
            <p class="text-meta text-muted-foreground">
              live_search_cache — {{ overview.cache_stats.total.toLocaleString() }} rows,
              {{ overview.cache_stats.expired.toLocaleString() }} expired,
              {{ overview.cache_stats.hits.toLocaleString() }} cumulative hits.
            </p>
          </template>
          <ul class="grid gap-2 text-sm">
            <li
              v-for="(stats, slug) in overview.cache_stats.by_provider"
              :key="slug"
              class="flex items-center justify-between"
            >
              <span>{{ slug }}</span>
              <span class="text-muted-foreground">
                {{ stats.rows }} rows · {{ stats.expired }} expired · {{ stats.hits }} hits
              </span>
            </li>
          </ul>
        </UiCard>

        <UiCard>
          <template #header>
            <h2 class="text-h3">Candidates</h2>
            <p class="text-meta text-muted-foreground">
              external_listing_candidates — operator + dedup state breakdown.
            </p>
          </template>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p class="font-medium mb-1">Operator</p>
              <ul>
                <li
                  v-for="(n, s) in overview.candidates.by_operator_status"
                  :key="s"
                  class="flex justify-between"
                >
                  <span>{{ s }}</span>
                  <span class="text-muted-foreground">{{ n }}</span>
                </li>
              </ul>
            </div>
            <div>
              <p class="font-medium mb-1">Dedup</p>
              <ul>
                <li
                  v-for="(n, s) in overview.candidates.by_dedup_status"
                  :key="s"
                  class="flex justify-between"
                >
                  <span>{{ s }}</span>
                  <span class="text-muted-foreground">{{ n }}</span>
                </li>
              </ul>
            </div>
          </div>
        </UiCard>
      </div>

      <UiCard v-if="overview.degraded">
        <template #header>
          <h2 class="text-h3">Degraded</h2>
        </template>
        <p class="text-sm text-muted-foreground">
          Some rollups failed to load — usually the migration hasn't been applied
          in this environment, or the service-role key isn't set. Check server
          logs for the failing query.
        </p>
      </UiCard>
    </div>
  </AdminPageShell>
</template>
