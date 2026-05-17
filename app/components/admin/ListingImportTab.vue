<script setup lang="ts">
/**
 * Admin listing bulk-import tab.
 *
 * Mirror of BrokerImportTab pattern: paste CSV → preview → stage →
 * (admin reviews) → process. Process creates listings with
 * is_online = false; existing moderation flow handles the publish
 * flip. The duplicate detector picks up new listings on its next
 * 30-min cron pass.
 *
 * Required CSV headers: title, organization_slug, broker_email,
 * city_slug. At least one of sale_price | rent_price must be > 0.
 *
 * Image URLs captured to row metadata but NOT processed this turn —
 * async media pipeline is the natural follow-up sprint.
 */
import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'

type Outcome =
  | 'pending' | 'created_pending_review'
  | 'validation_error'
  | 'org_not_found' | 'broker_not_found' | 'broker_not_in_org'
  | 'city_not_found' | 'barangay_not_found' | 'building_unresolved'
  | 'error'

type Batch = {
  id: string
  source_label: string | null
  uploaded_by: string | null
  uploader: { id: string; full_name: string | null } | null
  total_rows: number
  processed_rows: number
  status: 'staged' | 'processed'
  created_at: string
  processed_at: string | null
  outcomes: Record<Outcome, number>
}

type Row = {
  id: string
  row_number: number
  title: string
  sale_price: number | null
  rent_price: number | null
  organization_slug: string
  broker_email: string
  city_slug: string
  barangay_slug: string | null
  building_name: string | null
  outcome: Outcome
  outcome_detail: string | null
  resolved_listing_id: number | null
}

const csvText = ref('')
const sourceLabel = ref('')
const previewRows = ref<Array<Record<string, string>>>([])
const previewError = ref<string | null>(null)
const staging = ref(false)

const batches = ref<Batch[]>([])
const batchesLoading = ref(true)

const expandedBatch = ref<string | null>(null)
const expandedRows = ref<Row[]>([])
const expandedRowsLoading = ref(false)
const outcomeFilter = ref<string>('')
const processing = ref<Record<string, boolean>>({})

const REQUIRED_HEADERS = ['title', 'organization_slug', 'broker_email', 'city_slug']
const ALL_HEADERS = [
  'title', 'description',
  'property_category', 'property_type',
  'sale_price', 'rent_price',
  'bedrooms', 'bathrooms', 'floor_area', 'lot_area', 'parking_spaces',
  'organization_slug', 'broker_email',
  'city_slug', 'barangay_slug', 'building_name',
  'image_urls',
]
const NUMERIC_HEADERS = new Set([
  'sale_price', 'rent_price', 'bedrooms', 'bathrooms',
  'floor_area', 'lot_area', 'parking_spaces',
])

function parseCSV(text: string): { rows: Record<string, string>[]; error: string | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) {
    return { rows: [], error: 'Need at least a header row + 1 data row' }
  }
  const headers = lines[0]!.split(',').map((h) => h.trim().toLowerCase())
  for (const req of REQUIRED_HEADERS) {
    if (!headers.includes(req)) {
      return { rows: [], error: `Missing required header: ${req}` }
    }
  }
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const row: Record<string, string> = {}
    headers.forEach((h, j) => {
      if (ALL_HEADERS.includes(h)) row[h] = cols[j] ?? ''
    })
    if (!row.title || !row.organization_slug || !row.broker_email || !row.city_slug) continue
    rows.push(row)
  }
  if (rows.length === 0) return { rows: [], error: 'No valid data rows' }
  if (rows.length > 2000) {
    return { rows: [], error: `Too many rows (${rows.length}). Max 2000 per batch.` }
  }
  return { rows, error: null }
}

function previewCsv() {
  const { rows, error } = parseCSV(csvText.value)
  previewRows.value = rows
  previewError.value = error
}

async function stageBatch() {
  if (previewRows.value.length === 0) {
    showToast({ title: 'Parse the CSV first', icon: 'warning' })
    return
  }
  staging.value = true
  try {
    const body = {
      source_label: sourceLabel.value.trim() || null,
      rows: previewRows.value.map((r) => {
        const out: Record<string, any> = { ...r }
        // Coerce numeric columns from CSV strings.
        for (const k of NUMERIC_HEADERS) {
          if (out[k] !== undefined && out[k] !== '') {
            const n = Number(out[k])
            out[k] = Number.isFinite(n) ? n : null
          } else {
            out[k] = null
          }
        }
        // image_urls: split by | (pipe) so the CSV cell can carry
        // multiple URLs without escaping commas.
        if (out.image_urls) {
          out.image_urls = String(out.image_urls).split('|').map((s: string) => s.trim()).filter(Boolean)
        } else {
          delete out.image_urls
        }
        return out
      }),
    }
    const res = await $fetch<{ batch: Batch }>('/api/admin/listings/import', {
      method: 'POST',
      body,
    })
    showToast({ title: `Staged batch with ${res.batch.total_rows} rows`, icon: 'success' })
    csvText.value = ''
    sourceLabel.value = ''
    previewRows.value = []
    previewError.value = null
    await loadBatches()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to stage batch',
      icon: 'error',
    })
  } finally {
    staging.value = false
  }
}

async function loadBatches() {
  batchesLoading.value = true
  try {
    const res = await $fetch<{ batches: Batch[] }>('/api/admin/listings/import')
    batches.value = res.batches ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load batches',
      icon: 'error',
    })
  } finally {
    batchesLoading.value = false
  }
}

async function processBatch(b: Batch) {
  if (processing.value[b.id] || b.status === 'processed') return
  processing.value[b.id] = true
  try {
    const res = await $fetch<{ summary: any }>(`/api/admin/listings/import/${b.id}/process`, {
      method: 'POST',
    })
    const s = res.summary || {}
    showToast({
      title:
        `Created ${s.created || 0} (pending review), ` +
        `${s.validation_err || 0} validation, ` +
        `${s.unresolved || 0} unresolved, ` +
        `${s.errors || 0} errors`,
      icon: 'success',
    })
    await loadBatches()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to process',
      icon: 'error',
    })
  } finally {
    delete processing.value[b.id]
  }
}

async function toggleExpanded(b: Batch) {
  if (expandedBatch.value === b.id) {
    expandedBatch.value = null
    expandedRows.value = []
    return
  }
  expandedBatch.value = b.id
  outcomeFilter.value = ''
  await loadRows(b.id)
}

async function loadRows(batchId: string) {
  expandedRowsLoading.value = true
  try {
    const query: Record<string, string | number> = { page_size: 200 }
    if (outcomeFilter.value) query.outcome = outcomeFilter.value
    const res = await $fetch<{ rows: Row[] }>(
      `/api/admin/listings/import/${batchId}/rows`,
      { query },
    )
    expandedRows.value = res.rows ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load rows',
      icon: 'error',
    })
  } finally {
    expandedRowsLoading.value = false
  }
}

onMounted(loadBatches)

function outcomeBadgeClass(outcome: Outcome): string {
  switch (outcome) {
    case 'created_pending_review':  return 'bg-success/10 text-success ring-success/30'
    case 'validation_error':
    case 'org_not_found':
    case 'broker_not_found':
    case 'broker_not_in_org':
    case 'city_not_found':
    case 'barangay_not_found':      return 'bg-warning/10 text-warning ring-warning/30'
    case 'building_unresolved':     return 'bg-warning/10 text-warning ring-warning/30'
    case 'error':                   return 'bg-destructive/10 text-destructive ring-destructive/30'
    default:                        return 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/15'
  }
}

const sampleCSV = `title,property_category,property_type,sale_price,rent_price,bedrooms,bathrooms,floor_area,organization_slug,broker_email,city_slug,barangay_slug,building_name,image_urls
3BR Park Suite,residential,condo,18500000,,3,3,98,acme-brokerage,jane.doe@example.com,makati,bel-air,Bel Air Park Tower,https://cdn.example.com/a.jpg|https://cdn.example.com/b.jpg
Studio with view,residential,condo,,52000,0,1,28,acme-brokerage,john.smith@example.com,taguig,fort-bonifacio-global-city,Bonifacio Ridge,
Boutique office,commercial,office,,180000,,2,124,acme-brokerage,ana.cruz@example.com,makati,salcedo,,`
</script>

<template>
  <section class="space-y-6">
    <!-- Section 1: Upload -->
    <section class="rounded-lg border border-border bg-card p-5">
      <header class="mb-4">
        <h2 class="text-base font-semibold text-foreground">Bulk listing import</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Paste CSV → preview → stage. Created listings are
          <span class="font-mono">is_online = false</span> until a moderator
          flips them. Existing duplicate detector picks up new listings on
          its next 30-min cron pass.
        </p>
      </header>

      <div class="space-y-3">
        <label class="block text-xs">
          <span class="font-semibold text-foreground/80">Source label (optional)</span>
          <input
            v-model="sourceLabel"
            type="text"
            placeholder="e.g. Acme Brokerage Q2 2026"
            class="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <label class="block text-xs">
          <span class="font-semibold text-foreground/80">CSV (header row required)</span>
          <textarea
            v-model="csvText"
            rows="12"
            class="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            :placeholder="sampleCSV"
          />
        </label>
        <p class="text-[10px] text-muted-foreground">
          Required columns: title, organization_slug, broker_email, city_slug.
          At least one of sale_price / rent_price must be &gt; 0.
          image_urls separated by <span class="font-mono">|</span> (pipe). Building name fuzzy-matched within city.
        </p>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground/80 hover:bg-accent hover:text-accent-foreground"
            @click="previewCsv"
          >
            Parse preview
          </button>
          <button
            type="button"
            class="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="staging || previewRows.length === 0"
            @click="stageBatch"
          >
            {{ staging ? 'Staging…' : `Stage ${previewRows.length} row${previewRows.length === 1 ? '' : 's'}` }}
          </button>
        </div>

        <div
          v-if="previewError"
          class="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
        >
          {{ previewError }}
        </div>

        <div
          v-if="previewRows.length > 0"
          class="overflow-x-auto rounded-lg border border-border"
        >
          <table class="w-full text-left text-xs">
            <thead class="border-b border-border bg-muted-foreground/5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <tr>
                <th class="py-1 pr-2 pl-2 font-semibold">Title</th>
                <th class="py-1 pr-2 font-semibold">Price</th>
                <th class="py-1 pr-2 font-semibold">Org</th>
                <th class="py-1 pr-2 font-semibold">Broker</th>
                <th class="py-1 pr-2 font-semibold">City</th>
                <th class="py-1 pr-2 font-semibold">Building</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="(r, i) in previewRows.slice(0, 50)" :key="i">
                <td class="py-1 pr-2 pl-2 line-clamp-1">{{ r.title }}</td>
                <td class="py-1 pr-2 font-mono">
                  {{ r.sale_price ? '₱' + Number(r.sale_price).toLocaleString() :
                     r.rent_price ? '₱' + Number(r.rent_price).toLocaleString() + '/mo' : '—' }}
                </td>
                <td class="py-1 pr-2 font-mono text-[11px]">{{ r.organization_slug }}</td>
                <td class="py-1 pr-2 font-mono text-[11px]">{{ r.broker_email }}</td>
                <td class="py-1 pr-2 font-mono text-[11px]">
                  {{ r.city_slug }}<span v-if="r.barangay_slug">/{{ r.barangay_slug }}</span>
                </td>
                <td class="py-1 pr-2 text-muted-foreground">{{ r.building_name || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="previewRows.length > 50" class="px-2 py-1 text-[10px] text-muted-foreground">
            Showing first 50 of {{ previewRows.length }}. Stage to see them all.
          </p>
        </div>
      </div>
    </section>

    <!-- Section 2: Batches -->
    <section class="rounded-lg border border-border bg-card p-5">
      <header class="mb-4">
        <h2 class="text-base font-semibold text-foreground">Recent batches</h2>
      </header>

      <div v-if="batchesLoading" class="space-y-2">
        <div
          v-for="n in 3"
          :key="n"
          class="rounded-xl border border-border bg-background p-3"
        >
          <Skeleton class="h-3 w-1/3" />
          <Skeleton class="mt-2 h-2.5 w-1/2" />
        </div>
      </div>

      <EmptyState
        v-else-if="batches.length === 0"
        variant="neutral"
        size="cozy"
        title="No batches yet"
        description="Paste a CSV above and stage it to start an import batch."
      />

      <ul v-else class="space-y-2">
        <li
          v-for="b in batches"
          :key="b.id"
          class="rounded-xl border border-border bg-background p-3"
        >
          <div class="flex flex-wrap items-baseline gap-2">
            <p class="text-sm font-semibold">
              {{ b.source_label || `Batch ${b.id.slice(0, 8)}` }}
            </p>
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1"
              :class="b.status === 'processed' ? 'bg-success/10 text-success ring-success/30' : 'bg-warning/10 text-warning ring-warning/30'"
            >
              {{ b.status }}
            </span>
            <span class="text-[11px] text-muted-foreground">
              {{ b.total_rows }} rows · by {{ b.uploader?.full_name || 'admin' }}
              · {{ new Date(b.created_at).toLocaleString() }}
            </span>
            <div class="ml-auto flex gap-2">
              <button
                v-if="b.status === 'staged'"
                type="button"
                class="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="processing[b.id]"
                @click="processBatch(b)"
              >
                {{ processing[b.id] ? 'Processing…' : 'Process' }}
              </button>
              <button
                type="button"
                class="rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold text-foreground/80 hover:bg-accent hover:text-accent-foreground"
                @click="toggleExpanded(b)"
              >
                {{ expandedBatch === b.id ? 'Hide rows' : 'View rows' }}
              </button>
            </div>
          </div>

          <div class="mt-2 flex flex-wrap gap-1">
            <span
              v-for="(count, outcome) in b.outcomes"
              :key="outcome"
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1"
              :class="outcomeBadgeClass(outcome as Outcome)"
            >
              {{ String(outcome).replace(/_/g, ' ') }}: {{ count }}
            </span>
          </div>

          <div v-if="expandedBatch === b.id" class="mt-3 border-t border-border pt-3">
            <div class="mb-2 flex items-center gap-2 text-xs">
              <span class="font-semibold text-foreground/80">Filter:</span>
              <select
                v-model="outcomeFilter"
                class="rounded-md border border-border bg-card px-2 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                @change="loadRows(b.id)"
              >
                <option value="">All outcomes</option>
                <option value="pending">Pending</option>
                <option value="created_pending_review">Created (pending review)</option>
                <option value="validation_error">Validation error</option>
                <option value="org_not_found">Org not found</option>
                <option value="broker_not_found">Broker not found</option>
                <option value="broker_not_in_org">Broker not in org</option>
                <option value="city_not_found">City not found</option>
                <option value="barangay_not_found">Barangay not found</option>
                <option value="building_unresolved">Building unresolved</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div v-if="expandedRowsLoading" class="space-y-1.5">
              <Skeleton v-for="n in 4" :key="n" class="h-4 w-full" />
            </div>
            <p v-else-if="expandedRows.length === 0" class="text-xs text-muted-foreground">
              No rows for this filter.
            </p>
            <div v-else class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th class="py-1 pr-2 font-semibold">#</th>
                    <th class="py-1 pr-2 font-semibold">Title</th>
                    <th class="py-1 pr-2 font-semibold">Org/Broker</th>
                    <th class="py-1 pr-2 font-semibold">Outcome</th>
                    <th class="py-1 font-semibold">Detail</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border">
                  <tr v-for="r in expandedRows" :key="r.id">
                    <td class="py-1.5 pr-2 tabular-nums text-muted-foreground">{{ r.row_number }}</td>
                    <td class="py-1 pr-2">
                      <span v-if="r.resolved_listing_id">
                        <NuxtLink :to="`/listings/${r.resolved_listing_id}`" class="text-primary hover:underline">
                          {{ r.title }}
                        </NuxtLink>
                      </span>
                      <span v-else>{{ r.title }}</span>
                    </td>
                    <td class="py-1 pr-2 text-[11px] font-mono text-muted-foreground">
                      {{ r.organization_slug }} · {{ r.broker_email }}
                    </td>
                    <td class="py-1 pr-2">
                      <span
                        class="rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1"
                        :class="outcomeBadgeClass(r.outcome)"
                      >
                        {{ r.outcome.replace(/_/g, ' ') }}
                      </span>
                    </td>
                    <td class="py-1.5 text-muted-foreground">{{ r.outcome_detail || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </li>
      </ul>
    </section>
  </section>
</template>
