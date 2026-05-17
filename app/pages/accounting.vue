<script setup lang="ts">
/**
 * /accounting — domain dashboard.
 *
 * Real ledger-keeper landing rather than a tile menu:
 *   - KPI strip: posted entries (lifetime), draft entries, voided
 *   - Recent posted entries panel — quick scan of the latest journal
 *   - Drafts panel — entries not yet posted (need attention)
 *   - Jump-to chips for the rest of the accounting surface
 *
 * Uses /api/journal-entries?status=…; the endpoint paginates so the
 * counts here are upper bounds when there are >100 entries. Good
 * enough for a dashboard glance — a real "ledger close" UI lives
 * inside /admin/accounting.
 */
import { computed, onMounted, ref } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Accounting | Housing Interactive' })

type Entry = {
  id: string
  entry_no: number | null
  entry_date: string
  description: string | null
  reference_kind: string | null
  currency: string
  status: 'draft' | 'posted' | 'void'
  posted_at: string | null
  voided_at: string | null
  created_at: string
}

const posted = ref<Entry[]>([])
const drafts = ref<Entry[]>([])
const voided = ref<Entry[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const [postedRes, draftsRes, voidedRes] = await Promise.all([
      $fetch<{ data: Entry[] }>('/api/journal-entries', { query: { status: 'posted' } }).catch(() => ({ data: [] })),
      $fetch<{ data: Entry[] }>('/api/journal-entries', { query: { status: 'draft'  } }).catch(() => ({ data: [] })),
      $fetch<{ data: Entry[] }>('/api/journal-entries', { query: { status: 'void'   } }).catch(() => ({ data: [] })),
    ])
    posted.value = postedRes.data ?? []
    drafts.value = draftsRes.data ?? []
    voided.value = voidedRes.data ?? []
  } catch {
    posted.value = []
    drafts.value = []
    voided.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)

const recentPosted = computed<Entry[]>(() =>
  [...posted.value]
    .sort((a, b) => new Date(b.posted_at || b.entry_date).getTime() - new Date(a.posted_at || a.entry_date).getTime())
    .slice(0, 6),
)
const recentDrafts = computed<Entry[]>(() =>
  [...drafts.value]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 6),
)

function relativeDate(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function entryLabel(e: Entry): string {
  return e.description || (e.reference_kind ? `${e.reference_kind} entry` : `Entry #${e.entry_no ?? e.id.slice(0, 8)}`)
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="6xl">
    <UiPageHeader title="Accounting">
      <template #description>
        Ledger health — posted entries, draft queue, and voided
        history. Drill into the ledger for full detail.
      </template>
    </UiPageHeader>

    <!-- KPI strip -->
    <div class="grid gap-3 sm:grid-cols-3">
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Posted entries</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          {{ loading ? '—' : posted.length }}
        </p>
      </UiCard>
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Drafts</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          <span :class="drafts.length > 0 ? 'text-warning' : ''">
            {{ loading ? '—' : drafts.length }}
          </span>
        </p>
      </UiCard>
      <UiCard padding="md" class="text-center">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Voided</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-foreground">
          {{ loading ? '—' : voided.length }}
        </p>
      </UiCard>
    </div>

    <!-- Recent posted + Drafts -->
    <div class="grid gap-4 lg:grid-cols-2">
      <UiCard padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Recent posted</h2>
          <NuxtLink to="/admin/accounting" class="text-xs font-medium text-primary hover:underline focus-ring rounded">
            Open ledger →
          </NuxtLink>
        </header>
        <p v-if="loading" class="text-xs text-muted-foreground">Loading…</p>
        <p
          v-else-if="recentPosted.length === 0"
          class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
        >
          No posted entries yet.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="e in recentPosted"
            :key="e.id"
            class="rounded-md border border-border bg-card px-3 py-2 text-xs"
          >
            <div class="flex flex-wrap items-baseline gap-2">
              <UiBadge variant="success" size="xs">posted</UiBadge>
              <span class="min-w-0 flex-1 truncate text-foreground">{{ entryLabel(e) }}</span>
              <span class="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {{ relativeDate(e.posted_at || e.entry_date) }}
              </span>
            </div>
            <p v-if="e.entry_no || e.reference_kind" class="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
              <span v-if="e.entry_no">#{{ e.entry_no }}</span>
              <span v-if="e.entry_no && e.reference_kind"> · </span>
              <span v-if="e.reference_kind">{{ e.reference_kind }}</span>
            </p>
          </li>
        </ul>
      </UiCard>

      <UiCard padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Drafts awaiting post</h2>
          <NuxtLink to="/admin/journal-entry-new" class="text-xs font-medium text-primary hover:underline focus-ring rounded">
            New entry →
          </NuxtLink>
        </header>
        <p v-if="loading" class="text-xs text-muted-foreground">Loading…</p>
        <p
          v-else-if="recentDrafts.length === 0"
          class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
        >
          No drafts pending — ledger is clean.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="e in recentDrafts"
            :key="e.id"
            class="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs"
          >
            <div class="flex flex-wrap items-baseline gap-2">
              <UiBadge variant="warning" size="xs">draft</UiBadge>
              <span class="min-w-0 flex-1 truncate text-foreground">{{ entryLabel(e) }}</span>
              <span class="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {{ relativeDate(e.created_at) }}
              </span>
            </div>
          </li>
        </ul>
      </UiCard>
    </div>

    <!-- Jump-to chips -->
    <section class="border-t border-border pt-4">
      <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Jump to
      </p>
      <div class="flex flex-wrap gap-2">
        <NuxtLink to="/admin/accounting" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Ledger</NuxtLink>
        <NuxtLink to="/admin/journal-entry-new" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">New entry</NuxtLink>
        <NuxtLink to="/admin/bank-reconciliation" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Bank reconcile</NuxtLink>
        <NuxtLink to="/admin/statements" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Statements</NuxtLink>
        <NuxtLink to="/admin/platform-commission-rule" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Commissions</NuxtLink>
        <NuxtLink to="/admin/platform-fees" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Platform fees</NuxtLink>
        <NuxtLink to="/admin/bir-2306" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">BIR 2306</NuxtLink>
        <NuxtLink to="/admin/bir-2307" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">BIR 2307</NuxtLink>
        <NuxtLink to="/admin/eis-submissions" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">EIS</NuxtLink>
        <NuxtLink to="/admin/audit-export" class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring">Audit export</NuxtLink>
      </div>
    </section>
  </AdminPageShell>
</template>
