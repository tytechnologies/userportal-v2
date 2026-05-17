<script setup lang="ts">
// Edit/view a single draft. Loads the draft, hands it to DocumentEditor
// for form drafts, or DocumentImportViewer for storage-backed drafts.

import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useDocumentDrafts,
  type DocumentDraft,
} from '~/composables/useDocumentDrafts'
import DocumentEditor from '~/components/documents/DocumentEditor.vue'
import DocumentImportViewer from '~/components/documents/DocumentImportViewer.vue'
import AiDocumentEditor from '~/components/documents/AiDocumentEditor.vue'
import FinalizedDocumentPanel from '~/components/documents/FinalizedDocumentPanel.vue'
import DocumentVersionsPanel from '~/components/documents/DocumentVersionsPanel.vue'
import DocumentDiffViewer from '~/components/documents/DocumentDiffViewer.vue'
import DocumentApprovalsPanel from '~/components/documents/DocumentApprovalsPanel.vue'
import SignaturePlaceholdersPanel from '~/components/documents/SignaturePlaceholdersPanel.vue'
import PartiesEditor from '~/components/documents/PartiesEditor.vue'
import ValidationPanel from '~/components/documents/ValidationPanel.vue'
import ExportPanel from '~/components/documents/ExportPanel.vue'
import AiAssistDrawer from '~/components/documents/AiAssistDrawer.vue'
import EsignEnvelopesPanel from '~/components/documents/EsignEnvelopesPanel.vue'
import DraftRoomsPanel from '~/components/documents/DraftRoomsPanel.vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiWorkspaceTabs, { type WorkspaceTab } from '~/components/ui/UiWorkspaceTabs.vue'
import UiBreadcrumb from '~/components/ui/UiBreadcrumb.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const { loadDraft, deleteDraft } = useDocumentDrafts()

const id = computed(() => String(route.params.id ?? ''))
const draft = ref<DocumentDraft | null>(null)
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)

useHead(() => ({ title: draft.value?.title ? `${draft.value.title} | Drafts` : 'Draft' }))

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    draft.value = await loadDraft(id.value)
  } catch (err: any) {
    if (err?.statusCode === 404) {
      errorMessage.value = 'Draft not found or not accessible.'
    } else {
      errorMessage.value = err?.message ?? 'Failed to load draft.'
    }
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

function onSaved(updated: DocumentDraft) {
  draft.value = updated
}
function onCreated(created: DocumentDraft) {
  draft.value = created
}

// FinalizedDocumentPanel emits a partial update with the new
// _finalized_document pointer + status after upload. Patch the local
// state so the panel re-renders without a full GET round-trip.
// The panel's internal Draft type is structurally compatible with
// DocumentDraft for the fields it touches (status + data), but
// declared independently to keep the panel's prop surface tight; the
// `any` here bridges that gap without leaking the wider type.
function onFinalizedUpdated(patch: Record<string, any>) {
  if (!draft.value) return
  draft.value = { ...draft.value, ...patch } as DocumentDraft
}

// Diff viewer pops in below the editor when the versions panel
// requests a comparison. State held here so the editor + versions
// panel stay decoupled.
type CompareState = {
  labelA: string
  labelB: string
  bodyA: string
  bodyB: string
} | null
const compareState = ref<CompareState>(null)

// ----- Workspace tabs ------------------------------------------------
// 5 tabs:
//   Editor    — body editor (template / AI / imported PDF)
//   Review    — parties, validation, signatures, approvals
//   Versions  — snapshots, diff viewer
//   Export    — DOCX/PDF export, eSign envelopes
//   Linked    — transaction rooms, AI assist
// Active tab persists in the URL hash so a refresh keeps the broker
// in place.
type DocTab = 'editor' | 'review' | 'versions' | 'export' | 'linked'
const activeTab = ref<DocTab>('editor')
if (typeof window !== 'undefined') {
  const hash = window.location.hash.replace(/^#/, '') as DocTab
  if (['editor','review','versions','export','linked'].includes(hash)) {
    activeTab.value = hash as DocTab
  }
}
function onTabChange(v: string) {
  activeTab.value = v as DocTab
  if (typeof window !== 'undefined') {
    history.replaceState(null, '', `#${v}`)
  }
}

const docTabs = computed<WorkspaceTab[]>(() => {
  if (!draft.value) return []
  // Issue count surfaced in the Review tab via the validation engine
  // is computed inside ValidationPanel; we don't double-compute here.
  // Surfacing the count would require lifting the engine call up,
  // and the panel itself shows it prominently. Tab badges only
  // surface obvious "needs attention" hints from the panel data.
  return [
    { id: 'editor',   label: 'Editor' },
    { id: 'review',   label: 'Review' },
    { id: 'versions', label: 'Versions' },
    { id: 'export',   label: 'Export' },
    { id: 'linked',   label: 'Linked' },
  ]
})
async function onCompareRequest(a: any, b: any) {
  // Versions panel only sends id + version_number + snapshot_body
  // headers (no full data). Snapshots came in trimmed; fetch the
  // bodies directly from each version row when not already there.
  async function bodyFor(v: any): Promise<string> {
    if (typeof v.snapshot_body === 'string') return v.snapshot_body
    try {
      const full = await $fetch<any>(
        `/api/document-drafts/${id.value}/versions/${v.id}`,
      )
      const data = full?.snapshot_data ?? {}
      if (typeof data.ai_body === 'string') return data.ai_body
      // Fallback for template-driven drafts: dump the data fields as
      // formatted JSON so the diff is at least visible.
      return JSON.stringify(data, null, 2)
    } catch {
      return ''
    }
  }
  const [bodyA, bodyB] = await Promise.all([bodyFor(a), bodyFor(b)])
  compareState.value = {
    labelA: `v${a.version_number}${a.label ? ' · ' + a.label : ''}`,
    labelB: `v${b.version_number}${b.label ? ' · ' + b.label : ''}`,
    bodyA,
    bodyB,
  }
}

async function remove() {
  if (!draft.value) return
  if (!window.confirm(`Delete "${draft.value.title || 'this draft'}"? This cannot be undone.`)) return
  try {
    await deleteDraft(draft.value.id)
    showToast({ title: 'Draft deleted.', icon: 'success' })
    router.replace('/document-drafts')
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not delete.', icon: 'error' })
  }
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <!-- Breadcrumb — sits above the back link + delete row. The back
         link stays as a discoverable affordance ("← All drafts") for
         keyboard / muscle-memory users; the breadcrumb is the
         orientation surface. -->
    <UiBreadcrumb v-if="draft" :entity="draft.title || `Draft ${draft.id.slice(0, 8)}`" />

    <div class="no-print flex items-center justify-between">
      <NuxtLink
        to="/document-drafts"
        class="inline-flex items-center gap-1 text-meta hover:text-foreground focus-ring rounded"
      >
        <span aria-hidden="true">←</span>
        All drafts
      </NuxtLink>
      <button
        v-if="draft && draft.storage_path"
        type="button"
        class="rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors duration-150 ease-out hover:bg-destructive/15 focus-ring"
        @click="remove"
      >
        Delete
      </button>
    </div>

    <UiCard
      v-if="isLoading"
      padding="md"
      class="text-center text-sm text-muted-foreground py-10"
    >
      Loading…
    </UiCard>

    <UiCard
      v-else-if="errorMessage"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-center text-sm text-destructive"
    >
      {{ errorMessage }}
    </UiCard>

    <!-- Phase 5: workspace tabs. Sticky strip lets brokers jump
         between Editor / Review / Versions / Export / Linked without
         scrolling the whole stack. Hash-synced so refresh keeps you
         on the active tab. -->
    <UiWorkspaceTabs
      v-if="draft"
      :model-value="activeTab"
      :tabs="docTabs"
      aria-label="Document tabs"
      @update:model-value="onTabChange"
    />

    <!-- Editor tab — body editor + finalized PDF panel. The v-if
         chain on editor branches is preserved inside this tab group
         so DocumentEditor / DocumentImportViewer / AiDocumentEditor
         remain mutually exclusive, with a fall-through "empty" card. -->
    <div v-show="draft && activeTab === 'editor'" class="space-y-4">
      <DocumentEditor
        v-if="draft && draft.template_id"
        :draft="draft"
        @created="onCreated"
        @saved="onSaved"
      />
      <DocumentImportViewer
        v-else-if="draft && draft.storage_path"
        :draft="draft"
      />
      <AiDocumentEditor
        v-else-if="draft && (draft.data as any)?.ai_body"
        :draft="draft"
        @saved="onSaved"
      />
      <UiCard
        v-else-if="draft"
        padding="md"
        class="border-dashed text-center text-sm text-muted-foreground py-10"
      >
        This draft has no template and no imported file. It's empty.
      </UiCard>

      <!-- Finalized notarized PDF panel — broker workflow: print,
           notarize offline, scan, upload here. Auto-transitions to signed. -->
      <FinalizedDocumentPanel
        v-if="draft"
        :draft="(draft as any)"
        @updated="onFinalizedUpdated"
      />
    </div>

    <!-- Review tab — parties, validation, signatures, approvals.
         The work-in-progress legal review surface. -->
    <div v-show="draft && activeTab === 'review'" class="space-y-4">
      <PartiesEditor
        v-if="draft"
        :draft="draft"
        @updated="onSaved"
      />
      <ValidationPanel
        v-if="draft"
        :draft="draft"
      />
      <SignaturePlaceholdersPanel
        v-if="draft"
        :draft="draft"
        @updated="onSaved"
      />
      <DocumentApprovalsPanel
        v-if="draft"
        :draft-id="draft.id"
      />
    </div>

    <!-- Versions tab — snapshot history + diff viewer. The diff
         renders inline when a compare is requested from the panel. -->
    <div v-show="draft && activeTab === 'versions'" class="space-y-4">
      <DocumentVersionsPanel
        v-if="draft"
        :draft-id="draft.id"
        @compare="onCompareRequest"
      />
      <DocumentDiffViewer
        v-if="compareState"
        :label-a="compareState.labelA"
        :label-b="compareState.labelB"
        :body-a="compareState.bodyA"
        :body-b="compareState.bodyB"
      />
    </div>

    <!-- Export tab — DOCX/PDF download + DocuSign envelope status.
         Both surfaces are downstream of the editor + review work. -->
    <div v-show="draft && activeTab === 'export'" class="space-y-4">
      <ExportPanel
        v-if="draft"
        :draft-id="draft.id"
      />
      <EsignEnvelopesPanel
        v-if="draft"
        :draft-id="draft.id"
      />
    </div>

    <!-- Linked tab — transaction rooms + AI assist drawer. The
         "outside this draft" surface: where this draft fits in the
         broader closing, and AI tooling that operates on its content. -->
    <div v-show="draft && activeTab === 'linked'" class="space-y-4">
      <DraftRoomsPanel
        v-if="draft"
        :draft-id="draft.id"
      />
      <AiAssistDrawer
        v-if="draft"
        :draft="draft"
      />
    </div>
  </AdminPageShell>
</template>
