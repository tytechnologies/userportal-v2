<script setup lang="ts">
/**
 * Request listing verification — owner-only entry to the
 * /api/listings/:id/verification endpoint.
 *
 * Reads the current `listing_verifications` row (if any) so the
 * button reflects state: not requested → "Request verification";
 * pending → "Pending review"; approved → "Verified ✓"; rejected →
 * "Rejected — Re-submit". RLS on the table limits visibility to
 * the listing owner + admin, so reading via the request-scoped
 * Supabase client is safe.
 *
 * Submit modal collects optional evidence_url + applicant_notes.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Verification = {
  id: string
  listing_id: number
  status: 'pending' | 'approved' | 'rejected'
  evidence_url: string | null
  applicant_notes: string | null
  submitted_at: string
  reviewed_at: string | null
  review_notes: string | null
}

const props = defineProps<{
  listingId: number
}>()

const supabase = useSupabaseClient()
const verification = ref<Verification | null>(null)
const loading = ref(true)
const open = ref(false)
const submitting = ref(false)
const evidenceUrl = ref('')
const applicantNotes = ref('')
const errorMsg = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const { data, error } = await (supabase as any)
      .from('listing_verifications')
      .select('id, listing_id, status, evidence_url, applicant_notes, submitted_at, reviewed_at, review_notes')
      .eq('listing_id', props.listingId)
      .maybeSingle()
    if (error) {
      // Non-owner non-admin → RLS hides the row → empty result, not
      // an error. Other errors surface silently to the operator
      // (button just shows the default state).
      verification.value = null
    } else {
      verification.value = (data as Verification | null) ?? null
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.listingId, load)

const statusLabel = computed(() => {
  const v = verification.value
  if (!v) return 'Request verification'
  if (v.status === 'pending') return 'Pending review'
  if (v.status === 'approved') return 'Verified'
  if (v.status === 'rejected') return 'Re-submit verification'
  return 'Request verification'
})

const statusClass = computed(() => {
  const v = verification.value
  if (!v) return 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground'
  if (v.status === 'approved') return 'border-success/30 bg-success/10 text-success'
  if (v.status === 'pending') return 'border-warning/30 bg-warning/10 text-warning cursor-default'
  return 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground'
})

const canOpen = computed(() => {
  const v = verification.value
  // Pending → no action available; owner waits. Approved → open the
  // modal anyway (resubmits would replace the row, which is rarely
  // useful but allowed; the button label tips the user off).
  return !v || v.status !== 'pending'
})

function openModal() {
  if (!canOpen.value) return
  evidenceUrl.value = verification.value?.evidence_url || ''
  applicantNotes.value = verification.value?.applicant_notes || ''
  errorMsg.value = null
  open.value = true
}

async function submit() {
  if (submitting.value) return
  errorMsg.value = null
  if (evidenceUrl.value && !/^https?:\/\//.test(evidenceUrl.value.trim())) {
    errorMsg.value = 'Evidence URL must start with http:// or https://'
    return
  }
  submitting.value = true
  try {
    const body: Record<string, unknown> = {}
    if (evidenceUrl.value.trim()) body.evidence_url = evidenceUrl.value.trim()
    if (applicantNotes.value.trim()) body.applicant_notes = applicantNotes.value.trim()
    await $fetch(`/api/listings/${props.listingId}/verification`, {
      method: 'POST',
      body,
    })
    showToast({ title: 'Verification requested', icon: 'success' })
    open.value = false
    await load()
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Submission failed'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div>
    <button
      type="button"
      class="inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
      :class="statusClass"
      :disabled="loading || !canOpen"
      @click="openModal"
    >
      <span v-if="verification?.status === 'approved'" aria-hidden="true">🛡️</span>
      <span v-else-if="verification?.status === 'pending'" aria-hidden="true">⏳</span>
      <span v-else aria-hidden="true">🛡️</span>
      {{ loading ? 'Loading…' : statusLabel }}
    </button>

    <p
      v-if="verification?.status === 'rejected' && verification.review_notes"
      class="mt-1 text-xs text-destructive"
    >
      Reason: {{ verification.review_notes }}
    </p>

    <Teleport to="body">
      <div
        v-if="open"
        class="fixed inset-0 z-[60]"
        role="dialog"
        aria-modal="true"
      >
        <div class="absolute inset-0 bg-foreground/50" @click="open = false" />
        <div
          class="absolute left-1/2 top-1/2 w-[min(480px,95vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-card shadow-2xl"
        >
          <header class="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 class="text-base font-semibold text-foreground">
              Request listing verification
            </h2>
            <button
              type="button"
              class="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
              aria-label="Close"
              @click="open = false"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </header>

          <div class="space-y-4 px-5 py-4">
            <p class="text-xs text-muted-foreground">
              Submit a link to ownership / authority documentation. An
              admin reviews; on approval, the listing surfaces a
              "verified" badge on the public marketplace.
            </p>

            <div>
              <label class="block text-xs font-semibold text-foreground">
                Evidence URL
              </label>
              <input
                v-model="evidenceUrl"
                type="url"
                placeholder="https://drive.example.com/proof.pdf"
                class="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>

            <div>
              <label class="block text-xs font-semibold text-foreground">
                Notes for the reviewer (optional)
              </label>
              <textarea
                v-model="applicantNotes"
                rows="3"
                maxlength="2000"
                placeholder="Anything the reviewer should know — title number, brokerage authorization, etc."
                class="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>

            <p
              v-if="errorMsg"
              class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {{ errorMsg }}
            </p>
          </div>

          <footer class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <button
              type="button"
              class="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
              @click="open = false"
            >
              Cancel
            </button>
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:opacity-50"
              :disabled="submitting"
              @click="submit"
            >
              {{ submitting ? 'Submitting…' : 'Submit for review' }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>
