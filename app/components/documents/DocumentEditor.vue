<script setup lang="ts">
// Image-overlay document editor.
//
// Behaviors:
//   - Renders a template background image and overlays one input per
//     field at the configured (x, y).
//   - Validates fields via documentTemplates.validateField — errors
//     show inline, the toolbar shows a summary pill, and Save is
//     disabled until the form is valid.
//   - Auto-saves changes ~1.5s after the user stops typing. The
//     status indicator switches between idle / saving / saved.
//   - Detects concurrent edits via expected_updated_at in PATCH; on
//     409 the editor surfaces a "draft was edited elsewhere — reload?"
//     toast and refuses further auto-saves until reconciled.
//   - Prints via window.print(); print CSS strips toolbar and input
//     borders so the filled values overlay the background like ink.
//
// What this component does NOT do:
//   - Imported-file rendering (PDF/image previews) lives in
//     DocumentImportViewer.
//   - Server-side PDF export (browser print is the supported path).

import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue'
import {
  findTemplate,
  humanizeFieldKey,
  validateAll,
  hasAnyError,
  type DocumentTemplate,
  type DocumentTemplateField,
  type FieldErrors,
} from '~/utils/documentTemplates'
import {
  useDocumentDrafts,
  type DocumentDraft,
  type DraftStatus,
} from '~/composables/useDocumentDrafts'
import { useTemplates } from '~/composables/useTemplateDefinitions'
import { useContacts, type Contact } from '~/composables/useContacts'
import { useTimeline, type TimelineEvent } from '~/composables/useTimeline'
import ContactPicker from '~/components/contacts/ContactPicker.vue'
import SignatureModal from '~/components/documents/SignatureModal.vue'
import ShareDraftModal from '~/components/documents/ShareDraftModal.vue'
import TimelineEntry from '~/components/timeline/TimelineEntry.vue'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  /** Existing draft to edit. Either `draft` or `templateId` is required. */
  draft?: DocumentDraft | null
  /** Template id to start a new draft from when no draft is supplied. */
  templateId?: string | null
}>()

const emit = defineEmits<{
  (e: 'created', draft: DocumentDraft): void
  (e: 'saved', draft: DocumentDraft): void
}>()

const {
  createDraft,
  saveDraft,
  transitionDraft,
} = useDocumentDrafts()
const { getContactById } = useContacts()
const { fetchContactTimeline } = useTimeline()
// Hybrid registry — checks the static documentTemplates.ts AND any
// DB-published templates. findById returns null until the DB fetch
// settles for the first time, so we fall back to the static-only
// findTemplate() during that window.
const { findById: findHybridTemplate } = useTemplates()

// Resolved template (drives layout). Drafts always have template_id;
// the brief's "imported" flavor is rendered by DocumentImportViewer.
const template = computed<DocumentTemplate | null>(() => {
  const id = props.draft?.template_id ?? props.templateId ?? null
  if (!id) return null
  return findHybridTemplate(id) ?? findTemplate(id)
})

// Reactive form. All template field types bind to strings in the DOM,
// so we type the form as Record<string, string>. Coerce in the save
// handler (or downstream) if numeric storage matters.
const formData = reactive<Record<string, string>>({})
function syncFormFromDraft() {
  for (const key in formData) delete formData[key]
  const tpl = template.value
  if (!tpl) return
  for (const f of tpl.fields) {
    const v = (props.draft?.data as any)?.[f.key]
    formData[f.key] = v === null || v === undefined ? '' : String(v)
  }
}
watch(() => [template.value?.id, props.draft?.id], syncFormFromDraft, { immediate: true })

const draftId = ref<string | null>(props.draft?.id ?? null)
watch(() => props.draft?.id, (v) => { draftId.value = v ?? null })

const title = ref<string>(props.draft?.title ?? '')
watch(() => props.draft?.title, (v) => { title.value = v ?? '' })

// Track the server-known updated_at — sent back as expected_updated_at
// on every save so the server can detect concurrent edits.
const knownUpdatedAt = ref<string | null>(props.draft?.updated_at ?? null)
watch(() => props.draft?.updated_at, (v) => { knownUpdatedAt.value = v ?? null })

// =====================================================================
// Status workflow
// =====================================================================

const draftStatus = ref<DraftStatus>(props.draft?.status ?? 'draft')
watch(() => props.draft?.status, (v) => { draftStatus.value = (v ?? 'draft') as DraftStatus })

const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  signed: 'Signed',
  archived: 'Archived',
}
const STATUS_PILL: Record<DraftStatus, string> = {
  draft: 'bg-warning/15 text-warning',
  in_review: 'bg-primary/10 text-primary',
  signed: 'bg-success/15 text-success',
  archived: 'bg-muted text-muted-foreground',
}
// Mirror the server's transition map so we don't render buttons for
// transitions the API would refuse anyway.
const STATUS_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  draft:     ['in_review', 'archived'],
  in_review: ['signed', 'draft', 'archived'],
  signed:    ['archived'],
  archived:  ['draft'],
}
const allowedTransitions = computed<DraftStatus[]>(() => STATUS_TRANSITIONS[draftStatus.value] ?? [])

const isTransitioning = ref(false)
async function changeStatus(to: DraftStatus) {
  if (!draftId.value) {
    showToast({ title: 'Save the draft first.', icon: 'warning' })
    return
  }
  isTransitioning.value = true
  try {
    const updated = await transitionDraft(draftId.value, to)
    draftStatus.value = updated.status
    knownUpdatedAt.value = updated.updated_at
    emit('saved', updated)
    showToast({ title: `Moved to ${STATUS_LABEL[to]}.`, icon: 'success' })
    // Refresh activity so the new audit row shows.
    if (updated.contact_id) loadActivity(updated.contact_id, updated.id)
    else loadActivity(null, updated.id)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not change status.',
      icon: 'error',
    })
  } finally {
    isTransitioning.value = false
  }
}

// =====================================================================
// Signatures
// =====================================================================
//
// Signature fields render as a click-to-sign tile that opens a modal.
// On save the modal returns a signed URL; we cache it locally so the
// editor can render the saved signature inline while the user keeps
// editing other fields.

const sigUrlsByKey = ref<Record<string, string>>({})

// Hydrate from props.draft.data._signatures: server-side signed URLs
// aren't part of the row, so on first paint we don't have an URL yet —
// the import-viewer-style /signature/url endpoint would be the right
// follow-up. For now, the modal returns a URL on save and we keep
// it in memory.
function syncSigUrlsFromDraft() {
  // Map any URLs the server has populated under data._signatures[k].url
  // (e.g. by the public-shared endpoint). For the authenticated editor
  // the server only stores `path`, not `url`, so this is mostly a
  // no-op until the user signs in this session.
  const sigs: any = (props.draft?.data as any)?._signatures ?? {}
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(sigs)) {
    if (typeof v === 'object' && v && typeof (v as any).url === 'string') {
      next[k] = (v as any).url
    }
  }
  sigUrlsByKey.value = next
}
watch(() => props.draft?.id, syncSigUrlsFromDraft, { immediate: true })

const signatureModalOpen = ref(false)
const signingFieldKey = ref<string>('')
const signingFieldLabel = ref<string>('')

function openSignatureModal(field: DocumentTemplateField) {
  if (!draftId.value) {
    showToast({ title: 'Create the draft first to attach signatures.', icon: 'warning' })
    return
  }
  signingFieldKey.value = field.key
  signingFieldLabel.value = fieldLabel(field)
  signatureModalOpen.value = true
}

function onSignatureSaved(payload: { url: string; path: string; field_key: string }) {
  sigUrlsByKey.value[payload.field_key] = payload.url
  // Mirror the path into formData so validateAll() considers the
  // signature field "filled" without us needing to reload the draft.
  formData[payload.field_key] = payload.path
}

function isSigned(key: string): boolean {
  if (sigUrlsByKey.value[key]) return true
  // Treat a non-empty formData entry as "signed" for validation.
  return !!formData[key]
}

// =====================================================================
// Share links
// =====================================================================

const shareModalOpen = ref(false)
function openShareModal() {
  if (!draftId.value) {
    showToast({ title: 'Save the draft before sharing.', icon: 'warning' })
    return
  }
  shareModalOpen.value = true
}

// =====================================================================
// Activity panel
// =====================================================================
//
// Reuses the unified timeline's contact-pivoting to show all events
// linked to this draft's contact. When there's no contact, we still
// paint the panel but it'll be empty (the activities table doesn't
// support a "by draft id" pivot today; that'd be a one-line follow-up
// to useTimeline.fetchByDraftId).

const activity = ref<TimelineEvent[]>([])
const activityLoading = ref(false)

async function loadActivity(cid: number | null, _draftId: string | null) {
  activityLoading.value = true
  try {
    if (cid) {
      activity.value = await fetchContactTimeline(cid)
    } else {
      activity.value = []
    }
  } finally {
    activityLoading.value = false
  }
}

watch(() => props.draft?.id, () => {
  loadActivity(props.draft?.contact_id ?? null, props.draft?.id ?? null)
}, { immediate: true })

// The contactId-change watch is set up AFTER contactId is declared
// further down — see "Activity contact follow-up" block.

// Linked contact — picker's "selected" view requires the full row.
const selectedContact = ref<Contact | null>(null)
async function hydrateContact() {
  const cid = props.draft?.contact_id
  if (!cid) {
    selectedContact.value = null
    return
  }
  try { selectedContact.value = await getContactById(cid) }
  catch { selectedContact.value = null }
}
watch(() => props.draft?.contact_id, hydrateContact, { immediate: true })

const contactId = ref<number | null>(props.draft?.contact_id ?? null)
function onContactSelect(contact: Contact) {
  selectedContact.value = contact
  contactId.value = contact.id
}
function onContactClear() {
  selectedContact.value = null
  contactId.value = null
}

// Activity contact follow-up: picking a new contact changes which
// timeline rows are relevant. Set up here so contactId's declaration
// is hoisted before the watch closure runs.
watch(contactId, (cid) => {
  if (draftId.value) loadActivity(cid, draftId.value)
})

// =====================================================================
// Validation
// =====================================================================

const errors = computed<FieldErrors>(() => validateAll(template.value, formData))
const hasErrors = computed(() => hasAnyError(errors.value))
const errorCount = computed(() => {
  let n = 0
  for (const k in errors.value) if (errors.value[k]) n++
  return n
})

// =====================================================================
// Save state
// =====================================================================

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'
const saveState = ref<SaveState>('idle')
const lastSavedAt = ref<Date | null>(null)
const dirty = ref(false)

// Track when the user has touched something we haven't yet persisted,
// so the indicator shows "Unsaved changes" instead of "Saved" after edits.
function markDirty() {
  dirty.value = true
  saveState.value = 'idle'
}

const isSaving = ref(false)

async function performSave(): Promise<DocumentDraft | null> {
  if (!template.value) return null
  if (hasErrors.value) {
    showToast({ title: `Fix ${errorCount.value} field error${errorCount.value === 1 ? '' : 's'} before saving.`, icon: 'warning' })
    return null
  }

  isSaving.value = true
  saveState.value = 'saving'

  try {
    if (draftId.value) {
      // Existing draft — PATCH with expected_updated_at for concurrency.
      const updated = await saveDraft(draftId.value, {
        data: { ...formData },
        contact_id: contactId.value,
        title: title.value || null,
        expected_updated_at: knownUpdatedAt.value ?? undefined,
      })
      knownUpdatedAt.value = updated.updated_at
      saveState.value = 'saved'
      lastSavedAt.value = new Date()
      dirty.value = false
      emit('saved', updated)
      return updated
    } else {
      const created = await createDraft({
        template_id: template.value.id,
        contact_id: contactId.value ?? null,
        data: { ...formData },
        title: title.value || template.value.name,
      })
      draftId.value = created.id
      knownUpdatedAt.value = created.updated_at
      saveState.value = 'saved'
      lastSavedAt.value = new Date()
      dirty.value = false
      emit('created', created)
      return created
    }
  } catch (err: any) {
    if (err?.statusCode === 409 || err?.status === 409) {
      saveState.value = 'conflict'
      showToast({
        title: 'This draft was edited elsewhere. Reload to see the latest version.',
        icon: 'warning',
      })
    } else {
      saveState.value = 'error'
      showToast({ title: err?.statusMessage || err?.message || 'Could not save draft.', icon: 'error' })
    }
    return null
  } finally {
    isSaving.value = false
  }
}

// Manual save (toolbar button). Cancels any pending auto-save.
async function save() {
  cancelAutoSave()
  await performSave()
}

// =====================================================================
// Auto-save (debounced)
// =====================================================================

const AUTOSAVE_MS = 1500
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null

function cancelAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
}

function scheduleAutoSave() {
  // No-op while in conflict — user must reload first.
  if (saveState.value === 'conflict') return
  cancelAutoSave()
  autoSaveTimer = setTimeout(async () => {
    autoSaveTimer = null
    if (hasErrors.value) {
      // Don't autosave invalid data; surface inline errors instead.
      saveState.value = 'idle'
      return
    }
    await performSave()
  }, AUTOSAVE_MS)
}

// React to user edits. Don't fire on initial hydration — guard via dirty.
watch([formData, title, contactId], () => {
  markDirty()
  // Only auto-save existing drafts; first-time creation requires the
  // explicit "Create draft" click so we don't mint stray empty rows.
  if (draftId.value) scheduleAutoSave()
}, { deep: true })

onBeforeUnmount(() => {
  cancelAutoSave()
})

function print() {
  // Defer one tick so any in-flight v-model updates flush to DOM.
  if (typeof window !== 'undefined') window.print()
}

// =====================================================================
// Display helpers
// =====================================================================

function fieldStyle(f: DocumentTemplateField) {
  const w = f.width ?? 200
  const h = f.height ?? (f.type === 'textarea' ? 80 : 28)
  return {
    position: 'absolute' as const,
    top: `${f.y}px`,
    left: `${f.x}px`,
    width: `${w}px`,
    height: `${h}px`,
  }
}

function fieldLabel(f: DocumentTemplateField) {
  return f.label ?? humanizeFieldKey(f.key)
}

function inputType(f: DocumentTemplateField): string {
  // Native HTML5 picks up 'email' / 'tel' / 'date' / 'number' for
  // mobile keyboards + browser-side validation hints.
  if (f.type === 'textarea') return 'text' // unused (we render <textarea>)
  return f.type
}

const saveIndicator = computed(() => {
  if (isSaving.value || saveState.value === 'saving') return 'Saving…'
  if (saveState.value === 'conflict') return 'Conflict — reload'
  if (saveState.value === 'error') return 'Save failed'
  if (dirty.value) return 'Unsaved changes'
  if (lastSavedAt.value) {
    const seconds = Math.max(0, Math.floor((Date.now() - lastSavedAt.value.getTime()) / 1000))
    if (seconds < 5) return 'Saved just now'
    if (seconds < 60) return `Saved ${seconds}s ago`
    return `Saved at ${lastSavedAt.value.toLocaleTimeString()}`
  }
  return ''
})
</script>

<template>
  <ClientOnly>
    <div class="document-editor flex flex-col gap-4">
      <!-- Toolbar (hidden in print). -->
      <header class="no-print flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-sm">
        <input
          v-model="title"
          type="text"
          :placeholder="template?.name ?? 'Untitled draft'"
          class="flex-1 rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
        />

        <div class="flex min-w-[14rem] flex-1 sm:flex-none">
          <ContactPicker
            label=""
            placeholder="Link to contact (optional)"
            :selected="selectedContact"
            @select="onContactSelect"
            @clear="onContactClear"
          />
        </div>

        <span
          v-if="saveIndicator"
          class="hidden text-xs sm:inline"
          :class="{
            'text-muted-foreground': saveState === 'idle' || saveState === 'saved',
            'text-primary':  saveState === 'saving',
            'text-warning': saveState === 'conflict',
            'text-destructive':   saveState === 'error',
          }"
        >
          {{ saveIndicator }}
        </span>

        <!-- Status pill — always visible so reviewers know where in the
             workflow this draft lives. -->
        <span
          v-if="draftId"
          class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          :class="STATUS_PILL[draftStatus]"
        >
          {{ STATUS_LABEL[draftStatus] }}
        </span>

        <button
          type="button"
          class="rounded-md bg-muted px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-60"
          :disabled="!draftId"
          @click="openShareModal"
          title="Share read-only link"
        >
          Share
        </button>

        <button
          type="button"
          class="rounded-md bg-muted px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
          @click="print"
        >
          Print
        </button>
        <button
          type="button"
          class="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="isSaving || !template || hasErrors"
          @click="save"
        >
          <span v-if="isSaving">Saving…</span>
          <span v-else-if="draftId">Save</span>
          <span v-else>Create draft</span>
        </button>
      </header>

      <!-- Status transition strip — second row of the toolbar. Only
           shown for existing drafts (transition requires a draft id). -->
      <div
        v-if="draftId && allowedTransitions.length > 0"
        class="no-print flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-2 shadow-sm"
      >
        <span class="text-xs text-muted-foreground">Move to:</span>
        <button
          v-for="t in allowedTransitions"
          :key="t"
          type="button"
          class="rounded-md bg-muted px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="isTransitioning"
          @click="changeStatus(t)"
        >
          {{ STATUS_LABEL[t] }}
        </button>
        <span v-if="isTransitioning" class="text-xs text-muted-foreground">Updating…</span>
      </div>

      <!-- Validation summary pill — only shows when there are errors. -->
      <div
        v-if="template && hasErrors"
        class="no-print rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        {{ errorCount }} field{{ errorCount === 1 ? '' : 's' }} need attention before saving.
      </div>

      <!-- Empty state — no template id and no draft to render. -->
      <div
        v-if="!template"
        class="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground"
      >
        No template selected. Pick a template to start a new draft.
      </div>

      <!-- Template canvas. Horizontal-scroll wrapper at narrow viewports;
           the inner `.template-page` has the natural template size so
           absolute coordinates land at the author's intended positions. -->
      <div
        v-else
        class="template-scroll overflow-x-auto rounded-xl border border-border bg-muted/50 shadow-sm"
      >
        <div
          class="template-page relative mx-auto bg-card"
          :style="{ width: `${template.width}px`, height: `${template.height}px` }"
        >
          <img
            :src="template.background"
            :alt="template.name"
            class="absolute inset-0 h-full w-full select-none"
            draggable="false"
          />

          <template v-for="f in template.fields" :key="f.key">
            <textarea
              v-if="f.type === 'textarea'"
              v-model="formData[f.key]"
              :data-field="f.key"
              :placeholder="f.placeholder ?? fieldLabel(f)"
              :aria-label="fieldLabel(f)"
              :aria-invalid="!!errors[f.key]"
              class="document-field rounded-md border bg-white/80 px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1"
              :class="errors[f.key]
                ? 'border-destructive focus:border-destructive focus:ring-destructive/30'
                : 'border-primary/60 focus:border-primary focus:ring-primary/30'"
              :style="fieldStyle(f)"
            />

            <!-- Signature: click-to-sign tile. Renders the saved
                 signature image when one exists; otherwise a "Sign here"
                 prompt that opens the modal. -->
            <button
              v-else-if="f.type === 'signature'"
              type="button"
              :data-field="f.key"
              :aria-label="fieldLabel(f)"
              :aria-invalid="!!errors[f.key]"
              class="document-field flex items-center justify-center overflow-hidden rounded-md border bg-white/80 text-xs font-semibold shadow-sm focus:outline-none focus:ring-1"
              :class="errors[f.key]
                ? 'border-destructive text-destructive focus:border-destructive focus:ring-destructive/30'
                : 'border-primary/60 text-primary focus:border-primary focus:ring-primary/30'"
              :style="fieldStyle(f)"
              @click="openSignatureModal(f)"
            >
              <img
                v-if="sigUrlsByKey[f.key]"
                :src="sigUrlsByKey[f.key]"
                :alt="`${fieldLabel(f)} signature`"
                class="h-full w-full object-contain"
              />
              <span v-else>
                <span v-if="isSigned(f.key)">Signed (re-sign)</span>
                <span v-else>Sign {{ fieldLabel(f) }}</span>
              </span>
            </button>

            <input
              v-else
              v-model="formData[f.key]"
              :type="inputType(f)"
              :data-field="f.key"
              :placeholder="f.placeholder ?? fieldLabel(f)"
              :aria-label="fieldLabel(f)"
              :aria-invalid="!!errors[f.key]"
              class="document-field rounded-md border bg-white/80 px-2 text-sm shadow-sm focus:outline-none focus:ring-1"
              :class="errors[f.key]
                ? 'border-destructive focus:border-destructive focus:ring-destructive/30'
                : 'border-primary/60 focus:border-primary focus:ring-primary/30'"
              :style="fieldStyle(f)"
            />
          </template>
        </div>
      </div>

      <!-- Per-field error list. Shown below the canvas for keyboard /
           screen-reader users; visual users also get the inline red
           outlines + the summary pill above. -->
      <ul
        v-if="template && hasErrors"
        class="no-print space-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive"
      >
        <li v-for="f in template.fields" :key="f.key">
          <template v-if="errors[f.key]">
            <strong>{{ fieldLabel(f) }}:</strong> {{ errors[f.key] }}
          </template>
        </li>
      </ul>

      <!-- Activity panel — surfaces draft + linked-contact + listing
           events from the unified timeline. Hidden in print. -->
      <section
        v-if="draftId"
        class="no-print rounded-xl border border-border bg-background shadow-sm"
      >
        <header class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-sm font-semibold text-foreground">Activity</h2>
          <span v-if="!activityLoading" class="text-xs text-muted-foreground/70">
            {{ activity.length }}
          </span>
        </header>
        <div v-if="activityLoading" class="space-y-2 p-4">
          <div v-for="n in 3" :key="n" class="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
        <div
          v-else-if="activity.length === 0"
          class="px-4 py-8 text-center text-xs text-muted-foreground"
        >
          {{ contactId
            ? 'No activity yet on the linked contact.'
            : 'Link a contact to see related activity here.' }}
        </div>
        <ol v-else class="relative border-l border-border px-4 py-4">
          <TimelineEntry v-for="event in activity" :key="event.id" :event="event" />
        </ol>
      </section>

      <!-- Modals (rendered conditionally; their internal Teleport
           lands them on body so overflow doesn't clip). -->
      <SignatureModal
        v-if="draftId"
        :draft-id="draftId"
        :field-key="signingFieldKey"
        :field-label="signingFieldLabel"
        :open="signatureModalOpen"
        @update:open="signatureModalOpen = $event"
        @saved="onSignatureSaved"
      />

      <ShareDraftModal
        v-if="draftId"
        :draft-id="draftId"
        :open="shareModalOpen"
        @update:open="shareModalOpen = $event"
      />
    </div>
  </ClientOnly>
</template>

<style scoped>
/* On screen: subtle outline + translucent fill so users can see the
   interactive zones over the template background. */
.document-field {
  box-sizing: border-box;
}

/* Print: strip toolbar and remove input borders/backgrounds so the
   filled values float over the template image like ink on paper.
   `color-adjust: exact` forces Chromium-based browsers to actually
   print the background image instead of dropping it. */
@media print {
  /* Letter size with reasonable margins so the 816×1056 template at
     96 DPI lines up with the printable area. Adjust per template via
     a future-friendly @page setting if templates of other sizes land. */
  @page {
    size: letter;
    margin: 0.25in;
  }

  :global(body) {
    background: white !important;
  }

  .no-print {
    display: none !important;
  }
  .template-scroll {
    overflow: visible !important;
    border: 0 !important;
    background: white !important;
    page-break-inside: avoid;
  }
  .template-page {
    page-break-after: always;
  }
  .template-page:last-child {
    page-break-after: auto;
  }
  .document-field {
    border: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
    -webkit-print-color-adjust: exact;
    color-adjust: exact;
    print-color-adjust: exact;
  }
  /* Hide caret + placeholder when printing so an empty field looks
     blank rather than showing the placeholder text. */
  .document-field::placeholder {
    color: transparent !important;
  }
}
</style>
