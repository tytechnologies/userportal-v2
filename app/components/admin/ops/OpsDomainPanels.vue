<script setup lang="ts">
/**
 * Per-domain health panels for /admin/operations.
 *
 * Reads /api/admin/ops/domain-health — one RPC, six domain sections.
 * Each domain renders as a card with KPI tiles + a small drilldown
 * table of "top problems" (failing subscriptions / stale sources /
 * failing crons / heaviest rate-limit buckets / top notification
 * kinds / recent MV refresh history).
 *
 * Why a single combined component instead of 6 files: the layout +
 * KPI-tile pattern is identical per domain; splitting them would
 * just duplicate scaffolding without isolating any real concern.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { showToast } from '~/helpers/helpers'

type Health = {
  captured_at: string
  webhooks: any
  ingest: any
  cron: any
  rate_limits: any
  notifications: any
  search: any
}

const data = ref<Health | null>(null)
const loading = ref(true)
const errorMsg = ref<string | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    const res = await $fetch<Health>('/api/admin/ops/domain-health')
    data.value = res
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to load domain health'
    showToast({ title: errorMsg.value ?? '', icon: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  // 60s — same cadence as the time-series chart. Most domain KPIs
  // change on cron-driven boundaries; tighter polling is wasted.
  pollTimer = setInterval(load, 60_000)
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function formatTs(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 0) return d.toLocaleString()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString()
}

const webhooks = computed(() => data.value?.webhooks)
const ingest = computed(() => data.value?.ingest)
const cron = computed(() => data.value?.cron)
const rateLimits = computed(() => data.value?.rate_limits)
const notifications = computed(() => data.value?.notifications)
const search = computed(() => data.value?.search)
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-sm font-semibold text-foreground">Domain health</p>
      <p v-if="data" class="text-xs text-muted-foreground">
        {{ formatTs(data.captured_at) }}
      </p>
      <button
        type="button"
        class="ml-auto rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>

    <div
      v-if="loading && !data"
      class="rounded-md border border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      Loading…
    </div>
    <div
      v-else-if="errorMsg && !data"
      class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
    >
      {{ errorMsg }}
    </div>
    <div
      v-else-if="data"
      class="grid grid-cols-1 gap-4 md:grid-cols-2"
    >
      <!-- WEBHOOKS -->
      <article class="rounded-lg border border-border bg-background p-3">
        <header class="mb-2 flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-foreground">Webhooks</h3>
          <NuxtLink
            to="/admin?tab=webhooks"
            class="text-xs font-semibold text-primary hover:underline"
          >
            Open →
          </NuxtLink>
        </header>
        <dl class="grid grid-cols-4 gap-2 text-xs">
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Enabled</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(webhooks?.subscriptions_enabled) }}</dd>
          </div>
          <div
            class="rounded-md p-2"
            :class="webhooks?.subscriptions_failing > 0 ? 'bg-destructive/10' : 'bg-muted/50'"
          >
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Failing</dt>
            <dd class="text-sm font-semibold tabular-nums" :class="webhooks?.subscriptions_failing > 0 ? 'text-destructive' : ''">
              {{ fmtNum(webhooks?.subscriptions_failing) }}
            </dd>
          </div>
          <div
            class="rounded-md p-2"
            :class="webhooks?.retry_queue_stale > 0 ? 'bg-warning/10' : 'bg-muted/50'"
          >
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Retry queue</dt>
            <dd class="text-sm font-semibold tabular-nums">
              {{ fmtNum(webhooks?.retry_queue_depth) }}
              <span v-if="webhooks?.retry_queue_stale > 0" class="text-[10px] font-normal text-warning">
                ({{ webhooks.retry_queue_stale }} stale)
              </span>
            </dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">24h</dt>
            <dd class="text-sm font-semibold tabular-nums">
              {{ fmtNum(webhooks?.deliveries_24h) }}
              <span v-if="webhooks?.deliveries_24h_failed > 0" class="text-[10px] font-normal text-destructive">
                ({{ webhooks.deliveries_24h_failed }} failed)
              </span>
            </dd>
          </div>
        </dl>
        <div v-if="webhooks?.top_failing?.length" class="mt-3">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Top failing subscriptions
          </p>
          <ul class="space-y-1 text-xs">
            <li
              v-for="(f, i) in webhooks.top_failing"
              :key="`wh-${i}`"
              class="flex items-baseline gap-2 rounded bg-destructive/10 px-2 py-1"
            >
              <code class="font-mono text-[11px] text-destructive">{{ f.name }}</code>
              <span class="ml-auto text-[10px] text-destructive">{{ f.consecutive_failures }} fails</span>
            </li>
          </ul>
        </div>
      </article>

      <!-- INGEST -->
      <article class="rounded-lg border border-border bg-background p-3">
        <header class="mb-2 flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-foreground">Ingest</h3>
          <NuxtLink
            to="/admin?tab=sources"
            class="text-xs font-semibold text-primary hover:underline"
          >
            Open →
          </NuxtLink>
        </header>
        <dl class="grid grid-cols-4 gap-2 text-xs">
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Enabled</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(ingest?.sources_enabled) }}</dd>
          </div>
          <div
            class="rounded-md p-2"
            :class="ingest?.sources_stale > 0 ? 'bg-warning/10' : 'bg-muted/50'"
          >
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Stale</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(ingest?.sources_stale) }}</dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Runs 24h</dt>
            <dd class="text-sm font-semibold tabular-nums">
              {{ fmtNum(ingest?.runs_24h) }}
              <span v-if="ingest?.runs_24h_with_errors > 0" class="text-[10px] font-normal text-destructive">
                ({{ ingest.runs_24h_with_errors }} err)
              </span>
            </dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Rows 24h</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(ingest?.rows_processed_24h) }}</dd>
          </div>
        </dl>
        <div v-if="ingest?.top_stale?.length" class="mt-3">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Stale sources
          </p>
          <ul class="space-y-1 text-xs">
            <li
              v-for="(s, i) in ingest.top_stale"
              :key="`ing-${i}`"
              class="flex items-baseline gap-2 rounded bg-warning/10 px-2 py-1"
            >
              <code class="font-mono text-[11px] text-warning">{{ s.slug }}</code>
              <span class="ml-auto text-[10px] text-warning">
                {{ s.last_ingested_at ? formatTs(s.last_ingested_at) : 'never' }}
              </span>
            </li>
          </ul>
        </div>
      </article>

      <!-- CRON -->
      <article class="rounded-lg border border-border bg-background p-3">
        <header class="mb-2 flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-foreground">Cron</h3>
          <span v-if="cron?.note" class="text-[10px] text-muted-foreground/70">{{ cron.note }}</span>
        </header>
        <dl class="grid grid-cols-4 gap-2 text-xs">
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Active</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(cron?.jobs_active) }}</dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Total</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(cron?.jobs_total) }}</dd>
          </div>
          <div
            class="rounded-md p-2"
            :class="cron?.jobs_last_failed > 0 ? 'bg-destructive/10' : 'bg-muted/50'"
          >
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Last failed</dt>
            <dd class="text-sm font-semibold tabular-nums" :class="cron?.jobs_last_failed > 0 ? 'text-destructive' : ''">
              {{ fmtNum(cron?.jobs_last_failed) }}
            </dd>
          </div>
          <div
            class="rounded-md p-2"
            :class="cron?.jobs_stale > 0 ? 'bg-warning/10' : 'bg-muted/50'"
          >
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Stale</dt>
            <dd class="text-sm font-semibold tabular-nums" :class="cron?.jobs_stale > 0 ? 'text-warning' : ''">
              {{ fmtNum(cron?.jobs_stale) }}
            </dd>
          </div>
        </dl>
        <div v-if="cron?.top_problems?.length" class="mt-3">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Problem jobs
          </p>
          <ul class="space-y-1 text-xs">
            <li
              v-for="(p, i) in cron.top_problems"
              :key="`cron-${i}`"
              class="rounded bg-muted/50 px-2 py-1"
            >
              <div class="flex items-baseline gap-2">
                <code class="font-mono text-[11px] text-foreground">{{ p.jobname }}</code>
                <span
                  class="ml-auto text-[10px] font-semibold uppercase"
                  :class="p.status === 'failed' ? 'text-destructive' : 'text-warning'"
                >
                  {{ p.status || 'never run' }}
                </span>
              </div>
              <p class="text-[10px] text-muted-foreground">
                {{ p.last_start ? formatTs(p.last_start) : 'no run history' }}
              </p>
            </li>
          </ul>
        </div>
      </article>

      <!-- RATE LIMITS -->
      <article class="rounded-lg border border-border bg-background p-3">
        <header class="mb-2 flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-foreground">Rate limits</h3>
        </header>
        <dl class="grid grid-cols-3 gap-2 text-xs">
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Active 5m</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(rateLimits?.active_5m) }}</dd>
          </div>
          <div
            class="rounded-md p-2"
            :class="rateLimits?.heavy_keys > 0 ? 'bg-warning/10' : 'bg-muted/50'"
          >
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Heavy keys</dt>
            <dd class="text-sm font-semibold tabular-nums" :class="rateLimits?.heavy_keys > 0 ? 'text-warning' : ''">
              {{ fmtNum(rateLimits?.heavy_keys) }}
            </dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Buckets</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(rateLimits?.buckets_total) }}</dd>
          </div>
        </dl>
        <div v-if="rateLimits?.top_buckets?.length" class="mt-3">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Top buckets (last 15m)
          </p>
          <ul class="space-y-1 text-xs">
            <li
              v-for="(b, i) in rateLimits.top_buckets"
              :key="`rl-${i}`"
              class="flex items-baseline gap-2 rounded bg-muted/50 px-2 py-1"
            >
              <code class="font-mono text-[11px] text-foreground truncate">{{ b.bucket_key }}</code>
              <span class="ml-auto text-[10px] text-foreground">{{ fmtNum(b.request_count) }} reqs</span>
            </li>
          </ul>
        </div>
      </article>

      <!-- NOTIFICATIONS -->
      <article class="rounded-lg border border-border bg-background p-3">
        <header class="mb-2 flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-foreground">Notifications</h3>
        </header>
        <dl class="grid grid-cols-4 gap-2 text-xs">
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">24h</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(notifications?.total_24h) }}</dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Unread 24h</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(notifications?.unread_24h) }}</dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Dismissed</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(notifications?.dismissed_24h) }}</dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Unread total</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(notifications?.unread_all_time) }}</dd>
          </div>
        </dl>
        <div v-if="notifications?.top_kinds?.length" class="mt-3">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Top kinds (24h)
          </p>
          <ul class="space-y-1 text-xs">
            <li
              v-for="(k, i) in notifications.top_kinds"
              :key="`nk-${i}`"
              class="flex items-baseline gap-2 rounded bg-muted/50 px-2 py-1"
            >
              <code class="font-mono text-[11px] text-foreground">{{ k.kind }}</code>
              <span class="ml-auto text-[10px] text-foreground">{{ fmtNum(k.count) }}</span>
            </li>
          </ul>
        </div>
      </article>

      <!-- SEARCH / MV -->
      <article class="rounded-lg border border-border bg-background p-3">
        <header class="mb-2 flex items-baseline justify-between">
          <h3 class="text-sm font-semibold text-foreground">Search index</h3>
          <span v-if="search?.note" class="text-[10px] text-muted-foreground/70">{{ search.note }}</span>
        </header>
        <dl class="grid grid-cols-3 gap-2 text-xs">
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Rows</dt>
            <dd class="text-sm font-semibold tabular-nums">{{ fmtNum(search?.mv_row_count) }}</dd>
          </div>
          <div class="rounded-md bg-muted/50 p-2">
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Last refresh</dt>
            <dd class="text-sm font-semibold">{{ formatTs(search?.last_refresh) }}</dd>
          </div>
          <div
            class="rounded-md p-2"
            :class="search?.last_status === 'failed' ? 'bg-destructive/10' : 'bg-muted/50'"
          >
            <dt class="text-[10px] uppercase tracking-wide text-muted-foreground">Last status</dt>
            <dd class="text-sm font-semibold" :class="search?.last_status === 'failed' ? 'text-destructive' : ''">
              {{ search?.last_status || '—' }}
            </dd>
          </div>
        </dl>
        <div v-if="search?.recent_refreshes?.length" class="mt-3">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Recent refreshes
          </p>
          <ul class="space-y-1 text-xs">
            <li
              v-for="(r, i) in search.recent_refreshes"
              :key="`mv-${i}`"
              class="flex items-baseline gap-2 rounded px-2 py-1"
              :class="r.status === 'failed' ? 'bg-destructive/10' : 'bg-muted/50'"
            >
              <span class="text-[11px]">{{ formatTs(r.started_at) }}</span>
              <span
                class="ml-auto text-[10px] font-semibold uppercase"
                :class="r.status === 'failed' ? 'text-destructive' : 'text-success'"
              >
                {{ r.status }}
              </span>
            </li>
          </ul>
        </div>
      </article>
    </div>
  </section>
</template>
