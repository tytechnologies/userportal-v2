<script setup lang="ts">
/**
 * Documents section for the listing detail drawer.
 *
 * Lists every document draft attached to this listing (any status:
 * draft, in_review, signed, archived) with a status badge per row.
 * Click a row to drill into the editor at /document-drafts/[id].
 * The "+ New document" button navigates to
 * /document-drafts/new?listing_id=X, where the existing flow pre-fills
 * the listing FK and lets the broker pick a template.
 *
 * Reads /api/document-drafts?listing_id={id} (already filters by
 * listing_id — RLS scopes to drafts the caller can see).
 *
 * The empty state nudges the broker to start the first document; the
 * loading state shows a row-shaped shimmer so the layout doesn't
 * reflow once data lands.
 */
import { ref, watch, onMounted } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import NewDocumentWizardModal from '~/components/listings/NewDocumentWizardModal.vue'

type Draft = {
  id: string
  template_key: string | null
  template_name?: string | null
  status: 'draft' | 'in_review' | 'signed' | 'archived'
  contact_id: number | null
  listing_id: number | null
  tags: string[] | null
  created_at: string
  updated_at: string
  /** data jsonb may carry the optional finalized-document pointer
   *  written by /api/document-drafts/[id]/upload-signed. */
  data?: { _finalized_document?: { path: string; uploaded_at: string } | null } | null
}

const props = defineProps<{
  /** Listing id to scope drafts to. Drawer renders nothing while null
   *  to avoid an unscoped fetch. */
  listingId: number | null
}>()

const drafts = ref<Draft[]>([])
const loading = ref(false)
const errored = ref(false)

async function load() {
  if (!props.listingId) {
    drafts.value = []
    return
  }
  loading.value = true
  errored.value = false
  try {
    const res = await $fetch<{ data: Draft[] }>('/api/document-drafts', {
      query: { listing_id: props.listingId, limit: 50 },
    })
    drafts.value = res.data ?? []
  } catch {
    drafts.value = []
    errored.value = true
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.listingId, load)

// Map draft status to UiBadge variant. Mirrors the inquiry/deal
// conventions: primary for "in motion", success for terminal good
// state (signed), neutral for archived.
function statusVariant(s: Draft['status']): 'neutral' | 'primary' | 'warning' | 'success' {
  switch (s) {
    case 'draft':     return 'neutral'
    case 'in_review': return 'warning'
    case 'signed':    return 'success'
    case 'archived':  return 'neutral'
  }
}

function statusLabel(s: Draft['status']): string {
  switch (s) {
    case 'draft':     return 'Draft'
    case 'in_review': return 'In review'
    case 'signed':    return 'Signed'
    case 'archived':  return 'Archived'
  }
}

function relativeTime(iso: string): string {
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
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function templateLabel(d: Draft): string {
  return d.template_name || d.template_key || 'Untitled document'
}

function openDraft(d: Draft) {
  if (typeof navigateTo === 'function') {
    navigateTo(`/document-drafts/${d.id}`)
  }
}

// Wizard modal state. Replaces the prior bare navigate-to-template-
// picker behavior — the broker now picks Upload vs. Generate, then
// Lease/Rental/Sale, before committing to a template or PDF.
const wizardOpen = ref(false)

function newDraft() {
  if (!props.listingId) return
  wizardOpen.value = true
}

function onWizardCreated() {
  // Refresh the list so the new draft (or uploaded PDF) shows up
  // immediately. The wizard navigates to the draft on success, so
  // this fires for the brief moment before the route change — and
  // matters when the user backs out to the listing drawer afterward.
  load()
}
</script>

<template>
  <div v-if="listingId !== null" class="mt-4 border-t border-border pt-4">
    <div class="mb-2 flex items-baseline justify-between gap-2">
      <h3 class="text-sm font-semibold text-foreground">Documents</h3>
      <button
        type="button"
        class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-ring rounded"
        @click="newDraft"
      >
        + New document
      </button>
    </div>

    <!-- Loading skeleton — matches the row footprint -->
    <div v-if="loading" class="space-y-1.5">
      <div
        v-for="n in 2"
        :key="n"
        class="flex items-center gap-2 rounded-md border border-border bg-card p-2"
      >
        <div class="h-3 w-1/2 animate-pulse rounded bg-muted-foreground/15" />
        <div class="ml-auto h-3 w-12 animate-pulse rounded bg-muted-foreground/15" />
      </div>
    </div>

    <p
      v-else-if="errored"
      class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      Could not load documents. Try refreshing the page.
    </p>

    <!-- Empty state — surfaces the new-document affordance prominently -->
    <div
      v-else-if="drafts.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      No documents attached to this listing yet.
      <button
        type="button"
        class="ml-1 font-medium text-primary hover:underline focus-ring rounded"
        @click="newDraft"
      >
        Start one →
      </button>
    </div>

    <!-- List of drafts: status + template + relative-time -->
    <ul v-else class="space-y-1.5">
      <li
        v-for="d in drafts"
        :key="d.id"
        class="group flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 transition-colors hover:border-border-strong hover:bg-accent focus-ring"
        tabindex="0"
        @click="openDraft(d)"
        @keydown.enter.prevent="openDraft(d)"
        @keydown.space.prevent="openDraft(d)"
      >
        <UiBadge :variant="statusVariant(d.status)" size="xs">
          {{ statusLabel(d.status) }}
        </UiBadge>
        <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {{ templateLabel(d) }}
        </span>
        <span
          v-if="d.data?._finalized_document"
          class="shrink-0 text-[10px] text-success"
          title="Final notarized PDF on file"
        >
          ✓ PDF
        </span>
        <span class="shrink-0 text-[10px] text-muted-foreground">
          {{ relativeTime(d.updated_at) }}
        </span>
      </li>
    </ul>

    <!-- Upload-or-generate wizard. Lives outside the v-if/v-else
         chain above so its presence doesn't break Vue's adjacent-
         sibling requirement on conditional rendering. Controlled
         purely via :open — mounted only when the user invokes it. -->
    <NewDocumentWizardModal
      :open="wizardOpen"
      :listing-id="listingId"
      @update:open="wizardOpen = $event"
      @created="onWizardCreated"
    />
  </div>
</template>
