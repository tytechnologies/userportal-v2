<script setup lang="ts">
// Drafts dashboard. Lists every draft + import the caller can see
// (RLS-scoped) with quick links to open / delete and a "+ New" CTA.

import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  useDocumentDrafts,
  type DocumentDraft,
} from '~/composables/useDocumentDrafts'
import { documentTemplates, findTemplate } from '~/utils/documentTemplates'
import DocumentUploader from '~/components/documents/DocumentUploader.vue'
import PendingMyReviewPanel from '~/components/documents/PendingMyReviewPanel.vue'
import ActiveEnvelopesPanel from '~/components/documents/ActiveEnvelopesPanel.vue'
import RecentExportsPanel from '~/components/documents/RecentExportsPanel.vue'
import NewDocumentWizardModal from '~/components/listings/NewDocumentWizardModal.vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiTabBar from '~/components/ui/UiTabBar.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Document Drafts | Housinginteractive' })

const { listDrafts, deleteDraft, transitionDraft, saveDraft } = useDocumentDrafts()
const router = useRouter()
const supabase = useSupabaseClient()

// Active tag filter — when set, listDrafts is called with ?tag=...
// (server-side via the GIN index). Single-tag for v1; multi-tag would
// be either OR (containment with any) or AND (containment with all);
// pick when usage demands it.
const activeTag = ref<string | null>(null)

// Lifecycle tab — server-filtered status. 'all' is the unified view
// (no filter), each other value maps to a draft status.
type StatusTab = 'all' | 'draft' | 'in_review' | 'signed' | 'archived'
const activeStatus = ref<StatusTab>('all')

const drafts = ref<DocumentDraft[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const search = ref('')
const showImporter = ref(false)
// Wizard modal state — opened by the "+ New draft" button in the
// page header. Mirrors the navbar quick-create wiring.
const docWizardOpen = ref(false)

// Hydrate contact + listing display labels for the linkage column.
// Keyed by id; the lists page can have many drafts pointing at the
// same contact/listing, so we batch-read each set once.
const contactLabels = ref<Record<number, string>>({})
const listingLabels = ref<Record<number, string>>({})

async function hydrateLinks(rows: DocumentDraft[]) {
  const contactIds = Array.from(new Set(rows.map(r => r.contact_id).filter((x): x is number => !!x)))
  const listingIds = Array.from(new Set(rows.map(r => r.listing_id).filter((x): x is number => !!x)))

  // Run both reads in parallel — neither blocks the page paint; the
  // table renders without labels and re-renders once they arrive.
  const [contactRes, listingRes] = await Promise.all([
    contactIds.length
      ? (supabase as any).from('contacts').select('id, full_name').in('id', contactIds)
      : Promise.resolve({ data: [] }),
    listingIds.length
      ? (supabase as any).from('listing_details').select('listing_id, title').in('listing_id', listingIds)
      : Promise.resolve({ data: [] }),
  ])
  for (const c of (contactRes.data ?? [])) {
    contactLabels.value[c.id] = c.full_name || `Contact #${c.id}`
  }
  for (const l of (listingRes.data ?? [])) {
    listingLabels.value[l.listing_id] = l.title || `Listing #${l.listing_id}`
  }
}

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    drafts.value = await listDrafts({
      limit: 200,
      tag: activeTag.value ?? undefined,
      status: activeStatus.value === 'all' ? undefined : activeStatus.value,
    })
    // Hydrate links in the background — UI is already rendered.
    hydrateLinks(drafts.value)
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Failed to load drafts.'
  } finally {
    isLoading.value = false
  }
}
onMounted(load)
watch(activeTag, () => load())
watch(activeStatus, () => load())

// Distinct tags across the currently-loaded set — drives the filter
// chip strip. Computed against drafts.value so it shrinks when the
// tag filter narrows the list, but at least the active tag stays
// pinned so users can deselect.
const knownTags = computed(() => {
  const set = new Set<string>()
  if (activeTag.value) set.add(activeTag.value)
  for (const d of drafts.value) {
    for (const t of d.tags ?? []) set.add(t)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b))
})

async function editTags(d: DocumentDraft) {
  // Crude prompt-based editor — good enough for v1. A proper popover
  // editor lands when usage demands. Comma-separated; trims, dedupes
  // server-side.
  const current = (d.tags ?? []).join(', ')
  const next = window.prompt('Tags (comma-separated):', current)
  if (next === null) return // cancelled
  const tags = next.split(',').map(s => s.trim()).filter(Boolean)
  try {
    const updated = await saveDraft(d.id, { tags })
    const idx = drafts.value.findIndex(x => x.id === d.id)
    if (idx >= 0) drafts.value[idx] = { ...drafts.value[idx], ...updated }
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not update tags.', icon: 'error' })
  }
}

// Selection state for bulk actions. Held as a Set keyed by draft id;
// cleared when the filter changes or after a bulk op completes.
const selectedIds = ref(new Set<string>())
const isBulkBusy = ref(false)

function toggleSelected(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

const visibleIds = computed(() => filtered.value.map(d => d.id))
const allVisibleSelected = computed(() =>
  visibleIds.value.length > 0 && visibleIds.value.every(id => selectedIds.value.has(id)),
)

function toggleSelectAll() {
  if (allVisibleSelected.value) {
    // Deselect just the currently visible set; preserves selections
    // that are filtered out.
    const next = new Set(selectedIds.value)
    for (const id of visibleIds.value) next.delete(id)
    selectedIds.value = next
  } else {
    const next = new Set(selectedIds.value)
    for (const id of visibleIds.value) next.add(id)
    selectedIds.value = next
  }
}

function clearSelection() {
  selectedIds.value = new Set()
}

// Bulk operations: each acts on the current selection. Promise.allSettled
// so a single 403/404 doesn't kill the rest of the batch — we tally
// success vs failure and surface a single toast.
async function bulkArchive() {
  await runBulk('Archive', (id) => transitionDraft(id, 'archived'))
}
async function bulkSubmitForReview() {
  await runBulk('Mark for review', (id) => transitionDraft(id, 'in_review'))
}
async function bulkDelete() {
  const n = selectedIds.value.size
  if (!window.confirm(`Delete ${n} draft${n === 1 ? '' : 's'}? This cannot be undone.`)) return
  await runBulk('Delete', (id) => deleteDraft(id), true)
}

async function runBulk(
  label: string,
  op: (id: string) => Promise<unknown>,
  removeOnSuccess = false,
) {
  if (selectedIds.value.size === 0 || isBulkBusy.value) return
  isBulkBusy.value = true
  const ids = Array.from(selectedIds.value)
  const results = await Promise.allSettled(ids.map((id) => op(id)))
  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed = results.length - succeeded

  // Update local state. For deletes we drop rows; for transitions we
  // reload to pick up the new status (cheap — same endpoint as the
  // initial paint).
  if (removeOnSuccess) {
    const failedIds = new Set(
      results
        .map((r, i) => (r.status === 'rejected' ? ids[i] : null))
        .filter((x): x is string => !!x),
    )
    drafts.value = drafts.value.filter(d => !ids.includes(d.id) || failedIds.has(d.id))
  } else {
    await load()
  }
  selectedIds.value = new Set()
  isBulkBusy.value = false

  if (failed === 0) {
    showToast({ title: `${label}: ${succeeded} draft${succeeded === 1 ? '' : 's'} updated.`, icon: 'success' })
  } else if (succeeded === 0) {
    showToast({ title: `${label} failed for all ${failed} drafts.`, icon: 'error' })
  } else {
    showToast({ title: `${label}: ${succeeded} updated, ${failed} failed.`, icon: 'warning' })
  }
}

// Pending action buckets — derived from the drafts list. Each draft
// gets categorized into at most one bucket so the user sees a single
// counter per concern (no double-counting).
const pendingBuckets = computed(() => {
  const now = Date.now()
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  const awaitingSig: DocumentDraft[] = []
  const stalled: DocumentDraft[] = []
  const recentlySigned: DocumentDraft[] = []

  for (const d of drafts.value) {
    if (d.status === 'in_review') {
      awaitingSig.push(d)
      continue
    }
    if (d.status === 'signed' && d.updated_at && now - new Date(d.updated_at).getTime() < sevenDaysMs) {
      recentlySigned.push(d)
      continue
    }
    // Stalled = a draft that hasn't moved in 7+ days. Only count
    // 'draft' status; archived/signed are intentional terminals.
    if (
      d.status === 'draft'
      && d.updated_at
      && now - new Date(d.updated_at).getTime() > sevenDaysMs
    ) {
      stalled.push(d)
    }
  }
  return { awaitingSig, stalled, recentlySigned }
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return drafts.value
  return drafts.value.filter((d) => {
    const hay = [d.title, d.template_id, JSON.stringify(d.data ?? {}), d.storage_path]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
})

function templateName(d: DocumentDraft) {
  if (d.template_id) {
    const t = findTemplate(d.template_id)
    return t?.name ?? d.template_id
  }
  if (d.storage_path) return 'Imported file'
  return 'Untitled'
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function open(d: DocumentDraft) {
  router.push(`/document-drafts/${d.id}`)
}

type StatusBadgeVariant = 'neutral' | 'warning' | 'success'
function statusVariant(s: string): StatusBadgeVariant {
  if (s === 'in_review') return 'warning'
  if (s === 'signed') return 'success'
  return 'neutral'
}

const STATUS_TABS = [
  { value: 'all',         label: 'All' },
  { value: 'draft',       label: 'Drafts' },
  { value: 'in_review',   label: 'In review' },
  { value: 'signed',      label: 'Signed' },
  { value: 'archived',    label: 'Archived' },
] as const

async function remove(d: DocumentDraft) {
  if (!window.confirm(`Delete "${d.title || 'this draft'}"? This cannot be undone.`)) return
  try {
    await deleteDraft(d.id)
    drafts.value = drafts.value.filter((x) => x.id !== d.id)
    showToast({ title: 'Draft deleted.', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not delete.', icon: 'error' })
  }
}

function onImported(d: DocumentDraft) {
  drafts.value.unshift(d)
  showImporter.value = false
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <UiPageHeader title="Documents">
      <template #description>
        Drafts, imports, and the full doc lifecycle.
        <NuxtLink to="/documents" class="text-primary hover:underline">View generated PDFs/DOCX →</NuxtLink>
      </template>
      <template #actions>
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring"
          @click="showImporter = !showImporter"
        >
          {{ showImporter ? 'Hide importer' : 'Import file' }}
        </button>
        <!-- + New draft now opens the same wizard the listing/deal/
             contact surfaces use (Upload Existing / AI Generate /
             Template). No anchors are passed here — the broker
             attaches the draft to a listing/contact later from the
             draft's Linked tab. The legacy template-picker page at
             /document-drafts/new still works as a fallback. -->
        <button
          type="button"
          class="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
          @click="docWizardOpen = true"
        >
          + New draft
        </button>
      </template>
    </UiPageHeader>

    <!-- Wizard modal — listing-id/contact-id null because there's
         no entity context on the docs hub. Brokers can attach later. -->
    <NewDocumentWizardModal
      :open="docWizardOpen"
      :listing-id="null"
      :contact-id="null"
      @update:open="docWizardOpen = $event"
    />

    <!-- Reviewer queue — sits at the top so reviewers see "what's
         waiting on me" before they touch the lifecycle tabs. Self-
         hides when the queue is empty. -->
    <PendingMyReviewPanel />

    <!-- Sender queue — in-flight DocuSign envelopes the caller sent.
         Mirrors PendingMyReviewPanel for the opposite side: things
         I'm waiting on others to do. Also self-hides when empty. -->
    <ActiveEnvelopesPanel />

    <!-- Recent DOCX/PDF artifacts you generated. Re-signs S3 URLs on
         demand so the panel never holds a stale link. Self-hides when
         no exports exist yet. -->
    <RecentExportsPanel />

    <!-- Lifecycle tabs. Server-filtered status; mirrors the editor's
         status state machine (draft → in_review → signed → archived). -->
    <UiTabBar
      v-model="activeStatus"
      :tabs="STATUS_TABS as any"
      variant="underline"
      :underline-full="true"
      aria-label="Document status"
    />

    <DocumentUploader v-if="showImporter" @imported="onImported" />

    <!-- Pending action widget: at-a-glance buckets so the dashboard is
         an action queue, not just a chronological dump. -->
    <div
      v-if="!isLoading && drafts.length > 0"
      class="grid gap-3 sm:grid-cols-3"
    >
      <UiCard padding="sm">
        <p class="text-eyebrow">Awaiting signature</p>
        <p
          class="mt-1 text-2xl font-bold tabular-nums"
          :class="pendingBuckets.awaitingSig.length > 0 ? 'text-warning' : 'text-muted-foreground/70'"
        >
          {{ pendingBuckets.awaitingSig.length }}
        </p>
        <p class="text-[11px] text-muted-foreground/70">In review status</p>
      </UiCard>
      <UiCard padding="sm">
        <p class="text-eyebrow">Stalled drafts</p>
        <p
          class="mt-1 text-2xl font-bold tabular-nums"
          :class="pendingBuckets.stalled.length > 0 ? 'text-destructive' : 'text-muted-foreground/70'"
        >
          {{ pendingBuckets.stalled.length }}
        </p>
        <p class="text-[11px] text-muted-foreground/70">Untouched 7+ days</p>
      </UiCard>
      <UiCard padding="sm">
        <p class="text-eyebrow">Recently signed</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-success">
          {{ pendingBuckets.recentlySigned.length }}
        </p>
        <p class="text-[11px] text-muted-foreground/70">Last 7 days</p>
      </UiCard>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <input
        v-model="search"
        type="search"
        placeholder="Search by title, template, or content…"
        class="w-full max-w-md rounded-md border border-border bg-card px-3 py-2 text-sm focus-ring"
      />
      <label
        v-if="filtered.length > 0"
        class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
      >
        <input
          type="checkbox"
          class="h-3.5 w-3.5 cursor-pointer accent-primary"
          :checked="allVisibleSelected"
          @change="toggleSelectAll"
        />
        Select all visible
      </label>
    </div>

    <!-- Tag filter chips -->
    <div
      v-if="knownTags.length > 0 || activeTag"
      class="flex flex-wrap items-center gap-1.5"
    >
      <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tags:</span>
      <button
        type="button"
        class="rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-150 ease-out focus-ring"
        :class="activeTag === null ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
        @click="activeTag = null"
      >
        All
      </button>
      <button
        v-for="t in knownTags"
        :key="t"
        type="button"
        class="rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-150 ease-out focus-ring"
        :class="activeTag === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
        @click="activeTag = activeTag === t ? null : t"
      >
        {{ t }}
      </button>
    </div>

    <UiCard v-if="isLoading" padding="none">
      <ul class="divide-y divide-border">
        <li v-for="n in 5" :key="n" class="flex items-center gap-3 px-4 py-3">
          <UiSkeleton class="h-8 w-8 rounded-md" />
          <div class="flex-1 space-y-2">
            <UiSkeleton class="h-3 w-1/3" />
            <UiSkeleton class="h-3 w-1/2" />
          </div>
        </li>
      </ul>
    </UiCard>

    <UiCard
      v-else-if="errorMessage"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-center text-sm text-destructive"
    >
      {{ errorMessage }}
      <button class="ml-2 underline focus-ring rounded" @click="load">Try again</button>
    </UiCard>

    <UiCard
      v-else-if="filtered.length === 0"
      padding="md"
      class="border-dashed text-center"
    >
      <p class="text-sm text-muted-foreground">
        {{ search ? 'No matches.' : 'No drafts yet — create one or import a file.' }}
      </p>
    </UiCard>

    <UiCard v-else padding="none">
      <ul class="divide-y divide-border">
        <li
          v-for="d in filtered"
          :key="d.id"
          class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
          :class="selectedIds.has(d.id) ? 'bg-primary/10' : ''"
        >
          <input
            type="checkbox"
            class="h-4 w-4 shrink-0 cursor-pointer accent-primary"
            :checked="selectedIds.has(d.id)"
            :title="selectedIds.has(d.id) ? 'Deselect' : 'Select for bulk action'"
            @click.stop
            @change="toggleSelected(d.id)"
          />
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-sm"
            aria-hidden="true"
          >
            {{ d.storage_path ? '📄' : '✏️' }}
          </div>
          <div class="min-w-0 flex-1">
            <button
              type="button"
              class="block truncate text-left text-sm font-semibold text-foreground transition-colors duration-150 ease-out hover:text-primary hover:underline focus-ring rounded"
              @click="open(d)"
            >
              {{ d.title || templateName(d) }}
            </button>
            <p class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <UiBadge variant="neutral" size="xs">
                {{ d.storage_path ? 'IMPORT' : 'DRAFT' }}
              </UiBadge>
              <UiBadge :variant="statusVariant(d.status)" size="xs">
                {{ d.status }}
              </UiBadge>
              <span>{{ templateName(d) }}</span>
              <span class="text-muted-foreground/70">{{ formatDate(d.updated_at) }}</span>
            </p>
            <!-- CRM linkage row. Only renders when at least one of
                 contact_id / listing_id is set; the labels hydrate
                 asynchronously (see hydrateLinks above). -->
            <p v-if="d.contact_id || d.listing_id" class="mt-1 truncate text-xs text-muted-foreground">
              For:
              <NuxtLink
                v-if="d.contact_id"
                :to="`/contacts/${d.contact_id}`"
                class="text-primary hover:underline"
                @click.stop
              >
                {{ contactLabels[d.contact_id] || `Contact #${d.contact_id}` }}
              </NuxtLink>
              <span v-if="d.contact_id && d.listing_id" class="text-muted-foreground/70"> · </span>
              <NuxtLink
                v-if="d.listing_id"
                :to="`/listings/${d.listing_id}`"
                class="text-primary hover:underline"
                @click.stop
              >
                {{ listingLabels[d.listing_id] || `Listing #${d.listing_id}` }}
              </NuxtLink>
            </p>

            <!-- Tags row. Each pill is clickable to filter; the leading
                 edit button replaces all tags via prompt(). -->
            <p class="mt-1 flex flex-wrap items-center gap-1">
              <button
                type="button"
                class="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring"
                :title="(d.tags && d.tags.length) ? 'Edit tags' : 'Add tags'"
                @click.stop="editTags(d)"
              >
                {{ (d.tags && d.tags.length) ? '✎ tags' : '+ tag' }}
              </button>
              <button
                v-for="t in (d.tags ?? [])"
                :key="t"
                type="button"
                class="rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-150 ease-out focus-ring"
                :class="activeTag === t ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary hover:bg-primary/15'"
                @click.stop="activeTag = activeTag === t ? null : t"
              >
                {{ t }}
              </button>
            </p>
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
              @click="open(d)"
            >
              Open
            </button>
            <button
              type="button"
              class="rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors duration-150 ease-out hover:bg-destructive/15 focus-ring"
              @click="remove(d)"
            >
              Delete
            </button>
          </div>
        </li>
      </ul>
    </UiCard>

    <!-- Floating bulk action bar — sticky-bottom so it stays in view
         while scrolling. -->
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 translate-y-2"
    >
      <div
        v-if="selectedIds.size > 0"
        class="sticky bottom-4 z-30 mx-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-popover px-4 py-3 text-popover-foreground shadow-lg"
        role="region"
        aria-label="Bulk actions"
      >
        <span class="text-sm font-semibold text-foreground">
          {{ selectedIds.size }} draft{{ selectedIds.size === 1 ? '' : 's' }} selected
        </span>
        <div class="flex flex-1 flex-wrap justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:opacity-50"
            :disabled="isBulkBusy"
            @click="bulkSubmitForReview"
          >
            Mark for review
          </button>
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:opacity-50"
            :disabled="isBulkBusy"
            @click="bulkArchive"
          >
            Archive
          </button>
          <button
            type="button"
            class="rounded-lg bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors duration-150 ease-out hover:bg-destructive/15 focus-ring disabled:opacity-50"
            :disabled="isBulkBusy"
            @click="bulkDelete"
          >
            Delete
          </button>
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground focus-ring disabled:opacity-50"
            :disabled="isBulkBusy"
            @click="clearSelection"
          >
            Cancel
          </button>
        </div>
        <span v-if="isBulkBusy" class="text-xs text-muted-foreground">Working…</span>
      </div>
    </Transition>
  </AdminPageShell>
</template>
