<script setup lang="ts">
/**
 * Send-for-eSign modal.
 *
 * Pre-fills one row per signature placeholder on the draft. Broker
 * fills in name + email (one per signer), optional subject + message,
 * then submits to /api/document-drafts/:id/esign/send.
 *
 * The endpoint pre-renders the draft to PDF (Puppeteer) and creates
 * a DocuSign envelope with anchor-based SignHere tabs at each
 * `{{sig:<placeholder_id>}}` marker. Recipients with no email or
 * with empty names are filtered out before submit — DocuSign rejects
 * those.
 */
import { computed, ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import {
  readPlaceholders,
  type SignaturePlaceholder,
} from '~/utils/signaturePlaceholders'
import type { DocumentDraft } from '~/composables/useDocumentDrafts'

type Recipient = {
  placeholder_id: string
  label: string
  role: string
  name: string
  email: string
}

const props = defineProps<{
  open: boolean
  draft: DocumentDraft
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'sent', envelopeId: string): void
}>()

const subject = ref('')
const message = ref('')
const recipients = ref<Recipient[]>([])
const sending = ref(false)
const notConfigured = ref<{ admin_path: string } | null>(null)
const consentRequired = ref<{ consent_url: string } | null>(null)

// Reset on open. Pre-fill subject from the draft title and seed
// recipients from the placeholder list so the broker just types
// emails.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    notConfigured.value = null
    consentRequired.value = null
    subject.value = props.draft.title
      ? `Please sign: ${props.draft.title}`
      : 'Please sign this document'
    message.value = 'Please review and sign at your earliest convenience.'
    const placeholders: SignaturePlaceholder[] = readPlaceholders(props.draft.data)
    recipients.value = placeholders.map((p) => ({
      placeholder_id: p.id,
      label: p.label,
      role:  p.party_role,
      name:  '',
      email: '',
    }))
  },
  { immediate: true },
)

const canSubmit = computed(() => {
  if (sending.value) return false
  if (recipients.value.length === 0) return false
  // Every row needs both name and email; pure-email rules are
  // intentionally loose — DocuSign re-validates server-side.
  return recipients.value.every(
    (r) => r.name.trim().length > 0 && /\S+@\S+\.\S+/.test(r.email.trim()),
  )
})

async function submit() {
  if (!canSubmit.value) return
  sending.value = true
  notConfigured.value = null
  consentRequired.value = null
  try {
    const res = await $fetch<{ envelope_id: string }>(
      `/api/document-drafts/${props.draft.id}/esign/send`,
      {
        method: 'POST',
        body: {
          subject: subject.value.trim() || undefined,
          message: message.value.trim() || undefined,
          recipients: recipients.value.map((r) => ({
            placeholder_id: r.placeholder_id,
            name: r.name.trim(),
            email: r.email.trim(),
            role: r.role,
          })),
        },
      },
    )
    showToast({ title: 'Envelope sent to DocuSign', icon: 'success' })
    emit('sent', res.envelope_id)
    emit('update:open', false)
  } catch (err: any) {
    if (err?.statusCode === 503 && err?.data?.code === 'docusign_not_configured') {
      notConfigured.value = { admin_path: err.data.admin_path || '/admin/esign-settings' }
    } else if (err?.statusCode === 503 && err?.data?.code === 'docusign_consent_required') {
      consentRequired.value = { consent_url: err.data.consent_url }
    } else {
      showToast({
        title: err?.statusMessage || err?.message || 'Send failed',
        icon: 'error',
      })
    }
  } finally {
    sending.value = false
  }
}

function close() {
  if (sending.value) return
  emit('update:open', false)
}

const noPlaceholders = computed(() => recipients.value.length === 0)
</script>

<template>
  <UiModal
    :open="open"
    title="Send for e-signing"
    subtitle="DocuSign will email each recipient a signing link. Status updates flow back via webhook."
    width="lg"
    :persistent="sending"
    @update:open="(v) => { if (!v) close() }"
  >
    <div class="space-y-3">
      <!-- Setup-required CTA -->
      <p
        v-if="notConfigured"
        class="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground"
      >
        DocuSign isn't configured yet — a platform admin needs to set
        the integration key + private key.
        <NuxtLink
          :to="notConfigured.admin_path"
          class="ml-1 font-semibold text-primary hover:underline focus-ring rounded"
        >
          Open eSign settings →
        </NuxtLink>
      </p>

      <!-- Consent-required CTA -->
      <div
        v-if="consentRequired"
        class="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground"
      >
        <strong>One-time DocuSign consent needed.</strong>
        Visit this URL once to grant the JWT scopes, then come back
        and re-send.
        <a
          :href="consentRequired.consent_url"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-1 block break-all font-mono text-[11px] text-primary underline"
        >{{ consentRequired.consent_url }}</a>
      </div>

      <!-- No placeholders → can't send -->
      <p
        v-if="noPlaceholders"
        class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
      >
        Add at least one signature placeholder above before sending.
        Each placeholder becomes one DocuSign signer.
      </p>

      <template v-else>
        <!-- Subject + message -->
        <div class="grid gap-2 sm:grid-cols-2">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Email subject</span>
            <input
              v-model="subject"
              type="text"
              maxlength="200"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-1.5 text-xs"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Email message</span>
            <input
              v-model="message"
              type="text"
              maxlength="2000"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-1.5 text-xs"
            />
          </label>
        </div>

        <!-- One row per placeholder. Routing order = display order. -->
        <p class="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Recipients ({{ recipients.length }})
        </p>
        <div class="space-y-2">
          <div
            v-for="(r, idx) in recipients"
            :key="r.placeholder_id"
            class="rounded-md border border-border bg-card p-3"
          >
            <p class="mb-1.5 flex items-baseline gap-2 text-xs">
              <span class="font-mono text-[10px] text-muted-foreground">#{{ idx + 1 }}</span>
              <span class="font-semibold text-foreground">{{ r.label }}</span>
              <span class="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                {{ r.role.replace('_', ' ') }}
              </span>
            </p>
            <div class="grid gap-2 sm:grid-cols-2">
              <input
                v-model="r.name"
                type="text"
                maxlength="200"
                placeholder="Full name"
                class="rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
              <input
                v-model="r.email"
                type="email"
                maxlength="320"
                placeholder="email@example.com"
                class="rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </div>
          </div>
        </div>

        <p class="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-muted-foreground">
          The PDF DocuSign sends is rendered server-side from the
          current draft. Snapshot a version first if you want this
          envelope pinned to a specific revision.
        </p>
      </template>
    </div>

    <template #footer>
      <button
        type="button"
        class="rounded-md border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground hover:bg-accent focus-ring"
        :disabled="sending"
        @click="close"
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!canSubmit"
        @click="submit"
      >
        {{ sending ? 'Sending…' : 'Send envelope' }}
      </button>
    </template>
  </UiModal>
</template>
