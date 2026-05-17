<script setup lang="ts">
/**
 * /admin/tools/tavily — discovery + enrichment surface.
 *
 * Two operations:
 *   discover-sources           — Tavily search for a free-text query.
 *                                Admin triages results manually.
 *   enrich-property/[id]       — fetch + store enrichment into
 *                                properties.attributes.tavily_enrichment.
 *
 * Status pill surfaces whether TAVILY_API_KEY is configured and
 * shows today's per-bucket budget usage.
 */

import { ref, reactive, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Tavily Tools | Admin' })

const enabled = ref(false)
const caps = ref<Record<string, number>>({ discovery: 50, enrichment: 100, dedup_hint: 200 })
const usage = ref<Record<string, number>>({ discovery: 0, enrichment: 0, dedup_hint: 0 })

const discoverForm = reactive({ query: '', max_results: 5 })
const discoverResults = ref<Array<{ title: string; url: string; content: string }>>([])
const discoverAnswer = ref<string | null>(null)
const discovering = ref(false)

const enrichForm = reactive({ property_id: '' as string | number })
const enriching = ref(false)
const enrichResult = ref<{ property_id?: number; query?: string } | null>(null)

async function loadStatus() {
  try {
    const res = await $fetch<{
      enabled: boolean
      caps: Record<string, number>
      usage_today: Record<string, number>
    }>('/api/admin/tools/tavily/status')
    enabled.value = res.enabled
    caps.value = res.caps
    usage.value = res.usage_today
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load Tavily status', icon: 'error' })
  }
}

async function runDiscover() {
  if (!discoverForm.query.trim()) {
    showToast({ title: 'Enter a query first', icon: 'error' })
    return
  }
  discovering.value = true
  discoverResults.value = []
  discoverAnswer.value = null
  try {
    const res = await $fetch<{
      ok: true
      answer: string | null
      results: Array<{ title: string; url: string; content: string }>
    }>('/api/admin/tools/tavily/discover-sources', {
      method: 'POST',
      body: { query: discoverForm.query, max_results: discoverForm.max_results },
    })
    discoverAnswer.value = res.answer
    discoverResults.value = res.results ?? []
    await loadStatus()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Discovery failed', icon: 'error' })
  } finally {
    discovering.value = false
  }
}

async function runEnrich() {
  const pid = Number(enrichForm.property_id)
  if (!Number.isInteger(pid) || pid <= 0) {
    showToast({ title: 'Enter a numeric property id', icon: 'error' })
    return
  }
  enriching.value = true
  enrichResult.value = null
  try {
    const res = await $fetch<{ property_id: number; query: string }>(
      `/api/admin/tools/tavily/enrich-property/${pid}`,
      { method: 'POST' },
    )
    enrichResult.value = res
    showToast({ title: `Enriched property #${res.property_id}`, icon: 'success' })
    await loadStatus()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Enrich failed', icon: 'error' })
  } finally {
    enriching.value = false
  }
}

onMounted(loadStatus)
</script>

<template>
  <AdminPageShell :permission="['admin.access']" max-width="wide">
    <UiPageHeader
      title="Tavily Tools"
      description="Tavily is enrichment-only. It never sits on the public read path. Use it to discover new partner sources or to enrich a property's neighborhood context. All calls are budgeted; usage shown right."
    >
      <template #actions>
        <UiBadge v-if="enabled" variant="success">configured</UiBadge>
        <UiBadge v-else variant="warning">TAVILY_API_KEY not set</UiBadge>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <UiStatCard
        label="Discovery (today)"
        :value="`${usage.discovery} / ${caps.discovery}`"
        :tone="usage.discovery >= caps.discovery ? 'destructive' : 'primary'"
      />
      <UiStatCard
        label="Enrichment (today)"
        :value="`${usage.enrichment} / ${caps.enrichment}`"
        :tone="usage.enrichment >= caps.enrichment ? 'destructive' : 'primary'"
      />
      <UiStatCard
        label="Dedup hints (today)"
        :value="`${usage.dedup_hint} / ${caps.dedup_hint}`"
        :tone="usage.dedup_hint >= caps.dedup_hint ? 'destructive' : 'primary'"
      />
    </div>

    <!-- Discover sources -->
    <UiCard variant="surface" padding="md">
      <div class="font-medium text-foreground mb-3">Discover sources</div>
      <div class="flex flex-col sm:flex-row gap-2">
        <input
          v-model="discoverForm.query"
          type="text"
          placeholder="e.g. 'condo listings Makati Philippines mls'"
          class="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          @keydown.enter="runDiscover"
        />
        <input
          v-model.number="discoverForm.max_results"
          type="number"
          min="1"
          max="20"
          class="w-24 rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
        />
        <button
          type="button"
          class="btn-primary focus-ring"
          :disabled="discovering || !enabled"
          @click="runDiscover"
        >
          {{ discovering ? 'Searching…' : 'Search' }}
        </button>
      </div>
      <div v-if="discoverAnswer" class="mt-4 rounded-lg bg-muted/40 p-3 text-sm">
        <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Tavily answer</div>
        {{ discoverAnswer }}
      </div>
      <div v-if="discoverResults.length > 0" class="mt-4 space-y-2">
        <a
          v-for="r in discoverResults"
          :key="r.url"
          :href="r.url"
          target="_blank"
          rel="noreferrer"
          class="block rounded-lg border border-border p-3 hover:bg-accent hover:text-accent-foreground"
        >
          <div class="font-medium text-foreground">{{ r.title }}</div>
          <div class="text-xs text-muted-foreground truncate">{{ r.url }}</div>
          <div class="text-sm mt-1 line-clamp-3">{{ r.content }}</div>
        </a>
      </div>
    </UiCard>

    <!-- Enrich property -->
    <UiCard variant="surface" padding="md">
      <div class="font-medium text-foreground mb-3">Enrich a property</div>
      <div class="text-xs text-muted-foreground mb-3">
        Fetches building / neighborhood context for the property and stores it into
        <code>properties.attributes.tavily_enrichment</code>. Does not overwrite any typed
        property field.
      </div>
      <div class="flex flex-col sm:flex-row gap-2">
        <input
          v-model="enrichForm.property_id"
          type="number"
          placeholder="Property id (integer)"
          class="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
        />
        <button
          type="button"
          class="btn-primary focus-ring"
          :disabled="enriching || !enabled"
          @click="runEnrich"
        >
          {{ enriching ? 'Enriching…' : 'Enrich' }}
        </button>
      </div>
      <UiEmptyState
        v-if="!enrichResult"
        title="No enrichment yet"
        description="Submit a property id above. The result is saved to attributes.tavily_enrichment for admin review."
      />
      <div v-else class="mt-4 rounded-lg border border-border p-3 text-sm">
        <div class="font-medium text-foreground">Enriched property #{{ enrichResult.property_id }}</div>
        <div class="text-xs text-muted-foreground mt-1">Query: {{ enrichResult.query }}</div>
      </div>
    </UiCard>
  </AdminPageShell>
</template>
