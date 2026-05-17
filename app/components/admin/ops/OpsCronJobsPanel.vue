<script setup lang="ts">
/**
 * Operator runbook — Cron jobs panel.
 *
 * One row per documented worker:
 *   * Health pill (healthy / slow / overdue / never_seen)
 *   * Last run + runs in last hour / day
 *   * Endpoint + auth env-var (for HTTP workers operators wire up)
 *   * Schedule hint
 *   * Drilldown into the last payload (json)
 *
 * Below the table: queue depth callout — pending outbound_emails +
 * pending ai_suggestions. Surfaces "queue is filling up but worker
 * is silent" pattern.
 *
 * Polls every 30s. Cheap query — single view + two count(*).
 */
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { showToast } from '~/helpers/helpers'

type Health = 'healthy' | 'slow' | 'overdue' | 'never_seen'
type Item = {
  worker_key: string
  label: string
  expected_interval_seconds: number
  last_recorded_at: string | null
  runs_last_hour: number | null
  runs_last_day: number | null
  last_payload: Record<string, unknown> | null
  health: Health
  meta: {
    endpoint: string | null
    schedule_hint: string
    auth_env: string | null
    description: string
    runner_kind: 'http_endpoint' | 'pg_cron'
  }
}

const items = ref<Item[]>([])
const triggering = ref<Record<string, boolean>>({})
const queues = ref<{
  outbound_emails_pending: number | null
  ai_suggestions_pending: number | null
} | null>(null)
const loading = ref(true)
const expanded = ref<Record<string, boolean>>({})
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      items: Item[]
      queues: { outbound_emails_pending: number | null; ai_suggestions_pending: number | null }
    }>('/api/admin/ops/cron-jobs')
    items.value = res.items
    queues.value = res.queues
  } catch {
    // Show stale data; OpsDomainPanels has its own error feed.
  } finally {
    loading.value = false
  }
}

const overdueCount = computed(() => items.value.filter((i) => i.health === 'overdue').length)

function healthClass(h: Health): string {
  switch (h) {
    case 'healthy':
      return 'bg-success/15 text-success'
    case 'slow':
      return 'bg-warning/15 text-warning'
    case 'overdue':
      return 'bg-destructive/15 text-destructive'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function fmtSince(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

async function triggerNow(workerKey: string) {
  triggering.value[workerKey] = true
  try {
    const res = await $fetch<{ ok: boolean; elapsed_ms: number; result: any }>(
      '/api/admin/ops/cron-jobs/trigger',
      {
        method: 'POST',
        body: { worker_key: workerKey },
      },
    )
    showToast({
      title: `${workerKey} ran in ${res.elapsed_ms}ms`,
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Trigger failed',
      icon: 'error',
    })
  } finally {
    triggering.value[workerKey] = false
  }
}

function fmtInterval(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

onMounted(async () => {
  await load()
  timer = setInterval(load, 30_000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
    <header class="mb-4 flex items-center justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold text-foreground">
          Cron jobs &amp; workers
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Each worker writes a heartbeat on every run. "never_seen" means the
          cron runner hasn't been wired up yet. "overdue" means it stopped.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="overdueCount > 0"
          class="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive"
        >
          {{ overdueCount }} overdue
        </span>
        <button
          type="button"
          class="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          @click="load"
        >
          Refresh
        </button>
      </div>
    </header>

    <!-- Queue depth strip -->
    <div
      v-if="queues"
      class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
    >
      <div class="rounded-lg border border-border bg-muted/50 px-3 py-2">
        <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Email queue</div>
        <div class="mt-0.5 text-lg font-semibold tabular-nums">
          {{ queues.outbound_emails_pending ?? '—' }}
        </div>
        <div class="text-[10px] text-muted-foreground">pending</div>
      </div>
      <div class="rounded-lg border border-border bg-muted/50 px-3 py-2">
        <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">AI queue</div>
        <div class="mt-0.5 text-lg font-semibold tabular-nums">
          {{ queues.ai_suggestions_pending ?? '—' }}
        </div>
        <div class="text-[10px] text-muted-foreground">pending</div>
      </div>
    </div>

    <div v-if="loading && items.length === 0" class="text-sm text-muted-foreground">Loading…</div>

    <div v-else class="overflow-x-auto">
      <table class="min-w-full divide-y divide-border text-sm">
        <thead class="bg-muted/40">
          <tr>
            <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Worker</th>
            <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Health</th>
            <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Last run</th>
            <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">1h / 24h</th>
            <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Cadence</th>
            <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Setup</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <template v-for="i in items" :key="i.worker_key">
            <tr
              class="cursor-pointer hover:bg-accent hover:text-accent-foreground"
              @click="expanded[i.worker_key] = !expanded[i.worker_key]"
            >
              <td class="px-3 py-2">
                <div class="font-medium text-foreground">{{ i.label }}</div>
                <div class="font-mono text-[10px] text-muted-foreground">{{ i.worker_key }}</div>
                <div class="mt-0.5 text-xs text-muted-foreground">{{ i.meta.description }}</div>
              </td>
              <td class="px-3 py-2">
                <span
                  class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize"
                  :class="healthClass(i.health)"
                >
                  {{ i.health.replace('_', ' ') }}
                </span>
              </td>
              <td class="px-3 py-2 text-xs text-foreground">
                {{ fmtSince(i.last_recorded_at) }}
              </td>
              <td class="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                {{ i.runs_last_hour ?? 0 }} / {{ i.runs_last_day ?? 0 }}
              </td>
              <td class="px-3 py-2 text-xs text-muted-foreground">
                {{ i.meta.schedule_hint }}
                <div class="text-[10px] text-muted-foreground">expects â‰¤ {{ fmtInterval(i.expected_interval_seconds) }}</div>
              </td>
              <td class="px-3 py-2 text-xs">
                <div v-if="i.meta.runner_kind === 'http_endpoint'">
                  <code class="font-mono text-[11px]">POST {{ i.meta.endpoint }}</code>
                  <div class="text-[10px] text-muted-foreground">
                    Bearer: <code class="font-mono">{{ i.meta.auth_env }}</code>
                  </div>
                  <button
                    type="button"
                    :disabled="triggering[i.worker_key]"
                    class="mt-1.5 rounded-md bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
                    @click.stop="triggerNow(i.worker_key)"
                  >
                    {{ triggering[i.worker_key] ? 'Running…' : 'â–¶ Run now' }}
                  </button>
                </div>
                <div v-else class="text-muted-foreground">pg_cron (DB-internal)</div>
              </td>
            </tr>
            <tr v-if="expanded[i.worker_key]">
              <td colspan="6" class="bg-muted/50 px-3 py-3 ">
                <div class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Last payload
                </div>
                <pre class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 text-[11px] text-foreground">{{ JSON.stringify(i.last_payload ?? {}, null, 2) }}</pre>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>
