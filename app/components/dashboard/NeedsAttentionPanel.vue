<script setup lang="ts">
/**
 * Consolidated "Needs Attention" panel for the dashboard.
 *
 * Reads /api/dashboard/attention — single round-trip aggregator that
 * returns 7 operational sections (stale listings, duplicate candidates,
 * failed imports, listings missing images, failing webhooks, pending
 * verifications, pending shares). RLS scopes what each caller sees.
 *
 * Visual language: Linear-style row list. One row per non-empty
 * section: severity dot + label + count chip + age/sublabel + chevron
 * to drill in. Sections with zero items are hidden so the panel stays
 * compact when things are healthy.
 *
 * Empty state = full-width "All clear" celebratory card.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ArrowRight from 'vue-material-design-icons/ArrowRight.vue'

type Section = { count: number; items: any[]; note?: string }
type Attention = {
  total_count: number
  sections: {
    stale_listings: Section
    duplicate_candidates: Section
    failed_imports: Section
    listings_no_images: Section
    failing_webhooks: Section
    pending_verifications: Section
    pending_shares: Section
  }
}

const props = defineProps<{
  /** Pre-fetched attention payload from the parent. Optional —
   *  the panel will fetch on its own if not supplied. */
  data?: Attention | null
}>()
const emit = defineEmits<{ (e: 'loaded', a: Attention): void }>()

const internal = ref<Attention | null>(null)
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<Attention>('/api/dashboard/attention')
    internal.value = res
    emit('loaded', res)
  } catch {
    // Silent — panel renders an error state below from `errored`.
    errored.value = true
  } finally {
    loading.value = false
  }
}

const errored = ref(false)

onMounted(() => {
  if (!props.data) load()
  else {
    internal.value = props.data
    loading.value = false
  }
})

// Each row: severity, label, route to drill into, and the section
// key on the API payload. Order is deliberate — top of list is what
// the operator should look at first.
type Severity = 'critical' | 'warning' | 'info'
type Row = {
  key: keyof Attention['sections']
  label: string
  sublabel: string
  severity: Severity
  to: string | { path: string; query: Record<string, string> }
}

const ROWS: Row[] = [
  {
    key: 'failing_webhooks',
    label: 'Failing webhooks',
    sublabel: 'Subscriptions in 5+ consecutive failure state',
    severity: 'critical',
    to: '/admin?tab=webhooks',
  },
  {
    key: 'failed_imports',
    label: 'Failed listing imports',
    sublabel: 'Rows that did not resolve in the import pipeline',
    severity: 'critical',
    to: '/admin?tab=listing-import',
  },
  {
    key: 'pending_verifications',
    label: 'Pending verifications',
    sublabel: 'Listings awaiting verifier review',
    severity: 'warning',
    to: '/admin?tab=verifications',
  },
  {
    key: 'duplicate_candidates',
    label: 'Duplicate candidates',
    sublabel: 'Pairs the engine flagged for human review',
    severity: 'warning',
    to: '/admin?tab=duplicates',
  },
  {
    key: 'listings_no_images',
    label: 'Listings missing images',
    sublabel: 'Online listings with zero attached photos',
    severity: 'warning',
    to: '/listings?filter=no_images',
  },
  {
    key: 'stale_listings',
    label: 'Stale listings',
    sublabel: 'Online but not updated in 60+ days',
    severity: 'info',
    to: '/listings?filter=stale',
  },
  {
    key: 'pending_shares',
    label: 'Pending share invites',
    sublabel: 'Listings shared with you, awaiting your response',
    severity: 'info',
    to: '/shares',
  },
]

const router = useRouter()

const visibleRows = computed(() => {
  const att = internal.value
  if (!att) return []
  return ROWS.map((r) => ({ ...r, section: att.sections[r.key] }))
    .filter((r) => r.section.count > 0)
})

const isEmpty = computed(
  () => !loading.value && !errored.value && visibleRows.value.length === 0,
)

function severityClass(s: Severity): string {
  switch (s) {
    case 'critical':
      return 'bg-destructive'
    case 'warning':
      return 'bg-warning'
    case 'info':
      return 'bg-primary'
  }
}

function severityChipClass(s: Severity): string {
  switch (s) {
    case 'critical':
      return 'bg-destructive/10 text-destructive ring-destructive/30'
    case 'warning':
      return 'bg-warning/10 text-warning ring-warning/30'
    case 'info':
      return 'bg-primary/10 text-primary ring-primary/30'
  }
}

function go(to: Row['to']) {
  if (typeof to === 'string') router.push(to)
  else router.push(to)
}
</script>

<template>
  <section
    class="ui-card"
    aria-label="Needs attention"
  >
    <header class="flex items-center justify-between border-b border-border px-6 py-4">
      <div>
        <h2 class="text-section-title">Needs attention</h2>
        <p class="mt-0.5 text-meta">
          Operational items across the platform that benefit from human review.
        </p>
      </div>
      <button
        type="button"
        class="rounded-md p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-ring"
        :title="loading ? 'Loading…' : 'Refresh'"
        :disabled="loading"
        @click="load"
      >
        <ArrowRight :size="16" :class="loading ? 'animate-pulse' : ''" />
      </button>
    </header>

    <div v-if="loading && !internal" class="space-y-2 p-6">
      <div
        v-for="i in 4"
        :key="i"
        class="flex items-center gap-3 rounded-lg border border-border bg-background p-3"
      >
        <div class="h-2 w-2 rounded-full bg-muted-foreground/30" />
        <Skeleton class="h-3 flex-1" />
        <Skeleton class="h-5 w-10 rounded-full" />
      </div>
    </div>

    <div
      v-else-if="errored"
      class="m-6 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      Could not load attention items. Try refreshing.
    </div>

    <EmptyState
      v-else-if="isEmpty"
      variant="success"
      title="All clear"
      description="Nothing needs immediate review. New items will surface here as they appear."
    />

    <ul v-else class="divide-y divide-border">
      <li
        v-for="row in visibleRows"
        :key="row.key"
        class="group flex cursor-pointer items-center gap-4 px-6 py-3.5 transition-colors hover:bg-accent/50"
        @click="go(row.to)"
      >
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          :class="severityClass(row.severity)"
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-foreground">
            {{ row.label }}
          </p>
          <p class="truncate text-xs text-muted-foreground">
            {{ row.sublabel }}
          </p>
        </div>
        <span
          class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1"
          :class="severityChipClass(row.severity)"
        >
          {{ row.section.count.toLocaleString() }}
        </span>
        <ArrowRight
          :size="16"
          class="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
        />
      </li>
    </ul>
  </section>
</template>
