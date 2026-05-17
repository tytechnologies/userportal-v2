<script setup lang="ts">
/**
 * Admin — review queue for external_listing_candidates.
 *
 * The hybrid orchestrator persists every external hit it surfaces to
 * the website. Over time this table grows into a discovery corpus.
 * Operators triage here: blacklist junk, promote useful hits into
 * listings_raw for full ingest, manually pin dedup matches the
 * runtime engine missed.
 *
 * Mirrors the /admin/lead-routing exemplar's page recipe.
 */

definePageMeta({ layout: 'default' })
useHead({ title: 'External candidates · Admin' })

import { ref, computed, watch } from 'vue'

type Candidate = {
  id: string
  provider_slug: string
  source_url: string
  source_domain: string
  title: string | null
  price: number | null
  currency: string
  for_sale: boolean | null
  for_rent: boolean | null
  property_type: string | null
  bedrooms: number | null
  bathrooms: number | null
  floor_area: number | null
  city_slug: string | null
  latitude: number | null
  longitude: number | null
  thumbnail_url: string | null
  parse_confidence: number
  dedup_status: 'unmatched' | 'matched_provisional' | 'matched_confirmed' | 'distinct'
  canonical_property_id: number | null
  match_confidence: number | null
  operator_status: 'surfaced' | 'blacklisted' | 'promoted'
  surface_count: number
  first_surfaced_at: string
  last_surfaced_at: string
}

type ListResponse = {
  items: Candidate[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

const provider = ref<string>('')
const dedupStatus = ref<string>('')
const operatorStatus = ref<string>('surfaced')
const cityFilter = ref<string>('')
const search = ref<string>('')
const minConfidence = ref<number>(0)
const page = ref<number>(1)
const perPage = ref<number>(25)
const busy = ref<string | null>(null)

const queryParams = computed(() => {
  const p: Record<string, any> = { page: page.value, per_page: perPage.value }
  if (provider.value)        p.provider = provider.value
  if (dedupStatus.value)     p.dedup_status = dedupStatus.value
  if (operatorStatus.value)  p.operator_status = operatorStatus.value
  if (cityFilter.value)      p.city_slug = cityFilter.value
  if (search.value)          p.q = search.value
  if (minConfidence.value > 0) p.min_parse_confidence = minConfidence.value
  return p
})

const { data, refresh, pending } = await useFetch<ListResponse>(
  '/api/admin/live-search/candidates',
  {
    query: queryParams,
    server: false,
    default: () => ({ items: [], total: 0, page: 1, perPage: 25, totalPages: 1 }),
  },
)

// Reset to page 1 when filters change (but not when paginating).
watch(
  [provider, dedupStatus, operatorStatus, cityFilter, search, minConfidence],
  () => { page.value = 1 },
)

async function setOperatorStatus(id: string, status: 'surfaced' | 'blacklisted' | 'promoted') {
  busy.value = id
  try {
    await $fetch(`/api/admin/live-search/candidates/${id}`, {
      method: 'PATCH',
      body: { operator_status: status },
    })
    await refresh()
  } catch (err) {
    console.error('setOperatorStatus failed', err)
  } finally {
    busy.value = null
  }
}

async function promote(id: string) {
  if (!confirm('Promote this candidate to listings_raw for full ingest?')) return
  busy.value = id
  try {
    const res = await $fetch<{ ok: boolean; listings_raw_id: string | null }>(
      `/api/admin/live-search/candidates/${id}/promote`,
      { method: 'POST' },
    )
    alert(
      res.ok
        ? `Promoted. listings_raw id: ${res.listings_raw_id ?? '(deduped)'}.`
        : 'Promote failed.',
    )
    await refresh()
  } catch (err: any) {
    alert(`Promote failed: ${err?.data?.message || err?.statusMessage || err?.message || 'unknown'}`)
  } finally {
    busy.value = null
  }
}

function fmtPHP(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `₱${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `₱${(n / 1_000).toFixed(0)}K`
  return `₱${n.toLocaleString()}`
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${Math.round(n * 100)}%`
}

function relTime(iso: string): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}
</script>

<template>
  <AdminPageShell max-width="wide">
    <UiPageHeader
      title="External candidates"
      description="Discovery corpus from the hybrid live-search orchestrator. Triage: blacklist junk, promote useful hits into listings_raw, or pin dedup matches the runtime engine missed."
    >
      <template #actions>
        <UiButton variant="ghost" :disabled="pending" @click="refresh()">
          Refresh
        </UiButton>
      </template>
    </UiPageHeader>

    <!-- Filters -->
    <UiCard class="mb-6">
      <div class="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
        <label class="grid gap-1">
          <span class="text-meta text-muted-foreground">Operator status</span>
          <select v-model="operatorStatus" class="rounded-md border border-border px-3 py-2 text-sm bg-background">
            <option value="">all</option>
            <option value="surfaced">surfaced</option>
            <option value="blacklisted">blacklisted</option>
            <option value="promoted">promoted</option>
          </select>
        </label>
        <label class="grid gap-1">
          <span class="text-meta text-muted-foreground">Dedup status</span>
          <select v-model="dedupStatus" class="rounded-md border border-border px-3 py-2 text-sm bg-background">
            <option value="">all</option>
            <option value="unmatched">unmatched</option>
            <option value="matched_provisional">matched (prov.)</option>
            <option value="matched_confirmed">matched (conf.)</option>
            <option value="distinct">distinct</option>
          </select>
        </label>
        <label class="grid gap-1">
          <span class="text-meta text-muted-foreground">Provider</span>
          <input v-model="provider" placeholder="tavily_ph_real_estate" class="rounded-md border border-border px-3 py-2 text-sm bg-background" />
        </label>
        <label class="grid gap-1">
          <span class="text-meta text-muted-foreground">City slug</span>
          <input v-model="cityFilter" placeholder="makati" class="rounded-md border border-border px-3 py-2 text-sm bg-background" />
        </label>
        <label class="grid gap-1">
          <span class="text-meta text-muted-foreground">Search (title)</span>
          <input v-model="search" placeholder="2br condo" class="rounded-md border border-border px-3 py-2 text-sm bg-background" />
        </label>
        <label class="grid gap-1">
          <span class="text-meta text-muted-foreground">Min confidence</span>
          <input v-model.number="minConfidence" type="number" step="0.1" min="0" max="1" class="rounded-md border border-border px-3 py-2 text-sm bg-background" />
        </label>
      </div>
    </UiCard>

    <!-- KPI strip -->
    <div class="mb-4 text-sm text-muted-foreground">
      Showing {{ data.items.length }} of {{ data.total.toLocaleString() }} — page {{ data.page }} of {{ data.totalPages }}
    </div>

    <UiEmptyState
      v-if="data.items.length === 0"
      title="No matching candidates"
      description="Adjust filters or enable a Tavily connector to populate the corpus."
    />

    <!-- Card grid -->
    <ul v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <li v-for="c in data.items" :key="c.id">
        <UiCard>
          <template #header>
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-sm font-semibold line-clamp-2">{{ c.title || '(untitled)' }}</p>
                <p class="text-meta text-muted-foreground truncate">
                  {{ c.source_domain }} · {{ relTime(c.last_surfaced_at) }}
                </p>
              </div>
              <UiBadge :variant="c.operator_status === 'promoted' ? 'success' : c.operator_status === 'blacklisted' ? 'destructive' : 'neutral'">
                {{ c.operator_status }}
              </UiBadge>
            </div>
          </template>

          <img
            v-if="c.thumbnail_url"
            :src="c.thumbnail_url"
            :alt="c.title || ''"
            class="w-full aspect-[4/3] object-cover rounded-md mb-3 border border-border"
            loading="lazy"
          />

          <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt class="text-muted-foreground">Price</dt>
            <dd class="font-medium">
              {{ fmtPHP(c.price) }}
              <span v-if="c.for_rent" class="text-meta text-muted-foreground">/mo</span>
            </dd>

            <dt class="text-muted-foreground">Beds / baths</dt>
            <dd>{{ c.bedrooms ?? '—' }} / {{ c.bathrooms ?? '—' }}</dd>

            <dt class="text-muted-foreground">Type</dt>
            <dd>{{ c.property_type || '—' }}</dd>

            <dt class="text-muted-foreground">City</dt>
            <dd>{{ c.city_slug || '—' }}</dd>

            <dt class="text-muted-foreground">Parse confidence</dt>
            <dd>{{ fmtPct(c.parse_confidence) }}</dd>

            <dt class="text-muted-foreground">Dedup</dt>
            <dd>
              {{ c.dedup_status }}
              <span v-if="c.canonical_property_id" class="text-meta text-muted-foreground">
                → prop #{{ c.canonical_property_id }} ({{ fmtPct(c.match_confidence) }})
              </span>
            </dd>

            <dt class="text-muted-foreground">Seen</dt>
            <dd>{{ c.surface_count }}x</dd>
          </dl>

          <template #footer>
            <div class="flex items-center justify-between gap-2 pt-3">
              <a :href="c.source_url" target="_blank" rel="noopener noreferrer" class="text-xs text-primary hover:underline">
                Open source ↗
              </a>
              <div class="flex gap-2">
                <UiButton
                  v-if="c.operator_status !== 'blacklisted'"
                  size="sm"
                  variant="ghost"
                  :disabled="busy === c.id"
                  @click="setOperatorStatus(c.id, 'blacklisted')"
                >
                  Blacklist
                </UiButton>
                <UiButton
                  v-if="c.operator_status === 'blacklisted'"
                  size="sm"
                  variant="ghost"
                  :disabled="busy === c.id"
                  @click="setOperatorStatus(c.id, 'surfaced')"
                >
                  Restore
                </UiButton>
                <UiButton
                  v-if="c.operator_status !== 'promoted'"
                  size="sm"
                  :disabled="busy === c.id"
                  @click="promote(c.id)"
                >
                  Promote
                </UiButton>
              </div>
            </div>
          </template>
        </UiCard>
      </li>
    </ul>

    <!-- Pagination -->
    <div v-if="data.totalPages > 1" class="mt-6 flex items-center justify-center gap-2">
      <UiButton variant="ghost" :disabled="page <= 1" @click="page = page - 1">Previous</UiButton>
      <span class="text-sm text-muted-foreground">page {{ data.page }} / {{ data.totalPages }}</span>
      <UiButton variant="ghost" :disabled="page >= data.totalPages" @click="page = page + 1">Next</UiButton>
    </div>
  </AdminPageShell>
</template>
