<script setup lang="ts">
/**
 * Deal-scoped document drafts section.
 *
 * The deal connects a listing + a buyer contact. Documents (drafts)
 * naturally attach to one or the other:
 *   - listing agreements, listing-side disclosures   → drafts.listing_id
 *   - buyer rep agreements, KYC docs, IDs            → drafts.contact_id
 *   - reservation agreements, deeds of sale          → both
 *
 * The schema has no `document_drafts.deal_id` FK on purpose — adding
 * one would duplicate the listing/contact attribution. Instead, this
 * panel unions drafts attached to either side of the deal so the
 * broker can see every paper-trail item from one place.
 *
 * "+ Generate document" pre-fills BOTH query params so the new draft
 * is linked to the listing AND the contact when they exist.
 *
 * Companion to DealDocumentsPanel (which surfaces uploaded files
 * from the legacy `documents` table). Both render on the deal detail
 * page so brokers don't have to know which storage shape was used.
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
  data?: { _finalized_document?: { path: string; uploaded_at: string } | null } | null
  /** Source pill — which side of the deal pulled this draft in.
   *  Computed client-side after merging the two queries. */
  _source?: 'listing' | 'contact' | 'both'
}

const props = defineProps<{
  /** Deal id is unused for the query (drafts have no deal_id) but
   *  kept in the props surface for symmetry with DealDocumentsPanel
   *  and as a stable v-for key when the deal swaps. */
  dealId: string
  listingId: number | null
  contactId: number | null
}>()

const drafts = ref<Draft[]>([])
const loading = ref(false)
const errored = ref(false)

async function load() {
  if (props.listingId == null && props.contactId == null) {
    drafts.value = []
    return
  }
  loading.value = true
  errored.value = false
  try {
    // Two parallel filtered fetches — listing-attached + contact-
    // attached. Merge by id, tag _source for the badge. The existing
    // GET /api/document-drafts already exposes both filters; no new
    // endpoint needed.
    const [byListing, byContact] = await Promise.all([
      props.listingId != null
        ? $fetch<{ data: Draft[] }>('/api/document-drafts', {
            query: { listing_id: props.listingId, limit: 50 },
          }).catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] as Draft[] }),
      props.contactId != null
        ? $fetch<{ data: Draft[] }>('/api/document-drafts', {
            query: { contact_id: props.contactId, limit: 50 },
          }).catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] as Draft[] }),
    ])

    const map = new Map<string, Draft>()
    for (const d of byListing.data ?? []) {
      map.set(d.id, { ...d, _source: 'listing' })
    }
    for (const d of byContact.data ?? []) {
      const existing = map.get(d.id)
      if (existing) {
        existing._source = 'both'
      } else {
        map.set(d.id, { ...d, _source: 'contact' })
      }
    }
    // Sort newest-updated first.
    drafts.value = [...map.values()].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
  } catch {
    drafts.value = []
    errored.value = true
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.listingId, props.contactId], load)

defineExpose({ refresh: load })

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

function sourceLabel(s: Draft['_source']): string {
  switch (s) {
    case 'listing': return 'via listing'
    case 'contact': return 'via client'
    case 'both':    return 'via both'
    default:        return ''
  }
}

// Wizard modal state. Replaces the "+ Generate document" link that
// dropped the broker into the bare template-picker page — they now
// pick mode (Upload/Generate) → type (Lease/Rental/Sale) → action.
// The wizard pre-links the new draft to BOTH the deal's listing AND
// buyer contact when present, mirroring the listing/contact union
// query the panel itself uses to populate.
const wizardOpen = ref(false)
function openWizard() {
  if (props.listingId == null && props.contactId == null) return
  wizardOpen.value = true
}
function onWizardCreated() {
  // Refresh — wizard navigates to the new draft on success, so this
  // matters when the user backs out to the deal detail afterward.
  load()
}

function openDraft(d: Draft) {
  if (typeof navigateTo === 'function') {
    navigateTo(`/document-drafts/${d.id}`)
  }
}
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-3">
      <div>
        <h3 class="text-card-title">Document drafts</h3>
        <p class="mt-0.5 text-meta">
          Templates filled in for this deal — listing or buyer side.
          Auto-includes drafts attached to either.
        </p>
      </div>
      <button
        type="button"
        class="text-xs font-medium text-primary hover:underline focus-ring rounded disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="listingId == null && contactId == null"
        @click="openWizard"
      >
        + New document
      </button>
    </header>

    <!-- Loading state -->
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
      Could not load document drafts. Try refreshing.
    </p>

    <!-- Both ids missing — surfaces only when the deal has neither
         a listing nor a buyer contact. Encourages the operator to
         set the client first via the Client card above. -->
    <p
      v-else-if="listingId == null && contactId == null"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      Set a client (or attach a listing) to start drafting documents from this deal.
    </p>

    <!-- Empty state — surfaces the new-document affordance prominently -->
    <div
      v-else-if="drafts.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      No drafts attached to this deal yet.
      <button
        type="button"
        class="ml-1 font-medium text-primary hover:underline focus-ring rounded"
        @click="openWizard"
      >
        Start one →
      </button>
    </div>

    <!-- List of drafts -->
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
          v-if="d._source"
          class="hidden shrink-0 text-[10px] text-muted-foreground sm:inline"
          :title="`Linked ${sourceLabel(d._source)}`"
        >
          {{ sourceLabel(d._source) }}
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

    <!-- Upload-or-generate wizard. Mounted outside the v-if/v-else
         chain above so the conditional siblings stay adjacent. The
         wizard pre-links to BOTH listing + contact when present —
         a draft created here shows up on both the listing's
         document section and the buyer-contact's docs surface. -->
    <NewDocumentWizardModal
      :open="wizardOpen"
      :listing-id="listingId ?? null"
      :contact-id="contactId ?? null"
      @update:open="wizardOpen = $event"
      @created="onWizardCreated"
    />
  </section>
</template>
