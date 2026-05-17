<script setup lang="ts">
/**
 * Operator-side pipeline alerts widget.
 *
 * Reads /api/automation/pipeline-alerts?mine=true. Mirrors the
 * server-health alert feed but for broker workflows: stale deals,
 * unanswered inquiries, viewings not marked complete, etc.
 *
 * 30s polling — workflow alerts don't need to be fresh-by-the-second,
 * but dashboard glance frequency rewards a short-ish refresh.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

type Alert = {
  key: string
  severity: 'critical' | 'warning' | 'info'
  category: 'inquiry' | 'deal' | 'viewing'
  owner_user_id: string | null
  title: string
  detail: string | null
  metadata: Record<string, unknown> | null
  started_at: string
}

const alerts = ref<Alert[]>([])
const counts = ref({ critical: 0, warning: 0, info: 0 })
const loading = ref(true)
const errored = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function load() {
  errored.value = false
  try {
    const res = await $fetch<{ data: Alert[]; counts: typeof counts.value }>(
      '/api/automation/pipeline-alerts',
      { query: { mine: true, limit: 50 } },
    )
    alerts.value = res.data ?? []
    counts.value = res.counts ?? { critical: 0, warning: 0, info: 0 }
  } catch {
    // Persistent error card instead of a transient toast — a toast
    // disappears in 5s and then the widget falls back to the success
    // empty state ("No pipeline alerts"), which is indistinguishable
    // from healthy. An inline error keeps the broker informed.
    errored.value = true
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  pollTimer = setInterval(load, 30_000)
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`
  return `${Math.round(diffMs / 86_400_000)}d ago`
}

function dotClass(s: Alert['severity']): string {
  return s === 'critical' ? 'bg-destructive'
       : s === 'warning'  ? 'bg-warning'
       : 'bg-primary'
}

function alertHref(a: Alert): string | null {
  const m = a.metadata || {}
  if (a.category === 'deal' && m.deal_id) return `/deals/${m.deal_id}`
  if (a.category === 'inquiry') return `/inquiries${m.inquiry_id ? `?id=${m.inquiry_id}` : ''}`
  if (a.category === 'viewing' && m.deal_id) return `/deals/${m.deal_id}`
  return null
}

const isEmpty = computed(() => !loading.value && alerts.value.length === 0)
const totalCount = computed(() =>
  counts.value.critical + counts.value.warning + counts.value.info,
)
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <header class="mb-3 flex items-baseline justify-between">
      <div>
        <p class="text-sm font-semibold text-foreground">Pipeline alerts</p>
        <p class="text-xs text-muted-foreground">
          Stale deals, unanswered inquiries, missing follow-ups.
        </p>
      </div>
      <div class="flex items-center gap-1">
        <span
          v-if="counts.critical > 0"
          class="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive"
        >{{ counts.critical }} critical</span>
        <span
          v-if="counts.warning > 0"
          class="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning"
        >{{ counts.warning }} warn</span>
      </div>
    </header>

    <div
      v-if="loading && alerts.length === 0"
      class="rounded-md border border-border bg-muted/50 p-4 text-xs text-muted-foreground"
    >
      Loading…
    </div>
    <div
      v-else-if="errored"
      class="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs"
    >
      <div class="flex-1">
        <p class="font-semibold text-destructive">Could not load alerts</p>
        <p class="mt-0.5 text-muted-foreground">
          Refresh, or it will auto-retry in a moment (polls every 30s).
        </p>
      </div>
      <button
        type="button"
        class="shrink-0 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:bg-accent focus-ring"
        @click="load"
      >
        Retry
      </button>
    </div>
    <div
      v-else-if="isEmpty"
      class="flex flex-col items-center justify-center gap-1.5 rounded-md border border-success/30 bg-success/10 p-4 text-center text-xs text-success"
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M16 6L8 14l-4-4" />
        <circle cx="10" cy="10" r="9" />
      </svg>
      <span>No pipeline alerts. Nothing's overdue.</span>
    </div>
    <ul v-else class="space-y-2">
      <li
        v-for="a in alerts"
        :key="a.key"
        class="rounded-md border border-border bg-muted/40 p-2"
      >
        <div class="flex items-start gap-2">
          <span
            class="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
            :class="dotClass(a.severity)"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold text-foreground">{{ a.title }}</p>
            <p
              v-if="a.detail"
              class="mt-0.5 text-xs text-muted-foreground truncate"
            >
              {{ a.detail }}
            </p>
            <div class="mt-1 flex items-center gap-2">
              <span class="text-[10px] uppercase tracking-wide text-muted-foreground">
                {{ a.category }}
              </span>
              <span class="text-[10px] text-muted-foreground">
                {{ formatTs(a.started_at) }}
              </span>
              <NuxtLink
                v-if="alertHref(a)"
                :to="alertHref(a)!"
                class="ml-auto text-[10px] font-semibold text-primary hover:underline"
              >
                Open →
              </NuxtLink>
            </div>
          </div>
        </div>
      </li>
    </ul>

    <p
      v-if="totalCount > alerts.length"
      class="mt-2 text-[10px] text-muted-foreground/70"
    >
      Showing top {{ alerts.length }} of {{ totalCount }}.
    </p>
  </section>
</template>
