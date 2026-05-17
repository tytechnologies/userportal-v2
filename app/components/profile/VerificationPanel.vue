<script setup lang="ts">
/**
 * Agent self-service verification panel.
 *
 * Mounted on /my-profile below the main profile form. Shows the
 * agent's current verification state and lets them submit a new
 * request when there's no pending one.
 *
 * State machine (purely UI; backend allows multiple submissions):
 *   - any approved row     → "Verified" badge, no form
 *   - pending row          → "Pending review" status, form disabled
 *   - rejected (no others) → show rejection reason + resubmit form
 *   - no rows              → CTA + submit form
 *
 * RLS scopes the GET to the calling user's own rows; we don't filter
 * by profile_id ourselves.
 */
import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'

type Verification = {
  id: string
  profile_id: string
  status: 'pending' | 'approved' | 'rejected'
  license_number: string | null
  license_authority: string | null
  brokerage_name: string | null
  evidence_url: string | null
  applicant_notes: string | null
  submitted_at: string
  reviewed_at: string | null
  review_notes: string | null
}

const URL_RE = /^https?:\/\/[^\s]+$/i

const rows = ref<Verification[]>([])
const loading = ref(true)
const submitting = ref(false)

const form = ref({
  license_number: '',
  license_authority: '',
  brokerage_name: '',
  evidence_url: '',
  applicant_notes: '',
})

const errors = ref<Record<string, string>>({})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Verification[] }>('/api/profile-verifications', {
      query: { page: 1, page_size: 20 },
    })
    rows.value = (res.data ?? []) as Verification[]
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load verification status',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

const approved = computed(() => rows.value.find((r) => r.status === 'approved') || null)
const pending = computed(() => rows.value.find((r) => r.status === 'pending') || null)
const lastRejected = computed(() => {
  const rejs = rows.value
    .filter((r) => r.status === 'rejected')
    .sort(
      (a, b) =>
        new Date(b.reviewed_at || b.submitted_at).getTime() -
        new Date(a.reviewed_at || a.submitted_at).getTime(),
    )
  return rejs[0] ?? null
})

// Show submit form when not verified AND not pending.
const canSubmit = computed(() => !approved.value && !pending.value)

function validate(): boolean {
  const errs: Record<string, string> = {}
  // At least one of license_number OR brokerage_name is required —
  // otherwise there's nothing for the admin to verify against.
  if (!form.value.license_number.trim() && !form.value.brokerage_name.trim()) {
    errs.general = 'Provide at least a license number or brokerage name.'
  }
  if (form.value.evidence_url.trim() && !URL_RE.test(form.value.evidence_url.trim())) {
    errs.evidence_url = 'Must be a full URL starting with http:// or https://'
  }
  if (form.value.applicant_notes.length > 4000) {
    errs.applicant_notes = 'Notes must be under 4000 characters.'
  }
  errors.value = errs
  return Object.keys(errs).length === 0
}

async function submit() {
  if (submitting.value) return
  if (!validate()) return

  submitting.value = true
  try {
    await $fetch('/api/profile-verifications', {
      method: 'POST',
      body: {
        license_number: form.value.license_number.trim() || null,
        license_authority: form.value.license_authority.trim() || null,
        brokerage_name: form.value.brokerage_name.trim() || null,
        evidence_url: form.value.evidence_url.trim() || null,
        applicant_notes: form.value.applicant_notes.trim() || null,
      },
    })
    showToast({ title: 'Submitted for review', icon: 'success' })
    // Reset form + re-load so the panel flips to the pending state.
    form.value = {
      license_number: '',
      license_authority: '',
      brokerage_name: '',
      evidence_url: '',
      applicant_notes: '',
    }
    errors.value = {}
    await load()
  } catch (err: any) {
    showToast({
      title:
        err?.data?.issues?.[0]?.message ||
        err?.statusMessage ||
        err?.message ||
        'Failed to submit',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="mt-8 rounded-xl border border-border bg-background p-5">
    <header class="mb-4 flex items-start gap-3">
      <h2 class="text-base font-semibold text-foreground">Verification</h2>
      <span
        v-if="approved"
        class="ml-auto inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success"
      >
        <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fill-rule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L9 11.6l6.3-6.3a1 1 0 0 1 1.4 0Z"
            clip-rule="evenodd"
          />
        </svg>
        Verified
      </span>
      <span
        v-else-if="pending"
        class="ml-auto inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning"
      >
        Pending review
      </span>
    </header>

    <div v-if="loading" class="text-sm text-muted-foreground">Loading…</div>

    <div v-else-if="approved" class="text-sm text-foreground">
      <p>
        Your profile is verified.
        Public listings and your agent profile page show a verified badge.
      </p>
      <p v-if="approved.reviewed_at" class="mt-1 text-xs text-muted-foreground">
        Approved {{ new Date(approved.reviewed_at).toLocaleDateString() }}
      </p>
    </div>

    <div v-else-if="pending" class="text-sm text-foreground">
      <p>
        Your verification request was submitted on
        {{ new Date(pending.submitted_at).toLocaleDateString() }}.
        An admin will review it shortly. We'll email you when there's a
        decision.
      </p>
    </div>

    <form v-else novalidate @submit.prevent="submit">
      <div
        v-if="lastRejected"
        class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <p class="font-semibold">Previous request was not approved.</p>
        <p v-if="lastRejected.review_notes" class="mt-1">
          Reviewer's note: <span class="italic">{{ lastRejected.review_notes }}</span>
        </p>
        <p class="mt-1">You can submit a new request below.</p>
      </div>

      <p class="mb-4 text-sm text-muted-foreground">
        Provide your license + brokerage so we can verify your profile. The
        info you submit is reviewed by an admin and is not shown publicly.
        Once approved, a verified badge appears on your public agent profile
        and listing cards.
      </p>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="block text-sm">
          <span class="text-foreground">License number</span>
          <input
            v-model="form.license_number"
            type="text"
            maxlength="80"
            class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <label class="block text-sm">
          <span class="text-foreground">Issuing authority</span>
          <input
            v-model="form.license_authority"
            type="text"
            maxlength="80"
            placeholder="e.g. PRC, HLURB, DTI"
            class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <label class="block text-sm sm:col-span-2">
          <span class="text-foreground">Brokerage</span>
          <input
            v-model="form.brokerage_name"
            type="text"
            maxlength="160"
            class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <label class="block text-sm sm:col-span-2">
          <span class="text-foreground">Evidence URL</span>
          <input
            v-model="form.evidence_url"
            type="url"
            maxlength="2048"
            placeholder="Link to license document, brokerage page, etc."
            class="mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1"
            :class="
              errors.evidence_url
                ? 'border-destructive/30 focus:border-destructive focus:ring-destructive/30'
                : 'border-border focus:border-primary/30 focus:ring-primary/30'
            "
          />
          <span v-if="errors.evidence_url" class="mt-1 block text-xs text-destructive">
            {{ errors.evidence_url }}
          </span>
        </label>
        <label class="block text-sm sm:col-span-2">
          <span class="text-foreground">Notes for reviewer (optional)</span>
          <textarea
            v-model="form.applicant_notes"
            rows="3"
            maxlength="4000"
            class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
      </div>

      <p
        v-if="errors.general"
        class="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {{ errors.general }}
      </p>

      <div class="mt-4">
        <button
          type="submit"
          class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
          :disabled="submitting"
        >
          {{ submitting ? 'Submitting…' : 'Submit for review' }}
        </button>
      </div>
    </form>
  </section>
</template>
