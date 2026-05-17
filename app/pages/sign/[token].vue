<script setup lang="ts">
/**
 * /sign/:token — public envelope signing page.
 *
 * Lands external signers from the envelope.invitation email. Loads
 * envelope details via /api/public/envelope-sign/:token (which also
 * advance-stamps the recipient state to 'opened' on first GET).
 *
 * Sign flows supported:
 *   - typed:           recipient types their full name + checks consent
 *   - click_to_sign:   single-click affirmation, name auto-filled
 *
 * PNG-canvas drawn signature is supported by the backend
 * (evidence.kind='png' + s3_key) but not yet by this page — defer.
 *
 * No auth required. Token is the proof of identity. Single-use:
 * after sign or decline the token is consumed and re-loading shows
 * the terminal state.
 */

import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'

definePageMeta({
  layout: false, // no chrome — keep the page clean for non-portal users
})

useHead({
  title: 'Sign document — Housing Interactive',
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})

type EnvelopeSummary = {
  id: string
  title: string
  message: string | null
  status:
    | 'draft'
    | 'sent'
    | 'in_progress'
    | 'completed'
    | 'declined'
    | 'voided'
    | 'expired'
  routing_kind: 'sequential' | 'parallel'
  expires_at: string | null
}

type RecipientSummary = {
  id: string
  envelope_id: string
  role: 'signer' | 'approver' | 'viewer' | 'cc'
  sequence: number
  required: boolean
  state:
    | 'pending'
    | 'invited'
    | 'opened'
    | 'signed'
    | 'declined'
    | 'skipped'
  external_email: string | null
  external_name: string | null
  user_id: string | null
  signed_at: string | null
  declined_at: string | null
}

type DocumentSummary = {
  id: string
  document_draft_id: string
  display_order: number
}

type LoadResponse = {
  envelope: EnvelopeSummary
  recipient: RecipientSummary
  documents: DocumentSummary[]
  token_expires_at: string
}

const route = useRoute()
const token = computed(() => String(route.params.token ?? '').trim())

const loading = ref(true)
const loadError = ref<string | null>(null)
const data = ref<LoadResponse | null>(null)

// Sign form state.
const signMode = ref<'typed' | 'click_to_sign'>('typed')
const typedName = ref('')
const consentChecked = ref(false)
const submitting = ref(false)
const submitError = ref<string | null>(null)
const submitSuccess = ref<'signed' | 'declined' | null>(null)

// Decline form.
const showDeclineForm = ref(false)
const declineReason = ref('')

const recipientName = computed(
  () => data.value?.recipient.external_name ?? null,
)
const envelopeTitle = computed(() => data.value?.envelope.title ?? '')
const inviterMessage = computed(() => data.value?.envelope.message ?? null)

const isTerminal = computed(() => {
  const s = data.value?.envelope.status
  return s === 'completed' || s === 'declined' || s === 'voided' || s === 'expired'
})

const recipientAlreadySigned = computed(
  () =>
    data.value?.recipient.state === 'signed' ||
    data.value?.recipient.state === 'declined',
)

const canSign = computed(() => {
  if (!data.value) return false
  if (isTerminal.value || recipientAlreadySigned.value) return false
  return data.value.recipient.role === 'signer' || data.value.recipient.role === 'approver'
})

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const res = await $fetch<LoadResponse>(`/api/public/envelope-sign/${token.value}`)
    data.value = res
    // Pre-fill typed name from external_name on the recipient.
    if (res.recipient.external_name) {
      typedName.value = res.recipient.external_name
    }
  } catch (err: any) {
    const status = err?.statusCode ?? err?.response?.status
    if (status === 404) {
      loadError.value = 'This signing link is not valid.'
    } else if (status === 410) {
      loadError.value =
        err?.statusMessage === 'Token expired'
          ? 'This signing link has expired.'
          : 'This signing link has already been used.'
    } else {
      loadError.value = 'Could not load this document. Please try again.'
    }
  } finally {
    loading.value = false
  }
}

async function submitSign() {
  if (!canSign.value) return
  submitError.value = null

  // Validate the chosen mode.
  if (signMode.value === 'typed') {
    if (typedName.value.trim().length < 2) {
      submitError.value = 'Type your full name to sign.'
      return
    }
    if (!consentChecked.value) {
      submitError.value =
        'Tick the box to confirm your consent to sign electronically.'
      return
    }
  } else {
    // click_to_sign — consent box still required.
    if (!consentChecked.value) {
      submitError.value =
        'Tick the box to confirm your consent to sign electronically.'
      return
    }
  }

  submitting.value = true
  try {
    const evidence =
      signMode.value === 'typed'
        ? { kind: 'typed' as const, name_typed: typedName.value.trim() }
        : {
            kind: 'click_to_sign' as const,
            consent_text:
              'I consent to sign this document electronically.',
          }
    await $fetch(`/api/public/envelope-sign/${token.value}/sign`, {
      method: 'POST',
      body: { evidence },
    })
    submitSuccess.value = 'signed'
  } catch (err: any) {
    const status = err?.statusCode ?? err?.response?.status
    submitError.value =
      status === 410
        ? 'This signing link has already been used.'
        : err?.statusMessage || 'Could not submit. Please try again.'
  } finally {
    submitting.value = false
  }
}

async function submitDecline() {
  if (!canSign.value) return
  if (declineReason.value.trim().length < 1) {
    submitError.value = 'Add a short reason so the sender knows why.'
    return
  }
  submitting.value = true
  submitError.value = null
  try {
    await $fetch(`/api/public/envelope-sign/${token.value}/decline`, {
      method: 'POST',
      body: { reason: declineReason.value.trim() },
    })
    submitSuccess.value = 'declined'
  } catch (err: any) {
    submitError.value =
      err?.statusMessage || 'Could not submit. Please try again.'
  } finally {
    submitting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="min-h-screen bg-muted/50 ">
    <!-- Top brand bar -->
    <header class="border-b bg-card  ">
      <div class="mx-auto max-w-3xl px-4 py-4 sm:px-6">
        <p class="text-sm font-semibold text-foreground">
          Housing Interactive
        </p>
      </div>
    </header>

    <main class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-8">
      <!-- Loading -->
      <div
        v-if="loading"
        class="rounded-lg border border-border bg-background p-8 text-center text-sm text-muted-foreground   dark:text-muted-foreground/70"
      >
        Loading document…
      </div>

      <!-- Load error (404 / 410 / network) -->
      <div
        v-else-if="loadError"
        class="rounded-lg border border-destructive/30 bg-destructive/10 p-6"
      >
        <h1 class="mb-2 text-base font-semibold text-destructive ">
          We can't open this link
        </h1>
        <p class="text-sm text-destructive ">{{ loadError }}</p>
        <p class="mt-4 text-xs text-destructive">
          If you believe this is an error, please reply to the email that brought you here.
        </p>
      </div>

      <!-- Success after sign or decline -->
      <div
        v-else-if="submitSuccess === 'signed'"
        class="rounded-lg border border-success/30 bg-success/10 p-8 text-center"
      >
        <h1 class="mb-2 text-lg font-semibold text-success ">
          Signed — thank you
        </h1>
        <p class="text-sm text-success ">
          We've recorded your signature on <strong>{{ envelopeTitle }}</strong>.
          The sender has been notified.
        </p>
      </div>

      <div
        v-else-if="submitSuccess === 'declined'"
        class="rounded-lg border border-warning/30 bg-warning/10 p-8 text-center dark:border-amber-900 "
      >
        <h1 class="mb-2 text-lg font-semibold text-warning ">
          Decline recorded
        </h1>
        <p class="text-sm text-warning">
          We've let the sender know you've declined to sign.
        </p>
      </div>

      <!-- Already terminal at load time -->
      <div
        v-else-if="data && (isTerminal || recipientAlreadySigned)"
        class="rounded-lg border border-border bg-background p-6  "
      >
        <h1 class="mb-2 text-base font-semibold text-foreground">
          {{ envelopeTitle }}
        </h1>
        <p class="text-sm text-muted-foreground">
          <template v-if="data.recipient.state === 'signed'">
            You've already signed this document on
            <time>{{ new Date(data.recipient.signed_at!).toLocaleString() }}</time>.
          </template>
          <template v-else-if="data.recipient.state === 'declined'">
            You've already declined this document on
            <time>{{ new Date(data.recipient.declined_at!).toLocaleString() }}</time>.
          </template>
          <template v-else-if="data.envelope.status === 'completed'">
            All parties have signed this document.
          </template>
          <template v-else-if="data.envelope.status === 'voided'">
            The sender voided this document.
          </template>
          <template v-else-if="data.envelope.status === 'expired'">
            This document expired.
          </template>
          <template v-else>
            This document is no longer accepting signatures.
          </template>
        </p>
      </div>

      <!-- Active sign flow -->
      <div
        v-else-if="data && canSign"
        class="space-y-6"
      >
        <!-- Envelope header card -->
        <section
          class="rounded-lg border border-border bg-background p-6  "
        >
          <p class="text-xs uppercase tracking-wide text-muted-foreground">
            You have been asked to sign
          </p>
          <h1 class="mt-1 text-xl font-semibold text-foreground">
            {{ envelopeTitle }}
          </h1>
          <p
            v-if="recipientName"
            class="mt-1 text-sm text-muted-foreground"
          >
            For: {{ recipientName }}
          </p>
          <div
            v-if="inviterMessage"
            class="mt-4 border-l-4 border-primary/30 bg-primary/10 p-3 text-sm italic text-foreground"
          >
            {{ inviterMessage }}
          </div>
          <p class="mt-4 text-xs text-muted-foreground">
            {{ data.documents.length }} document<span v-if="data.documents.length !== 1">s</span>
            attached. Document content opens when you proceed to sign.
          </p>
        </section>

        <!-- Sign form -->
        <section
          class="rounded-lg border border-border bg-background p-6  "
        >
          <h2 class="mb-4 text-base font-semibold text-foreground">
            Sign
          </h2>

          <!-- Mode toggle -->
          <div class="mb-4 inline-flex rounded-lg border border-border p-1">
            <button
              type="button"
              :class="[
                'px-3 py-1.5 text-sm font-medium rounded-md transition',
                signMode === 'typed'
                  ? 'bg-primary text-white'
                  : 'text-foreground hover:text-foreground/80',
              ]"
              @click="signMode = 'typed'"
            >
              Type my name
            </button>
            <button
              type="button"
              :class="[
                'ml-1 px-3 py-1.5 text-sm font-medium rounded-md transition',
                signMode === 'click_to_sign'
                  ? 'bg-primary text-white'
                  : 'text-foreground hover:text-foreground/80',
              ]"
              @click="signMode = 'click_to_sign'"
            >
              Click-to-sign
            </button>
          </div>

          <form @submit.prevent="submitSign">
            <div v-if="signMode === 'typed'" class="mb-4">
              <label
                for="typed-name"
                class="block text-sm font-medium text-foreground"
              >
                Your full legal name
              </label>
              <input
                id="typed-name"
                v-model="typedName"
                type="text"
                autocomplete="name"
                required
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25 "
              />
              <p class="mt-2 text-xs text-muted-foreground">
                By typing your name, you agree your typed signature has the same legal
                effect as your handwritten signature.
              </p>
            </div>

            <div v-else class="mb-4 rounded-lg border border-border bg-muted/50 p-4  ">
              <p class="text-sm text-foreground">
                I, <strong>{{ recipientName || 'the named recipient' }}</strong>, consent
                to sign this document electronically.
              </p>
            </div>

            <label class="flex items-start gap-2 text-sm text-foreground">
              <input
                v-model="consentChecked"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                I consent to sign this document electronically and acknowledge my
                signature, IP address, and timestamp will be recorded as proof.
              </span>
            </label>

            <p
              v-if="submitError"
              class="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {{ submitError }}
            </p>

            <div class="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                :disabled="submitting"
                class="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span v-if="submitting">Signing…</span>
                <span v-else>Sign document</span>
              </button>
              <button
                type="button"
                class="text-sm text-muted-foreground underline-offset-2 hover:underline dark:text-muted-foreground/70"
                @click="showDeclineForm = !showDeclineForm"
              >
                Decline to sign
              </button>
            </div>
          </form>
        </section>

        <!-- Decline form (collapsible) -->
        <section
          v-if="showDeclineForm"
          class="rounded-lg border border-warning/30 bg-warning/10 p-6"
        >
          <h2 class="mb-2 text-base font-semibold text-warning ">
            Decline this document
          </h2>
          <p class="mb-3 text-sm text-warning">
            Your decline will notify the sender. Add a short reason so they can follow up.
          </p>
          <form @submit.prevent="submitDecline">
            <textarea
              v-model="declineReason"
              rows="3"
              required
              maxlength="500"
              placeholder="e.g., terms need revision, wrong recipient, …"
              class="block w-full rounded-lg border border-warning/40 bg-card px-3 py-2 text-sm shadow-sm focus:border-warning focus:ring-1 focus:ring-warning"
            />
            <div class="mt-3 flex items-center gap-3">
              <button
                type="submit"
                :disabled="submitting"
                class="inline-flex items-center rounded-lg bg-warning px-4 py-2 text-sm font-semibold text-warning-foreground shadow hover:bg-warning/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span v-if="submitting">Submitting…</span>
                <span v-else>Submit decline</span>
              </button>
              <button
                type="button"
                class="text-sm text-warning underline-offset-2 hover:underline "
                @click="showDeclineForm = false"
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      </div>

      <footer class="mt-10 text-center text-xs text-muted-foreground/70">
        Signed via Housing Interactive · Your IP and browser are recorded as part of the
        audit certificate.
      </footer>
    </main>
  </div>
</template>
