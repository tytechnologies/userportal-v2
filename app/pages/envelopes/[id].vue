<script setup lang="ts">
/**
 * /envelopes/:id — envelope detail + progress.
 *
 * Shows envelope metadata, recipient state grid (who opened, who
 * signed, who declined), attached documents, and the void / audit-
 * certificate / send actions appropriate to the current status.
 *
 * For draft envelopes, the wizard at /envelopes/new is the canonical
 * editor; we link back rather than duplicating its forms here.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'
import {
  useEnvelopes,
  ENVELOPE_STATUS_LABEL,
  RECIPIENT_STATE_LABEL,
  envelopeStatusVariant,
  recipientStateVariant,
  type Envelope,
  type Recipient,
  type EnvelopeDocument,
} from '~/composables/useEnvelopes'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const api = useEnvelopes()

const id = computed(() => String(route.params.id ?? ''))
const envelope = ref<Envelope | null>(null)
const recipients = ref<Recipient[]>([])
const documents = ref<EnvelopeDocument[]>([])
const isLoading = ref(true)
const errorMsg = ref<string | null>(null)

useHead({
  title: computed(
    () => `${envelope.value?.title || 'Envelope'} | Housing Interactive`,
  ),
})

async function load() {
  if (!id.value) return
  isLoading.value = true
  errorMsg.value = null
  try {
    const res = await api.get(id.value)
    envelope.value = res.envelope
    recipients.value = res.recipients
    documents.value = res.documents
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to load envelope.'
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

// ============== Send (for draft envelopes) ==============
const sending = ref(false)
async function send() {
  if (!envelope.value || envelope.value.status !== 'draft') return
  if (recipients.value.length === 0 || documents.value.length === 0) {
    showToast({
      title: 'Add at least one recipient and one document before sending.',
      icon: 'warning',
    })
    return
  }
  sending.value = true
  try {
    const res = await api.send(envelope.value.id)
    showToast({
      title: `Envelope sent — ${res.tokens_minted} signing link${res.tokens_minted === 1 ? '' : 's'} delivered.`,
      icon: 'success',
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not send.',
      icon: 'error',
    })
  } finally {
    sending.value = false
  }
}

// ============== Void ==============
const voidOpen = ref(false)
const voidReason = ref('')
const voiding = ref(false)
function openVoid() {
  voidReason.value = ''
  voidOpen.value = true
}
async function confirmVoid() {
  if (!envelope.value) return
  if (!voidReason.value.trim()) {
    showToast({ title: 'A reason is required.', icon: 'warning' })
    return
  }
  voiding.value = true
  try {
    await api.voidEnvelope(envelope.value.id, voidReason.value.trim())
    voidOpen.value = false
    showToast({ title: 'Envelope voided.' })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not void.',
      icon: 'error',
    })
  } finally {
    voiding.value = false
  }
}

// ============== Display helpers ==============
function fmtTs(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  } catch { return '—' }
}

function recipientLabel(r: Recipient): string {
  if (r.external_email) return r.external_name || r.external_email
  return `Internal user ${r.user_id?.slice(0, 8) ?? '—'}`
}

const completedCount = computed(
  () => recipients.value.filter((r) => r.state === 'signed').length,
)
const isDraft = computed(() => envelope.value?.status === 'draft')
const isOpen = computed(() =>
  envelope.value && ['sent', 'in_progress'].includes(envelope.value.status),
)
const isFinal = computed(() =>
  envelope.value && ['completed', 'declined', 'voided', 'expired'].includes(envelope.value.status),
)

function auditCertHref(): string {
  return envelope.value ? api.auditCertificateUrl(envelope.value.id) : '#'
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="4xl">
    <NuxtLink
      to="/envelopes"
      class="inline-flex items-center gap-1 text-meta hover:text-foreground"
    >
      <span aria-hidden="true">←</span>
      All envelopes
    </NuxtLink>

    <UiCard v-if="isLoading" padding="lg">
      <div class="space-y-3">
        <UiSkeleton class="h-6 w-2/3" />
        <UiSkeleton class="h-3 w-1/2" />
      </div>
    </UiCard>

    <UiCard
      v-else-if="errorMsg"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-sm text-destructive"
    >
      {{ errorMsg }}
    </UiCard>

    <template v-else-if="envelope">
      <UiPageHeader
        :title="envelope.title || 'Untitled envelope'"
      >
        <template #description>
          <span class="flex flex-wrap items-baseline gap-2 text-meta">
            <UiBadge :variant="envelopeStatusVariant(envelope.status)" size="sm">
              {{ ENVELOPE_STATUS_LABEL[envelope.status] }}
            </UiBadge>
            <span class="capitalize">{{ envelope.routing_kind }}</span>
            <span>· Created {{ fmtTs(envelope.created_at) }}</span>
            <span v-if="envelope.sent_at">· Sent {{ fmtTs(envelope.sent_at) }}</span>
            <span v-if="envelope.completed_at">· Completed {{ fmtTs(envelope.completed_at) }}</span>
          </span>
        </template>
        <template #actions>
          <NuxtLink
            v-if="isDraft"
            to="/envelopes/new"
            class="inline-flex items-center rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent/40"
          >
            Edit in wizard
          </NuxtLink>
          <button
            v-if="isDraft"
            type="button"
            :disabled="sending || recipients.length === 0 || documents.length === 0"
            class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            @click="send"
          >
            <span v-if="sending">Sending…</span>
            <span v-else>Send for signature</span>
          </button>
          <button
            v-if="isOpen"
            type="button"
            class="inline-flex items-center rounded-lg border border-destructive/30 bg-card px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
            @click="openVoid"
          >
            Void
          </button>
          <a
            v-if="isFinal"
            :href="auditCertHref()"
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/40"
          >
            Audit certificate
            <span aria-hidden="true">â†—</span>
          </a>
        </template>
      </UiPageHeader>

      <p v-if="envelope.message" class="rounded-lg bg-muted/40 p-3 text-sm text-foreground whitespace-pre-line">
        {{ envelope.message }}
      </p>

      <UiCard v-if="envelope.status === 'voided'" padding="md" class="border-destructive/30 bg-destructive/10">
        <p class="text-sm text-destructive">
          <strong>Voided.</strong>
          <span v-if="envelope.void_reason">{{ envelope.void_reason }}</span>
        </p>
      </UiCard>

      <!-- Recipients -->
      <UiCard variant="surface" padding="none">
        <header class="flex items-baseline justify-between border-b border-border px-5 py-4">
          <div>
            <h3 class="text-card-title">Recipients</h3>
            <p class="mt-0.5 text-meta">
              {{ completedCount }} of {{ recipients.length }} signed
            </p>
          </div>
        </header>
        <div v-if="recipients.length === 0" class="p-5 text-meta">
          No recipients yet.
          <NuxtLink v-if="isDraft" to="/envelopes/new" class="text-primary hover:underline">
            Add recipients in the wizard →
          </NuxtLink>
        </div>
        <ol v-else class="divide-y divide-border">
          <li
            v-for="r in recipients"
            :key="r.id"
            class="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-baseline gap-2">
                <span class="text-sm font-medium text-foreground">
                  {{ recipientLabel(r) }}
                </span>
                <UiBadge :variant="recipientStateVariant(r.state)" size="xs">
                  {{ RECIPIENT_STATE_LABEL[r.state] }}
                </UiBadge>
                <span class="text-xs text-muted-foreground capitalize">{{ r.role }}</span>
                <span v-if="r.required === false" class="text-xs text-muted-foreground">· optional</span>
              </p>
              <p class="text-xs text-muted-foreground">
                <span v-if="r.signed_at">Signed {{ fmtTs(r.signed_at) }}</span>
                <span v-else-if="r.declined_at">Declined {{ fmtTs(r.declined_at) }}</span>
                <span v-else-if="r.opened_at">Opened {{ fmtTs(r.opened_at) }}</span>
                <span v-else-if="r.invited_at">Invited {{ fmtTs(r.invited_at) }}</span>
                <span v-else>Not yet invited</span>
              </p>
              <p v-if="r.decline_reason" class="mt-0.5 text-xs text-destructive">
                Reason: {{ r.decline_reason }}
              </p>
            </div>
          </li>
        </ol>
      </UiCard>

      <!-- Documents -->
      <UiCard variant="surface" padding="none">
        <header class="border-b border-border px-5 py-4">
          <h3 class="text-card-title">Documents</h3>
          <p class="mt-0.5 text-meta">
            {{ documents.length }} attached
          </p>
        </header>
        <div v-if="documents.length === 0" class="p-5 text-meta">
          No documents attached.
          <NuxtLink v-if="isDraft" to="/envelopes/new" class="text-primary hover:underline">
            Attach in the wizard →
          </NuxtLink>
        </div>
        <ol v-else class="divide-y divide-border">
          <li
            v-for="(doc, idx) in documents"
            :key="doc.id"
            class="flex items-center gap-3 px-5 py-3"
          >
            <span class="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground" aria-hidden="true">
              {{ idx + 1 }}
            </span>
            <NuxtLink
              :to="`/document-drafts/${doc.document_draft_id}`"
              class="text-sm text-foreground hover:underline"
            >
              Open draft #{{ doc.document_draft_id.slice(0, 8) }}…
            </NuxtLink>
          </li>
        </ol>
      </UiCard>
    </template>

    <!-- Void modal -->
    <div
      v-if="voidOpen"
      class="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 p-0 sm:items-center sm:p-4"
      @click.self="voidOpen = false"
    >
      <div class="w-full max-w-md rounded-t-2xl border border-border bg-card p-5 text-card-foreground shadow-xl sm:rounded-lg">
        <h3 class="text-lg font-semibold text-foreground">Void envelope</h3>
        <p class="mt-1 text-sm text-muted-foreground">
          Voiding terminates this envelope. Existing signing links stop working immediately. This action is audited.
        </p>
        <label class="mt-4 block">
          <span class="block text-xs font-medium text-foreground">Reason (audited)</span>
          <textarea
            v-model="voidReason"
            rows="3"
            maxlength="500"
            required
            placeholder="e.g., wrong recipient · superseded by revised version · client requested cancellation"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25 focus:outline-none focus:ring-2 focus:ring-destructive"
          />
        </label>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent/40"
            @click="voidOpen = false"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="voiding || !voidReason.trim()"
            class="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
            @click="confirmVoid"
          >
            <span v-if="voiding">Voiding…</span>
            <span v-else>Confirm void</span>
          </button>
        </div>
      </div>
    </div>
  </AdminPageShell>
</template>
