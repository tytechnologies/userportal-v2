<script setup lang="ts">
/**
 * /admin/search-index — search index queue health.
 *
 * Surfaces:
 *   - whether Typesense env vars are set (`engine_enabled`)
 *   - current pending depth
 *   - throughput in the last hour
 *   - rows with errors awaiting retry
 *   - recent queue events
 *
 * Pre-cutover, with TYPESENSE_HOST unset, the worker drains pending
 * rows as no-ops; the page just confirms the queue isn't growing
 * unboundedly.
 */

import { ref, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Search Index | Admin' })

type QueueRow = {
  id: number
  property_id: number
  op: 'upsert' | 'delete'
  attempts: number
  last_error: string | null
  enqueued_at: string
  processed_at: string | null
}

const engineEnabled = ref(false)
const pending = ref(0)
const processedLastHour = ref(0)
const withError = ref(0)
const recent = ref<QueueRow[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      engine_enabled: boolean
      pending_count: number
      processed_last_hour: number
      with_error: number
      recent: QueueRow[]
    }>('/api/admin/search/index-status')
    engineEnabled.value      = res.engine_enabled
    pending.value            = res.pending_count
    processedLastHour.value  = res.processed_last_hour
    withError.value          = res.with_error
    recent.value             = res.recent ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load index status', icon: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['admin.access']" max-width="wide">
    <UiPageHeader
      title="Search Index"
      description="Queue depth and throughput for the external search engine indexer. Pre-cutover (TYPESENSE_HOST unset) the worker drains as no-ops so the queue stays bounded."
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

    <UiCard variant="surface" padding="md">
      <div class="flex items-center gap-3">
        <div class="font-medium text-foreground">Engine</div>
        <UiBadge v-if="engineEnabled" variant="success">Typesense configured</UiBadge>
        <UiBadge v-else variant="warning">Typesense env vars not set — worker no-ops</UiBadge>
      </div>
      <div v-if="!engineEnabled" class="text-xs text-muted-foreground mt-2">
        Set <code>TYPESENSE_HOST</code> and <code>TYPESENSE_API_KEY</code> server-side, then the worker will start writing real documents on next run.
      </div>
    </UiCard>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <UiStatCard label="Pending" :value="pending" :tone="pending > 1000 ? 'warning' : 'neutral'" />
      <UiStatCard label="Processed (last hour)" :value="processedLastHour" tone="success" />
      <UiStatCard label="With error" :value="withError" :tone="withError > 0 ? 'destructive' : 'neutral'" />
    </div>

    <UiCard variant="surface" padding="none">
      <div class="px-3 py-2 border-b border-border font-medium text-foreground">Recent queue events</div>
      <UiEmptyState
        v-if="!loading && recent.length === 0"
        title="Queue is empty"
        description="Triggers on listings + properties will enqueue rows as those tables change."
      />
      <div v-else-if="recent.length > 0" class="overflow-x-auto">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-muted/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Property</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Op</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Attempts</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Enqueued</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Processed</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="r in recent" :key="r.id">
              <td class="px-3 py-2 tabular-nums">#{{ r.property_id }}</td>
              <td class="px-3 py-2">
                <UiBadge :variant="r.op === 'delete' ? 'destructive' : 'info'">{{ r.op }}</UiBadge>
              </td>
              <td class="px-3 py-2 tabular-nums text-xs">{{ r.attempts }}</td>
              <td class="px-3 py-2 text-xs">
                <UiBadge v-if="r.processed_at" variant="success">processed</UiBadge>
                <UiBadge v-else-if="r.last_error" variant="destructive">error</UiBadge>
                <UiBadge v-else variant="warning">pending</UiBadge>
                <span v-if="r.last_error" class="ml-2 text-[11px] text-muted-foreground truncate max-w-xs inline-block align-bottom">
                  {{ r.last_error }}
                </span>
              </td>
              <td class="px-3 py-2 text-xs text-muted-foreground">{{ new Date(r.enqueued_at).toLocaleString() }}</td>
              <td class="px-3 py-2 text-xs text-muted-foreground">{{ r.processed_at ? new Date(r.processed_at).toLocaleString() : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>
  </AdminPageShell>
</template>
