<script setup lang="ts">
/**
 * Admin broker bulk-import tab.
 *
 * Two surfaces:
 *   1. Upload section — paste a CSV; preview rows; stage as a batch.
 *      No DB mutation against profiles or memberships at this step;
 *      rows just land in broker_import_rows for review.
 *   2. Batch list — staged + processed batches with per-outcome
 *      counts. Drilldown button opens row detail.
 *
 * The CSV format is intentionally simple — paste-friendly, no file
 * upload library. Header row required:
 *
 *   email,full_name,mobile_number,organization_slug,branch_slug,org_role
 *
 * org_role defaults to senior_agent if blank. branch_slug is optional.
 */
import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'

type Outcome =
  | 'pending' | 'linked_existing' | 'already_member' | 'invitation_created'
  | 'duplicate_email_in_batch' | 'org_not_found' | 'branch_not_found'
  | 'validation_error' | 'error'

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
  email: string
  full_name: string | null
  mobile_number: string | null
  organization_slug: string
  branch_slug: string | null
  org_role: string
  outcome: Outcome
  outcome_detail: string | null
  processed_at: string | null
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

// CSV parser: header row required; comma-delimited; quoted-field
// support is intentionally basic (matches what an operator pastes
// from a spreadsheet — no embedded commas inside quoted strings).
const REQUIRED_HEADERS = ['email', 'organization_slug']
const ALL_HEADERS = [
  'email', 'full_name', 'mobile_number',
  'organization_slug', 'branch_slug', 'org_role',
]

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
    if (!row.email || !row.organization_slug) continue
    rows.push(row)
  }
  if (rows.length === 0) return { rows: [], error: 'No valid data rows' }
  if (rows.length > 5000) {
    return { rows: [], error: `Too many rows (${rows.length}). Max 5000 per batch.` }
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
      rows: previewRows.value.map((r) => ({
        email:             r.email,
        full_name:         r.full_name || null,
        mobile_number:     r.mobile_number || null,
        organization_slug: r.organization_slug,
        branch_slug:       r.branch_slug || null,
        org_role:          r.org_role || 'senior_agent',
      })),
    }
    const res = await $fetch<{ batch: Batch }>('/api/admin/brokers/import', {
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
    const res = await $fetch<{ batches: Batch[] }>('/api/admin/brokers/import')
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
    const res = await $fetch<{ summary: any }>(`/api/admin/brokers/import/${b.id}/process`, {
      method: 'POST',
    })
    const s = res.summary || {}
    showToast({
      title:
        `Linked ${s.linked_existing || 0}, ` +
        `invited ${s.invitation_created || 0}, ` +
        `already-member ${s.already_member || 0}, ` +
        `errors ${(s.validation_error || 0) + (s.errors || 0)}`,
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
      `/api/admin/brokers/import/${batchId}/rows`,
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
    case 'linked_existing':       return 'bg-success/10 text-success ring-success/30'
    case 'already_member':        return 'bg-primary/10 text-primary ring-primary/30'
    case 'invitation_created':    return 'bg-primary/10 text-primary ring-primary/30'
    case 'duplicate_email_in_batch': return 'bg-warning/10 text-warning ring-warning/30'
    case 'org_not_found':
    case 'branch_not_found':
    case 'validation_error':      return 'bg-warning/10 text-warning ring-warning/30'
    case 'error':                 return 'bg-destructive/10 text-destructive ring-destructive/30'
    default:                      return 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/15'
  }
}

const sampleCSV = `email,full_name,mobile_number,organization_slug,branch_slug,org_role
jane.doe@example.com,Jane Doe,+639170000001,acme-brokerage,makati,senior_agent
john.smith@example.com,John Smith,,acme-brokerage,bgc,branch_manager
ana.cruz@example.com,Ana Cruz,,acme-brokerage,,junior_agent`
</script>

<template>
  <section class="space-y-4">
    <!-- Section 1: Upload -->
    <section class="ui-card p-5">
      <header class="mb-4">
        <h2 class="text-section-title">Bulk broker import</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Paste CSV → preview → stage. Staging never modifies profiles or
          memberships. After review, click
          <em class="font-medium not-italic text-foreground/80">Process</em>
          on the staged batch to match emails or create invitations.
        </p>
      </header>

      <div class="space-y-3">
        <label class="block">
          <span class="block text-xs font-semibold text-foreground/80">
            Source label (optional)
          </span>
          <input
            v-model="sourceLabel"
            type="text"
            placeholder="e.g. Q2 Acme Brokerage onboarding"
            class="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <label class="block">
          <span class="block text-xs font-semibold text-foreground/80">
            CSV (header row required)
          </span>
          <textarea
            v-model="csvText"
            rows="10"
            class="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            :placeholder="sampleCSV"
          />
        </label>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
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
                <th class="py-2 pl-3 pr-2">Email</th>
                <th class="py-2 pr-2">Name</th>
                <th class="py-2 pr-2">Org slug</th>
                <th class="py-2 pr-2">Branch</th>
                <th class="py-2 pr-2">Role</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="(r, i) in previewRows.slice(0, 50)" :key="i">
                <td class="py-1.5 pl-3 pr-2 font-mono text-foreground">{{ r.email }}</td>
                <td class="py-1.5 pr-2 text-foreground">{{ r.full_name }}</td>
                <td class="py-1.5 pr-2 font-mono text-foreground/80">{{ r.organization_slug }}</td>
                <td class="py-1.5 pr-2 text-muted-foreground">{{ r.branch_slug || '—' }}</td>
                <td class="py-1.5 pr-2 text-muted-foreground">{{ r.org_role || 'senior_agent' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="previewRows.length > 50" class="px-3 py-2 text-[10px] text-muted-foreground">
            Showing first 50 of {{ previewRows.length }}. Stage to see them all.
          </p>
        </div>
      </div>
    </section>

    <!-- Section 2: Batches -->
    <section class="ui-card p-5">
      <header class="mb-4 flex items-end justify-between">
        <h2 class="text-section-title">Recent batches</h2>
      </header>

      <div v-if="batchesLoading" class="space-y-2">
        <div
          v-for="n in 3"
          :key="n"
          class="rounded-xl border border-border bg-background p-3"
        >
          <Skeleton class="h-3 w-1/3" />
          <Skeleton class="mt-2 h-2.5 w-1/2" />
          <div class="mt-2 flex gap-1">
            <Skeleton class="h-4 w-20 rounded-full" />
            <Skeleton class="h-4 w-24 rounded-full" />
          </div>
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
            <p class="text-sm font-semibold text-foreground">
              {{ b.source_label || `Batch ${b.id.slice(0, 8)}` }}
            </p>
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1"
              :class="
                b.status === 'processed'
                  ? 'bg-success/10 text-success ring-success/30'
                  : 'bg-warning/10 text-warning ring-warning/30'
              "
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
                class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                @click="toggleExpanded(b)"
              >
                {{ expandedBatch === b.id ? 'Hide rows' : 'View rows' }}
              </button>
            </div>
          </div>

          <!-- Outcome chips -->
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

          <!-- Expanded row detail -->
          <div v-if="expandedBatch === b.id" class="mt-3 border-t border-border pt-3">
            <div class="mb-2 flex items-center gap-2 text-xs">
              <span class="font-medium text-muted-foreground">Filter:</span>
              <select
                v-model="outcomeFilter"
                class="rounded-md border border-border bg-card px-2 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                @change="loadRows(b.id)"
              >
                <option value="">All outcomes</option>
                <option value="pending">Pending</option>
                <option value="linked_existing">Linked existing</option>
                <option value="already_member">Already member</option>
                <option value="invitation_created">Invitation created</option>
                <option value="duplicate_email_in_batch">Duplicate in batch</option>
                <option value="org_not_found">Org not found</option>
                <option value="branch_not_found">Branch not found</option>
                <option value="validation_error">Validation error</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div v-if="expandedRowsLoading" class="space-y-1.5">
              <Skeleton v-for="n in 4" :key="n" class="h-4 w-full" />
            </div>
            <p
              v-else-if="expandedRows.length === 0"
              class="text-xs text-muted-foreground"
            >
              No rows for this filter.
            </p>
            <div v-else class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th class="py-1.5 pr-2">#</th>
                    <th class="py-1.5 pr-2">Email</th>
                    <th class="py-1.5 pr-2">Org</th>
                    <th class="py-1.5 pr-2">Outcome</th>
                    <th class="py-1.5">Detail</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border">
                  <tr v-for="r in expandedRows" :key="r.id">
                    <td class="py-1.5 pr-2 tabular-nums text-muted-foreground">{{ r.row_number }}</td>
                    <td class="py-1.5 pr-2 font-mono text-foreground">{{ r.email }}</td>
                    <td class="py-1.5 pr-2 font-mono text-muted-foreground">
                      {{ r.organization_slug }}<span v-if="r.branch_slug">/{{ r.branch_slug }}</span>
                    </td>
                    <td class="py-1.5 pr-2">
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
