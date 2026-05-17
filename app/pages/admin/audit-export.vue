<script setup lang="ts">
/**
 * /admin/audit-export — compliance audit log export.
 *
 * Phase E foundation. Operator picks a date range + optional action
 * prefix filter, then downloads CSV (default) or previews JSON.
 *
 * Backed by the existing `activities` table — the canonical audit
 * log that every domain repo writes to via logActivity(). Future
 * compliance work can extend with envelope_audit_events,
 * payment_gateway_events, journal entries — but those have their
 * own dedicated views already.
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Audit Log Export | Admin' })

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const today = new Date().toISOString().slice(0, 10)
const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

const since = ref(thirtyDaysAgo)
const until = ref(today)
const actionPrefix = ref('')
const source = ref<
  | 'activities'
  | 'envelope_events'
  | 'payment_events'
  | 'commission_ledger'
  | 'journal_entries'
  | 'all'
>('activities')

const sourceOptions: Array<{ value: typeof source.value; label: string; hint: string }> = [
  { value: 'activities', label: 'Activities (default)', hint: 'logActivity() entries' },
  { value: 'envelope_events', label: 'Envelope events', hint: 'sign / decline / void' },
  { value: 'payment_events', label: 'Payment webhooks', hint: 'PayMongo / Maya callbacks' },
  { value: 'commission_ledger', label: 'Commission ledger', hint: 'created / posted / voided' },
  { value: 'journal_entries', label: 'Journal entries', hint: 'GL header rows' },
  { value: 'all', label: 'All sources (merged)', hint: 'normalised by occurred_at' },
]

const previewing = ref(false)
const previewRows = ref<
  Array<{
    occurred_at: string
    actor_user_id: string | null
    action: string
    entity: string | null
    entity_id: string | null
    metadata: Record<string, unknown>
  }>
>([])
const previewMeta = ref<{ row_count: number; since: string; until: string } | null>(null)

async function preview() {
  previewing.value = true
  previewRows.value = []
  previewMeta.value = null
  try {
    const params: Record<string, string> = {
      since: since.value,
      until: until.value,
      format: 'json',
      source: source.value,
    }
    if (actionPrefix.value.trim()) params.action_prefix = actionPrefix.value.trim()
    const res = await $fetch<{
      row_count: number
      since: string
      until: string
      items: any[]
    }>('/api/admin/audit-log/export', { query: params })
    previewMeta.value = { row_count: res.row_count, since: res.since, until: res.until }
    previewRows.value = res.items.slice(0, 100)
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Preview failed', icon: 'error' })
  } finally {
    previewing.value = false
  }
}

function downloadCsv() {
  // Use a navigation rather than $fetch so the browser handles the
  // attachment download natively.
  const params = new URLSearchParams({
    since: since.value,
    until: until.value,
    format: 'csv',
    source: source.value,
  })
  if (actionPrefix.value.trim()) params.set('action_prefix', actionPrefix.value.trim())
  window.location.href = `/api/admin/audit-log/export?${params.toString()}`
}

const dayCount = computed(() => {
  const a = new Date(since.value).getTime()
  const b = new Date(until.value).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0
  return Math.round((b - a) / 86_400_000) + 1
})

onMounted(async () => {
  const ok = await hasPermission('admin.access')
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <header>
        <h1 class="text-page-title">
          Audit Log Export
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Compliance + SOC2-friendly export of every audited action across the platform.
          Pull a date window as CSV for legal review or annual audit packets.
        </p>
      </header>

      <section class="rounded-lg border border-border bg-card p-5 text-card-foreground">
        <label class="mb-3 block">
          <span class="block text-xs font-medium text-muted-foreground">Source</span>
          <select
            v-model="source"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          >
            <option v-for="opt in sourceOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }} — {{ opt.hint }}
            </option>
          </select>
        </label>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Since</span>
            <input
              v-model="since"
              type="date"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Until</span>
            <input
              v-model="until"
              type="date"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">
              Action prefix (optional)
            </span>
            <input
              v-model="actionPrefix"
              type="text"
              maxlength="40"
              placeholder="e.g., lease., commission., envelope."
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <p class="mt-3 text-xs text-muted-foreground">
          Window: <strong>{{ dayCount }} day<span v-if="dayCount !== 1">s</span></strong>.
          Hard cap: 50,000 rows per request.
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            :disabled="previewing || dayCount === 0"
            class="inline-flex items-center rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            @click="preview"
          >
            <span v-if="previewing">Loading…</span>
            <span v-else>Preview JSON (first 100 rows)</span>
          </button>
          <button
            type="button"
            :disabled="dayCount === 0"
            class="inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-60"
            @click="downloadCsv"
          >
            â†“ Download CSV
          </button>
        </div>
      </section>

      <!-- Preview -->
      <section
        v-if="previewMeta"
        class="rounded-lg border border-border bg-card p-5 text-card-foreground"
      >
        <h2 class="text-base font-semibold text-foreground">
          Preview
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ previewMeta.row_count }} row<span v-if="previewMeta.row_count !== 1">s</span>
          matched between {{ previewMeta.since }} and {{ previewMeta.until }}.
          Showing first {{ previewRows.length }}.
        </p>
        <div class="mt-3 overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-xs">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-2 py-1.5 text-left font-medium uppercase tracking-wide text-muted-foreground">When</th>
                <th class="px-2 py-1.5 text-left font-medium uppercase tracking-wide text-muted-foreground">Actor</th>
                <th class="px-2 py-1.5 text-left font-medium uppercase tracking-wide text-muted-foreground">Action</th>
                <th class="px-2 py-1.5 text-left font-medium uppercase tracking-wide text-muted-foreground">Entity</th>
                <th class="px-2 py-1.5 text-left font-medium uppercase tracking-wide text-muted-foreground">Metadata</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="(r, idx) in previewRows" :key="idx">
                <td class="px-2 py-1.5 text-muted-foreground">
                  {{ new Date(r.occurred_at).toLocaleString() }}
                </td>
                <td class="px-2 py-1.5 font-mono text-muted-foreground">
                  <span v-if="r.actor_user_id">{{ r.actor_user_id.slice(0, 8) }}…</span>
                  <span v-else class="text-muted-foreground/70">system</span>
                </td>
                <td class="px-2 py-1.5 font-medium text-foreground">
                  {{ r.action }}
                </td>
                <td class="px-2 py-1.5 text-foreground">
                  <span v-if="r.entity">{{ r.entity }}</span>
                  <span v-if="r.entity_id" class="ml-1 font-mono text-[10px] text-muted-foreground/70">
                    {{ r.entity_id.slice(0, 8) }}…
                  </span>
                </td>
                <td class="px-2 py-1.5 font-mono text-[10px] text-muted-foreground max-w-md truncate">
                  {{ JSON.stringify(r.metadata ?? {}) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
