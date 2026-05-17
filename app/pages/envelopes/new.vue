<script setup lang="ts">
/**
 * /envelopes/new — staged create-and-send flow.
 *
 * Stage 1: Basics. Title + optional message + routing kind. Submit
 *          creates the envelope (status=draft) and unlocks Stage 2.
 * Stage 2: Recipients + documents. Each add is a live API call —
 *          backend only accepts mutations while the envelope is still
 *          draft, so the UI surfaces errors immediately if something
 *          drifts.
 * Stage 3: Review + send. Validates ≥1 recipient + ≥1 document, then
 *          posts /send which mints tokens, enqueues emails, and flips
 *          status to sent.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UserPicker from '~/components/ui/UserPicker.vue'
import {
  useEnvelopes,
  type Envelope,
  type Recipient,
  type EnvelopeDocument,
  type RecipientRole,
} from '~/composables/useEnvelopes'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'New envelope | Housing Interactive' })

const router = useRouter()
const route = useRoute()
const api = useEnvelopes()

// ============== Stage 1: basics ==============
const basics = ref({
  title: '',
  message: '',
  routing_kind: 'sequential' as 'sequential' | 'parallel',
})
const creating = ref(false)
const envelope = ref<Envelope | null>(null)
const stage1Error = ref<string | null>(null)

async function createEnvelope() {
  if (!basics.value.title.trim()) {
    stage1Error.value = 'Title is required.'
    return
  }
  creating.value = true
  stage1Error.value = null
  try {
    const res = await api.create({
      title: basics.value.title.trim(),
      message: basics.value.message.trim() || null,
      routing_kind: basics.value.routing_kind,
    })
    envelope.value = res.envelope
  } catch (err: any) {
    stage1Error.value = err?.statusMessage || err?.message || 'Could not create envelope.'
  } finally {
    creating.value = false
  }
}

// ============== Stage 2: recipients ==============
type RecipientFormMode = 'internal' | 'external'
const recipients = ref<Recipient[]>([])
const recipientForm = ref({
  mode: 'external' as RecipientFormMode,
  user_id: '',
  external_email: '',
  external_name: '',
  role: 'signer' as RecipientRole,
})
const addingRecipient = ref(false)
const recipientError = ref<string | null>(null)

const recipientFormValid = computed(() => {
  if (recipientForm.value.mode === 'internal') return !!recipientForm.value.user_id
  if (recipientForm.value.mode === 'external') {
    const e = recipientForm.value.external_email.trim()
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
  }
  return false
})

async function addRecipient() {
  if (!envelope.value || !recipientFormValid.value) return
  addingRecipient.value = true
  recipientError.value = null
  try {
    const payload =
      recipientForm.value.mode === 'internal'
        ? {
            user_id: recipientForm.value.user_id,
            role: recipientForm.value.role,
            sequence: recipients.value.length,
          }
        : {
            external_email: recipientForm.value.external_email.trim().toLowerCase(),
            external_name: recipientForm.value.external_name.trim() || null,
            role: recipientForm.value.role,
            sequence: recipients.value.length,
          }
    const res = await api.addRecipient(envelope.value.id, payload)
    recipients.value.push(res.recipient)
    recipientForm.value = {
      mode: recipientForm.value.mode,
      user_id: '',
      external_email: '',
      external_name: '',
      role: 'signer',
    }
  } catch (err: any) {
    recipientError.value = err?.statusMessage || err?.message || 'Could not add recipient.'
  } finally {
    addingRecipient.value = false
  }
}

async function removeRecipient(r: Recipient) {
  if (!envelope.value) return
  try {
    await api.removeRecipient(envelope.value.id, r.id)
    recipients.value = recipients.value.filter((x) => x.id !== r.id)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not remove recipient.',
      icon: 'error',
    })
  }
}

// ============== Stage 2: documents ==============
type DraftLite = {
  id: string
  title: string | null
  template_id: string | null
  status: string
}

const drafts = ref<DraftLite[]>([])
const draftSearch = ref('')
const documents = ref<EnvelopeDocument[]>([])
const attachingId = ref<string | null>(null)
const draftsLoading = ref(false)

async function loadDrafts() {
  draftsLoading.value = true
  try {
    const res = await $fetch<{ data: DraftLite[] }>('/api/document-drafts', {
      query: { limit: 100 },
    })
    // Don't show drafts that are already attached
    const attachedIds = new Set(documents.value.map((d) => d.document_draft_id))
    drafts.value = (res.data ?? [])
      .filter((d) => !attachedIds.has(d.id))
      .filter((d) => d.status !== 'archived')
  } catch {
    drafts.value = []
  } finally {
    draftsLoading.value = false
  }
}

const filteredDrafts = computed(() => {
  const q = draftSearch.value.trim().toLowerCase()
  if (!q) return drafts.value.slice(0, 8)
  return drafts.value
    .filter((d) =>
      (d.title || '').toLowerCase().includes(q) ||
      (d.template_id || '').toLowerCase().includes(q),
    )
    .slice(0, 8)
})

async function attachDraft(draft: DraftLite) {
  if (!envelope.value) return
  attachingId.value = draft.id
  try {
    const res = await api.attachDocument(envelope.value.id, draft.id, documents.value.length)
    documents.value.push(res.document)
    drafts.value = drafts.value.filter((d) => d.id !== draft.id)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not attach draft.',
      icon: 'error',
    })
  } finally {
    attachingId.value = null
  }
}

async function detachDocument(doc: EnvelopeDocument) {
  if (!envelope.value) return
  try {
    await api.detachDocument(envelope.value.id, doc.id)
    documents.value = documents.value.filter((d) => d.id !== doc.id)
    // Refresh drafts list so the detached one comes back as available
    await loadDrafts()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not detach document.',
      icon: 'error',
    })
  }
}

watch(envelope, (e) => {
  if (e) loadDrafts()
})

// Title hydration: pull draft titles for attached docs (the API for
// envelope documents only returns ids; titles come from the drafts list).
const draftTitleById = ref<Record<string, string>>({})
async function hydrateDraftTitles() {
  for (const doc of documents.value) {
    if (draftTitleById.value[doc.document_draft_id]) continue
    try {
      const res = await $fetch<any>(`/api/document-drafts/${doc.document_draft_id}`)
      draftTitleById.value[doc.document_draft_id] =
        res?.data?.title || res?.data?.template_id || `Draft ${doc.document_draft_id.slice(0, 8)}…`
    } catch {
      draftTitleById.value[doc.document_draft_id] = `Draft ${doc.document_draft_id.slice(0, 8)}…`
    }
  }
}
watch(documents, hydrateDraftTitles, { deep: true })

// ============== Stage 3: send ==============
const sending = ref(false)
const sendError = ref<string | null>(null)

const canSend = computed(
  () =>
    !!envelope.value &&
    recipients.value.length > 0 &&
    documents.value.length > 0 &&
    !sending.value,
)

async function sendEnvelope() {
  if (!canSend.value || !envelope.value) return
  sending.value = true
  sendError.value = null
  try {
    const res = await api.send(envelope.value.id)
    showToast({
      title: `Envelope sent (${res.tokens_minted} signing link${res.tokens_minted === 1 ? '' : 's'} delivered).`,
      icon: 'success',
    })
    await router.push(`/envelopes/${envelope.value.id}`)
  } catch (err: any) {
    sendError.value = err?.statusMessage || err?.message || 'Could not send envelope.'
  } finally {
    sending.value = false
  }
}

async function saveAsDraft() {
  if (!envelope.value) return
  showToast({ title: 'Saved as draft.' })
  await router.push(`/envelopes/${envelope.value.id}`)
}

// Pre-fill from query params (e.g., ?title=… from a "Send for signature"
// shortcut elsewhere in the app). Defer until mount so SSR doesn't try
// to read window-scoped state.
onMounted(() => {
  const t = route.query.title
  if (typeof t === 'string') basics.value.title = t
})

function fmtRecipient(r: Recipient): string {
  if (r.external_email) return `${r.external_name ? r.external_name + ' · ' : ''}${r.external_email}`
  return `Internal user ${r.user_id?.slice(0, 8) ?? '—'}`
}

function fmtDocTitle(documentDraftId: string): string {
  return draftTitleById.value[documentDraftId] || `Draft ${documentDraftId.slice(0, 8)}…`
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="3xl">
    <NuxtLink
      to="/envelopes"
      class="inline-flex items-center gap-1 text-meta hover:text-foreground"
    >
      <span aria-hidden="true">←</span>
      All envelopes
    </NuxtLink>

    <UiPageHeader
      title="New envelope"
      description="Send one or more documents for signature. Recipients get a single-use link by email; you'll see their state on the envelope page as they open + sign."
    />

    <!-- ============== Stage 1: basics ============== -->
    <UiCard variant="surface" padding="lg">
      <header class="mb-4">
        <p class="text-eyebrow">Step 1</p>
        <h2 class="text-section-title">Envelope basics</h2>
      </header>

      <form class="space-y-4" @submit.prevent="createEnvelope">
        <fieldset :disabled="!!envelope" class="contents">
          <div>
            <label for="env-title" class="block text-sm font-medium text-foreground">
              Title
            </label>
            <input
              id="env-title"
              v-model="basics.title"
              type="text"
              required
              maxlength="200"
              placeholder="Lease agreement — Unit 4B Acacia Tower"
              class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            />
            <p class="mt-1 text-xs text-muted-foreground">
              Shown to recipients in the email subject.
            </p>
          </div>

          <div>
            <label for="env-message" class="block text-sm font-medium text-foreground">
              Cover message <span class="text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id="env-message"
              v-model="basics.message"
              rows="2"
              maxlength="5000"
              placeholder="Hi — please review and sign at your earliest convenience. Reach out if anything looks off."
              class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            />
          </div>

          <div>
            <span class="block text-sm font-medium text-foreground">Routing</span>
            <div class="mt-1.5 grid gap-2 sm:grid-cols-2">
              <label
                :class="[
                  'flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors',
                  basics.routing_kind === 'sequential'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent/30',
                ]"
              >
                <input
                  v-model="basics.routing_kind"
                  type="radio"
                  value="sequential"
                  class="mt-0.5"
                />
                <span>
                  <span class="block text-sm font-medium text-foreground">Sequential</span>
                  <span class="block text-xs text-muted-foreground">One signer at a time, in order.</span>
                </span>
              </label>
              <label
                :class="[
                  'flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors',
                  basics.routing_kind === 'parallel'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent/30',
                ]"
              >
                <input
                  v-model="basics.routing_kind"
                  type="radio"
                  value="parallel"
                  class="mt-0.5"
                />
                <span>
                  <span class="block text-sm font-medium text-foreground">Parallel</span>
                  <span class="block text-xs text-muted-foreground">All signers receive the link at once.</span>
                </span>
              </label>
            </div>
          </div>

          <p v-if="stage1Error" class="text-xs text-destructive">{{ stage1Error }}</p>

          <div class="flex justify-end">
            <button
              v-if="!envelope"
              type="submit"
              :disabled="creating"
              class="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span v-if="creating">Creating…</span>
              <span v-else>Save and continue →</span>
            </button>
            <span v-else class="inline-flex items-center gap-1.5 text-xs text-success">
              <span aria-hidden="true">✓</span>
              Envelope draft created
            </span>
          </div>
        </fieldset>
      </form>
    </UiCard>

    <!-- ============== Stage 2: recipients + documents ============== -->
    <template v-if="envelope">
      <UiCard variant="surface" padding="lg">
        <header class="mb-4">
          <p class="text-eyebrow">Step 2 · Recipients</p>
          <h2 class="text-section-title">Who needs to sign?</h2>
          <p class="mt-1 text-meta">
            Add internal teammates by name or external signers by email. Sequence determines order under sequential routing.
          </p>
        </header>

        <ul v-if="recipients.length > 0" class="mb-4 space-y-2">
          <li
            v-for="(r, idx) in recipients"
            :key="r.id"
            class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
          >
            <div class="flex min-w-0 items-center gap-3">
              <span class="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground" aria-hidden="true">
                {{ idx + 1 }}
              </span>
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-foreground">
                  {{ fmtRecipient(r) }}
                </p>
                <p class="text-xs text-muted-foreground capitalize">{{ r.role }}</p>
              </div>
            </div>
            <button
              type="button"
              class="text-xs text-destructive hover:underline"
              @click="removeRecipient(r)"
            >
              Remove
            </button>
          </li>
        </ul>

        <!-- Mode toggle -->
        <div class="mb-3 inline-flex rounded-lg bg-muted p-1 text-xs">
          <button
            type="button"
            :class="['rounded-md px-3 py-1 transition-colors', recipientForm.mode === 'external' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground']"
            @click="recipientForm.mode = 'external'"
          >
            External email
          </button>
          <button
            type="button"
            :class="['rounded-md px-3 py-1 transition-colors', recipientForm.mode === 'internal' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground']"
            @click="recipientForm.mode = 'internal'"
          >
            Teammate
          </button>
        </div>

        <div class="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <div v-if="recipientForm.mode === 'internal'">
            <UserPicker
              v-model="recipientForm.user_id"
              placeholder="Search teammates by name or email…"
            />
          </div>
          <div v-else class="grid gap-2 sm:grid-cols-2">
            <input
              v-model="recipientForm.external_email"
              type="email"
              required
              maxlength="254"
              placeholder="signer@example.com"
              class="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              v-model="recipientForm.external_name"
              type="text"
              maxlength="120"
              placeholder="Name (optional)"
              class="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <select
            v-model="recipientForm.role"
            class="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="signer">Signer</option>
            <option value="approver">Approver</option>
            <option value="viewer">Viewer</option>
            <option value="cc">CC</option>
          </select>
          <button
            type="button"
            :disabled="!recipientFormValid || addingRecipient"
            class="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            @click="addRecipient"
          >
            <span v-if="addingRecipient">Adding…</span>
            <span v-else>Add</span>
          </button>
        </div>

        <p v-if="recipientError" class="mt-2 text-xs text-destructive">{{ recipientError }}</p>
      </UiCard>

      <UiCard variant="surface" padding="lg">
        <header class="mb-4">
          <p class="text-eyebrow">Step 2 · Documents</p>
          <h2 class="text-section-title">Attach documents to sign</h2>
          <p class="mt-1 text-meta">
            Pick from your existing drafts. Need a new one?
            <NuxtLink to="/document-drafts/new" class="text-primary hover:underline">Create a draft</NuxtLink>
            and come back.
          </p>
        </header>

        <ul v-if="documents.length > 0" class="mb-4 space-y-2">
          <li
            v-for="(doc, idx) in documents"
            :key="doc.id"
            class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
          >
            <div class="flex min-w-0 items-center gap-3">
              <span class="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground" aria-hidden="true">
                {{ idx + 1 }}
              </span>
              <p class="truncate text-sm font-medium text-foreground">
                {{ fmtDocTitle(doc.document_draft_id) }}
              </p>
            </div>
            <button
              type="button"
              class="text-xs text-destructive hover:underline"
              @click="detachDocument(doc)"
            >
              Remove
            </button>
          </li>
        </ul>

        <div class="space-y-2">
          <input
            v-model="draftSearch"
            type="search"
            placeholder="Search your drafts to attach…"
            class="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p v-if="draftsLoading" class="text-meta">Loading…</p>
          <ul v-else-if="filteredDrafts.length === 0" class="text-meta">
            No matching drafts. <NuxtLink to="/document-drafts/new" class="text-primary hover:underline">Create one →</NuxtLink>
          </ul>
          <ul v-else class="divide-y divide-border rounded-lg border border-border">
            <li v-for="d in filteredDrafts" :key="d.id">
              <button
                type="button"
                :disabled="attachingId === d.id"
                class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/30 disabled:opacity-60"
                @click="attachDraft(d)"
              >
                <span class="min-w-0">
                  <span class="block truncate font-medium text-foreground">
                    {{ d.title || d.template_id || `Draft ${d.id.slice(0, 8)}…` }}
                  </span>
                  <span class="block text-xs text-muted-foreground capitalize">
                    {{ d.status.replace('_', ' ') }}
                  </span>
                </span>
                <span class="text-xs text-primary">
                  {{ attachingId === d.id ? 'Attaching…' : 'Attach' }}
                </span>
              </button>
            </li>
          </ul>
        </div>
      </UiCard>

      <!-- ============== Stage 3: send ============== -->
      <UiCard variant="elevated" padding="lg">
        <header class="mb-4">
          <p class="text-eyebrow">Step 3 · Send</p>
          <h2 class="text-section-title">Review and deliver</h2>
        </header>

        <ul class="mb-4 space-y-1.5 text-sm">
          <li class="flex items-center gap-2">
            <span :class="recipients.length > 0 ? 'text-success' : 'text-muted-foreground'">
              {{ recipients.length > 0 ? '✓' : '○' }}
            </span>
            <span :class="recipients.length > 0 ? 'text-foreground' : 'text-muted-foreground'">
              {{ recipients.length }} recipient{{ recipients.length === 1 ? '' : 's' }} added
            </span>
          </li>
          <li class="flex items-center gap-2">
            <span :class="documents.length > 0 ? 'text-success' : 'text-muted-foreground'">
              {{ documents.length > 0 ? '✓' : '○' }}
            </span>
            <span :class="documents.length > 0 ? 'text-foreground' : 'text-muted-foreground'">
              {{ documents.length }} document{{ documents.length === 1 ? '' : 's' }} attached
            </span>
          </li>
          <li class="flex items-center gap-2">
            <UiBadge variant="neutral" size="xs">{{ basics.routing_kind }}</UiBadge>
            <span class="text-muted-foreground">routing</span>
          </li>
        </ul>

        <p v-if="sendError" class="mb-3 text-xs text-destructive">{{ sendError }}</p>

        <div class="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent/40"
            @click="saveAsDraft"
          >
            Save as draft
          </button>
          <button
            type="button"
            :disabled="!canSend"
            class="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            @click="sendEnvelope"
          >
            <span v-if="sending">Sending…</span>
            <span v-else>Send for signature →</span>
          </button>
        </div>
      </UiCard>
    </template>
  </AdminPageShell>
</template>
