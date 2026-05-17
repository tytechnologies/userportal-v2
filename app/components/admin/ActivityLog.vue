<script setup lang="ts">
/**
 * Admin activity log browser.
 *
 * Reads /api/admin/activities (just shipped). Filters on entity,
 * action prefix, actor, date range. Pagination at 25/page.
 *
 * Actor names hydrated client-side via public_profiles — avoids
 * coupling the activities row shape to the join.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Activity = {
  id: string
  user_id: string | null
  action: string
  entity: string
  entity_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

type ProfileLite = {
  id: string
  full_name: string | null
  avatar_url: string | null
  slug: string | null
}

const supabase = useSupabaseClient()

const PAGE_SIZE = 25
const ENTITY_OPTIONS = [
  { value: '', label: 'All entities' },
  { value: 'listing', label: 'Listings' },
  { value: 'contact', label: 'Contacts' },
  { value: 'task', label: 'Tasks' },
  { value: 'note', label: 'Notes' },
  { value: 'inquiry', label: 'Inquiries' },
  { value: 'document', label: 'Documents' },
  { value: 'verification', label: 'Verifications' },
] as const

const items = ref<Activity[]>([])
const profiles = ref<Record<string, ProfileLite>>({})
const total = ref(0)
const totalPages = ref(1)
const loading = ref(true)
const refreshing = ref(false)

const page = ref(1)
const entityFilter = ref('')
const actionPrefix = ref('')
const sinceFilter = ref('') // YYYY-MM-DD
const untilFilter = ref('')

async function load() {
  refreshing.value = true
  try {
    const params: Record<string, string | number> = {
      page: page.value,
      page_size: PAGE_SIZE,
    }
    if (entityFilter.value) params.entity = entityFilter.value
    if (actionPrefix.value.trim()) params.action_prefix = actionPrefix.value.trim()
    if (sinceFilter.value) {
      params.since = new Date(`${sinceFilter.value}T00:00:00Z`).toISOString()
    }
    if (untilFilter.value) {
      params.until = new Date(`${untilFilter.value}T23:59:59Z`).toISOString()
    }

    // Cast through unknown — Nitro's typed-router triggers TS2589 on
    // the dynamic query bag.
    const res = await ($fetch('/api/admin/activities', { query: params } as any) as unknown as Promise<{
      data: Activity[]
      total: number
      total_pages: number
    }>)
    items.value = res.data
    total.value = res.total
    totalPages.value = res.total_pages || 1

    await hydrateProfiles()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load activities',
      icon: 'error',
    })
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

async function hydrateProfiles() {
  const ids = Array.from(
    new Set(items.value.map((a) => a.user_id).filter((id): id is string => !!id)),
  )
  // Skip ones we already have cached.
  const missing = ids.filter((id) => !profiles.value[id])
  if (missing.length === 0) return

  try {
    const { data } = await (supabase as any)
      .from('public_profiles')
      .select('id, full_name, avatar_url, slug')
      .in('id', missing)
    const next = { ...profiles.value }
    for (const p of (data ?? []) as ProfileLite[]) next[p.id] = p
    profiles.value = next
  } catch {
    // Profile hydration failure is non-fatal — rows render with the
    // raw uuid instead. Don't toast; admins can read uuids.
  }
}

// Re-load on filter change. Reset page to 1 to avoid landing on
// an out-of-range page when filters narrow the result set.
watch([entityFilter, actionPrefix, sinceFilter, untilFilter], () => {
  page.value = 1
  load()
})
watch(page, load)

function changePage(next: number) {
  if (next < 1 || next > totalPages.value) return
  page.value = next
}

function actorLabel(a: Activity): string {
  if (!a.user_id) return 'system'
  const p = profiles.value[a.user_id]
  if (p?.full_name) return p.full_name
  return a.user_id.slice(0, 8) + '…'
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

function metadataPreview(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) return ''
  // Show the first few keys as "k=v · k=v" — full JSON is in the
  // expand panel. Keep this terse so the row doesn't blow up.
  const keys = Object.keys(metadata).slice(0, 4)
  return keys
    .map((k) => {
      const v = metadata[k]
      if (v == null) return `${k}=null`
      if (typeof v === 'object') return `${k}=…`
      const s = String(v)
      return s.length > 30 ? `${k}=${s.slice(0, 27)}…` : `${k}=${s}`
    })
    .join(' · ')
}

const expanded = ref<Set<string>>(new Set())
function toggleExpand(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
  expanded.value = new Set(expanded.value)
}

function clearFilters() {
  entityFilter.value = ''
  actionPrefix.value = ''
  sinceFilter.value = ''
  untilFilter.value = ''
}

const isEmpty = computed(() => !loading.value && items.value.length === 0)

onMounted(load)
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 class="text-base font-semibold text-foreground">Activity log</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Unified audit trail across listings, CRM, documents,
          verifications, and sources.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span class="rounded-full bg-muted-foreground/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground/80">
          {{ total.toLocaleString() }} {{ total === 1 ? 'event' : 'events' }}
        </span>
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="refreshing"
          @click="load"
        >
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>
    </header>

    <!-- Filters -->
    <div class="grid grid-cols-1 gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
      <label class="block text-xs">
        <span class="block font-semibold text-foreground/80">Entity</span>
        <select
          v-model="entityFilter"
          class="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option v-for="opt in ENTITY_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label class="block text-xs">
        <span class="block font-semibold text-foreground/80">Action prefix</span>
        <input
          v-model="actionPrefix"
          type="text"
          placeholder="e.g. listing.archived"
          class="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label class="block text-xs">
        <span class="block font-semibold text-foreground/80">Since</span>
        <input
          v-model="sinceFilter"
          type="date"
          class="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label class="block text-xs">
        <span class="block font-semibold text-foreground/80">Until</span>
        <input
          v-model="untilFilter"
          type="date"
          class="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <div class="flex items-end">
        <button
          type="button"
          class="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          @click="clearFilters"
        >
          Clear filters
        </button>
      </div>
    </div>

    <!-- Loading: 6-row skeleton matching the row layout. -->
    <div
      v-if="loading"
      class="rounded-lg border border-border bg-card"
    >
      <div
        v-for="n in 6"
        :key="n"
        class="flex items-start gap-3 border-b border-border px-4 py-3 last:border-0"
      >
        <Skeleton class="h-5 w-16 rounded-full" />
        <div class="flex-1 space-y-1.5">
          <Skeleton class="h-3 w-2/3" />
          <Skeleton class="h-2.5 w-1/2" />
        </div>
        <Skeleton class="h-3 w-12" />
      </div>
    </div>

    <section
      v-else-if="isEmpty"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        variant="neutral"
        size="cozy"
        title="No activities match these filters"
        description="Try widening the date range, removing the action prefix, or selecting a different entity."
      />
    </section>

    <!-- Rows -->
    <ul
      v-else
      class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
    >
      <li
        v-for="a in items"
        :key="a.id"
        class="transition-colors hover:bg-accent/40"
      >
        <button
          type="button"
          class="flex w-full items-start gap-3 px-4 py-3 text-left"
          @click="toggleExpand(a.id)"
        >
          <span
            class="mt-0.5 inline-flex shrink-0 rounded-full bg-muted-foreground/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/70 ring-1 ring-muted-foreground/15"
          >
            {{ a.entity }}
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-foreground">
              <code class="font-mono">{{ a.action }}</code>
              <span class="text-muted-foreground"> by </span>
              <span class="font-semibold">{{ actorLabel(a) }}</span>
            </p>
            <p
              v-if="metadataPreview(a.metadata)"
              class="mt-0.5 truncate text-xs text-muted-foreground"
            >
              {{ metadataPreview(a.metadata) }}
            </p>
          </div>
          <span class="shrink-0 text-[11px] text-muted-foreground">
            {{ relativeTime(a.created_at) }}
          </span>
        </button>

        <!-- Expanded JSON -->
        <pre
          v-if="expanded.has(a.id)"
          class="mx-4 mb-3 overflow-x-auto rounded-lg border border-border bg-background p-3 text-[11px] text-foreground/80"
        >{{ JSON.stringify({
          id: a.id,
          entity_id: a.entity_id,
          created_at: a.created_at,
          metadata: a.metadata,
        }, null, 2) }}</pre>
      </li>
    </ul>

    <!-- Pagination -->
    <div
      v-if="!loading && totalPages > 1"
      class="flex items-center justify-between text-xs"
    >
      <button
        type="button"
        class="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="page <= 1 || refreshing"
        @click="changePage(page - 1)"
      >
        ← Previous
      </button>
      <span class="tabular-nums text-muted-foreground">
        Page {{ page }} of {{ totalPages }}
      </span>
      <button
        type="button"
        class="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="page >= totalPages || refreshing"
        @click="changePage(page + 1)"
      >
        Next →
      </button>
    </div>
  </section>
</template>
