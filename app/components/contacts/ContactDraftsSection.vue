<script setup lang="ts">
/**
 * Documents section for /contacts/[id]. Mirrors ListingDocumentsSection
 * but scoped by contact_id — a broker viewing a client's profile sees
 * every draft attached to that client (templates, AI-generated bodies,
 * uploaded PDFs).
 *
 * "+ New document" launches the same NewDocumentWizardModal used on
 * the listing and deal surfaces, with only the contact pre-linked.
 * The resulting draft has no listing_id; brokers can attach one later
 * from the editor if relevant.
 *
 * The component renders as a no-op when contactId is null (defensive
 * — the parent controls visibility).
 */
import { onMounted, ref, watch } from 'vue'
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
}

const props = defineProps<{
  contactId: number | null
}>()

const drafts = ref<Draft[]>([])
const loading = ref(false)
const errored = ref(false)

async function load() {
  if (!props.contactId) {
    drafts.value = []
    return
  }
  loading.value = true
  errored.value = false
  try {
    const res = await $fetch<{ data: Draft[] }>('/api/document-drafts', {
      query: { contact_id: props.contactId, limit: 50 },
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
watch(() => props.contactId, load)

const wizardOpen = ref(false)
function openWizard() {
  if (!props.contactId) return
  wizardOpen.value = true
}
function onWizardCreated() {
  load()
}

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
</script>

<template>
  <section v-if="contactId !== null" class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-3">
      <div>
        <h3 class="text-card-title">Documents</h3>
        <p class="mt-0.5 text-meta">
          Drafts, AI bodies, and uploaded PDFs linked to this contact.
        </p>
      </div>
      <button
        type="button"
        class="text-xs font-medium text-primary hover:underline focus-ring rounded"
        @click="openWizard"
      >
        + New document
      </button>
    </header>

    <!-- Loading skeleton -->
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

    <div
      v-else-if="drafts.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      No documents linked to this contact yet.
      <button
        type="button"
        class="ml-1 font-medium text-primary hover:underline focus-ring rounded"
        @click="openWizard"
      >
        Start one →
      </button>
    </div>

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

    <!-- Same wizard the listing + deal surfaces use. Pre-links the
         new draft to this contact only — listing stays unset. -->
    <NewDocumentWizardModal
      :open="wizardOpen"
      :contact-id="contactId"
      @update:open="wizardOpen = $event"
      @created="onWizardCreated"
    />
  </section>
</template>
