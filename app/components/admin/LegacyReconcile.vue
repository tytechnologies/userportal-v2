<script setup lang="ts">
/**
 * Admin tool: reconcile *_legacy columns on listings.
 *
 * Three columns hold pre-FK string values that couldn't be retyped to
 * uuid (created_by_legacy, updated_by_legacy, deleted_by_legacy). For
 * each, the RPC suggests up to 5 profile matches by exact-name then
 * fuzzy similarity (pg_trgm). Admin clicks "Apply" to write the FK +
 * NULL the legacy column atomically; auditing happens server-side.
 *
 * Optimistic UI: row is removed from the local list on apply, restored
 * on failure. Only one row apply at a time per row to keep the UX
 * predictable.
 */
import { ref, onMounted, computed } from 'vue'
import { showToast } from '~/helpers/helpers'

type Candidate = {
  profile_id: string
  full_name: string | null
  score: number
  match_kind: 'exact' | 'fuzzy'
}

type Suggestion = {
  listing_id: number
  target_column: 'created_by' | 'updated_by' | 'deleted_by'
  legacy_value: string
  candidates: Candidate[]
}

type Counts = {
  created_by_legacy?: number
  updated_by_legacy?: number
  deleted_by_legacy?: number
}

type Summary = {
  counts: Counts
  suggestions: Suggestion[]
  total_suggestions: number
  has_trgm: boolean
  no_legacy_columns?: boolean
}

const PAGE = 25

const counts = ref<Counts>({})
const suggestions = ref<Suggestion[]>([])
const total = ref(0)
const hasTrgm = ref(false)
const noLegacyColumns = ref(false)
const offset = ref(0)
const loading = ref(true)
const submitting = ref<Record<string, boolean>>({})

function rowKey(s: Suggestion): string {
  return `${s.listing_id}:${s.target_column}`
}

async function load() {
  loading.value = true
  try {
    const res = await $fetch<Summary>(
      '/api/admin/legacy-reconcile/summary',
      { query: { limit: PAGE, offset: offset.value } },
    )
    counts.value = res.counts ?? {}
    suggestions.value = res.suggestions ?? []
    total.value = res.total_suggestions ?? 0
    hasTrgm.value = res.has_trgm ?? false
    noLegacyColumns.value = res.no_legacy_columns === true
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load summary',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function apply(s: Suggestion, candidate: Candidate) {
  const key = rowKey(s)
  if (submitting.value[key]) return

  // Optimistic remove.
  const prevIndex = suggestions.value.findIndex(
    (x) => x.listing_id === s.listing_id && x.target_column === s.target_column,
  )
  if (prevIndex < 0) return
  const removed = suggestions.value[prevIndex]!
  suggestions.value.splice(prevIndex, 1)
  total.value = Math.max(0, total.value - 1)
  // Decrement the column counter so the headline doesn't lie until
  // the next refresh.
  const col = `${s.target_column}_legacy` as keyof Counts
  if (typeof counts.value[col] === 'number') {
    counts.value = { ...counts.value, [col]: Math.max(0, (counts.value[col] || 0) - 1) }
  }

  submitting.value[key] = true
  try {
    await $fetch('/api/admin/legacy-reconcile/apply', {
      method: 'POST',
      body: {
        listing_id: s.listing_id,
        target_column: s.target_column,
        profile_id: candidate.profile_id,
      },
    })
    showToast({
      title: `Reconciled "${s.legacy_value}" → ${candidate.full_name || candidate.profile_id}`,
      icon: 'success',
    })
  } catch (err: any) {
    suggestions.value.splice(prevIndex, 0, removed)
    total.value = total.value + 1
    if (typeof counts.value[col] === 'number') {
      counts.value = { ...counts.value, [col]: (counts.value[col] || 0) + 1 }
    }
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to apply',
      icon: err?.statusCode === 409 ? 'warning' : 'error',
    })
  } finally {
    delete submitting.value[key]
  }
}

const isEmpty = computed(() => !loading.value && suggestions.value.length === 0)
const totalUnreconciled = computed(
  () =>
    (counts.value.created_by_legacy || 0) +
    (counts.value.updated_by_legacy || 0) +
    (counts.value.deleted_by_legacy || 0),
)

const pageInfo = computed(() => {
  const start = total.value === 0 ? 0 : offset.value + 1
  const end = Math.min(offset.value + suggestions.value.length, total.value)
  return { start, end }
})

function nextPage() {
  if (offset.value + PAGE >= total.value) return
  offset.value += PAGE
  load()
}

function prevPage() {
  if (offset.value === 0) return
  offset.value = Math.max(0, offset.value - PAGE)
  load()
}

function colLabel(col: string): string {
  return col.replace(/_/g, ' ')
}

function scoreLabel(c: Candidate): string {
  if (c.match_kind === 'exact') return 'exact'
  return `fuzzy ${(c.score * 100).toFixed(0)}%`
}

function scoreClasses(c: Candidate): string {
  if (c.match_kind === 'exact') return 'bg-success/15 text-success'
  if (c.score >= 0.75) return 'bg-warning/15 text-warning'
  return 'bg-muted text-foreground'
}

onMounted(load)
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold text-foreground">Legacy creator reconciliation</h2>
        <p class="text-sm text-muted-foreground">
          Match string values from <code class="rounded bg-muted-foreground/10 px-1">*_legacy</code>
          columns to profile records. Applying writes the canonical FK and clears the legacy column.
        </p>
      </div>
      <button
        type="button"
        class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        :disabled="loading"
        @click="load"
      >
        Refresh
      </button>
    </div>

    <!-- Headline counts -->
    <div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">created_by_legacy</p>
        <p class="mt-2 text-metric-value">{{ counts.created_by_legacy ?? 0 }}</p>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">updated_by_legacy</p>
        <p class="mt-2 text-metric-value">{{ counts.updated_by_legacy ?? 0 }}</p>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">deleted_by_legacy</p>
        <p class="mt-2 text-metric-value">{{ counts.deleted_by_legacy ?? 0 }}</p>
      </div>
    </div>

    <p v-if="!hasTrgm" class="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
      pg_trgm extension is not enabled — only exact-name matches are surfaced.
      Enable it in Supabase to get fuzzy candidates.
    </p>

    <div v-if="loading" class="space-y-3">
      <div
        v-for="n in 3"
        :key="n"
        class="rounded-lg border border-border bg-card p-4"
      >
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="mt-2 h-3 w-1/2" />
      </div>
    </div>

    <section
      v-else-if="noLegacyColumns"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        variant="success"
        size="cozy"
        title="No legacy columns to reconcile"
        description="This database has no *_legacy quarantine columns on listings. Either the data was never legacy-string-typed, or the columns have already been dropped after full reconciliation."
      />
    </section>

    <section
      v-else-if="totalUnreconciled === 0"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        variant="success"
        size="cozy"
        title="All legacy columns reconciled"
        description="The next migration can drop the *_legacy columns from listings."
      />
    </section>

    <section
      v-else-if="isEmpty"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        variant="neutral"
        size="cozy"
        title="No unreconciled rows on this page"
        description="Try Previous / Next to find rows that need attention."
      />
    </section>

    <ul v-else class="space-y-3">
      <li
        v-for="s in suggestions"
        :key="rowKey(s)"
        class="rounded-lg border border-border bg-card p-4"
      >
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p class="text-sm font-semibold text-foreground">
            Listing #{{ s.listing_id }}
          </p>
          <span class="rounded-full bg-muted-foreground/10 px-2 py-0.5 text-xs text-foreground/80 ring-1 ring-muted-foreground/15">
            {{ colLabel(s.target_column) }}
          </span>
          <p class="text-sm text-foreground/85">
            <span class="text-muted-foreground">value:</span>
            <span class="ml-1 font-mono">"{{ s.legacy_value }}"</span>
          </p>
        </div>

        <div v-if="s.candidates.length === 0" class="mt-3 text-sm text-muted-foreground">
          No matches found. Manual review required.
        </div>
        <ul v-else class="mt-3 space-y-2">
          <li
            v-for="c in s.candidates"
            :key="c.profile_id"
            class="flex flex-wrap items-center gap-2"
          >
            <span
              class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
              :class="scoreClasses(c)"
            >
              {{ scoreLabel(c) }}
            </span>
            <p class="text-sm text-foreground">
              {{ c.full_name || c.profile_id }}
            </p>
            <button
              type="button"
              class="ml-auto rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="!!submitting[rowKey(s)]"
              @click="apply(s, c)"
            >
              Apply
            </button>
          </li>
        </ul>
      </li>
    </ul>

    <div
      v-if="!loading && total > 0"
      class="mt-4 flex items-center justify-between text-xs text-muted-foreground"
    >
      <p>
        Showing {{ pageInfo.start }}–{{ pageInfo.end }} of {{ total }} unreconciled rows
      </p>
      <div class="flex gap-1">
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="offset === 0"
          @click="prevPage"
        >
          Previous
        </button>
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="offset + PAGE >= total"
          @click="nextPage"
        >
          Next
        </button>
      </div>
    </div>
  </div>
</template>
