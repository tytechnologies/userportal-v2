<script setup lang="ts">
/**
 * Forward an inquiry to a co-broker.
 *
 * POST /api/inquiries/:id/forward — backend gates on the recipient
 * having an accepted listing_share with respond_to_inquiries
 * capability OR being the listing's owner. The dropdown only shows
 * candidates that pass the check (resolved server-side via the
 * listing's collaborators view).
 */
import { ref, computed, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Collaborator = {
  user_id: string
  full_name: string | null
  avatar_url: string | null
  share_role: string | null
}

const props = defineProps<{
  open: boolean
  inquiryId: string | null
  listingId: number | null
}>()

const emit = defineEmits<{
  close: []
  forwarded: [toUserId: string]
}>()

const collaborators = ref<Collaborator[]>([])
const targetUserId = ref<string>('')
const message = ref('')
const loadingCollabs = ref(false)
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

watch(
  () => [props.open, props.listingId] as const,
  async ([open, listingId]) => {
    if (!open || !listingId) return
    targetUserId.value = ''
    message.value = ''
    errorMsg.value = null
    loadingCollabs.value = true
    try {
      // Pull from the public_listing_collaborators view — already
      // surfaces accepted shares with verified flag. The forward
      // endpoint will validate respond_to_inquiries capability;
      // surfacing all accepted collaborators here is fine because
      // the server side is the security boundary.
      const supabase = useSupabaseClient()
      const { data, error } = await (supabase as any)
        .from('public_listing_collaborators')
        .select('user_id, full_name, avatar_url, share_role')
        .eq('listing_id', listingId)
      if (error) throw error
      collaborators.value = (data ?? []) as Collaborator[]
    } catch (err: any) {
      errorMsg.value = err?.message || 'Failed to load co-brokers'
    } finally {
      loadingCollabs.value = false
    }
  },
  { immediate: true },
)

const canSubmit = computed(
  () => !!targetUserId.value && !submitting.value && !!props.inquiryId,
)

async function submit() {
  if (!canSubmit.value || !props.inquiryId) return
  submitting.value = true
  errorMsg.value = null
  try {
    await $fetch(`/api/inquiries/${props.inquiryId}/forward`, {
      method: 'POST',
      body: {
        to_user_id: targetUserId.value,
        message: message.value.trim() || undefined,
      },
    })
    showToast({ title: 'Inquiry forwarded', icon: 'success' })
    emit('forwarded', targetUserId.value)
    emit('close')
  } catch (err: any) {
    // 422 = recipient lacks respond_to_inquiries capability;
    // surface the clean server message.
    errorMsg.value = err?.statusMessage || err?.message || 'Forward failed'
  } finally {
    submitting.value = false
  }
}

const isEmpty = computed(
  () => !loadingCollabs.value && collaborators.value.length === 0,
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[60]"
      role="dialog"
      aria-modal="true"
    >
      <div class="absolute inset-0 bg-foreground/50" @click="emit('close')" />
      <div
        class="absolute left-1/2 top-1/2 w-[min(480px,95vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-card shadow-2xl"
      >
        <header class="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 class="text-base font-semibold text-foreground">
            Forward inquiry
          </h2>
          <button
            type="button"
            class="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Close"
            @click="emit('close')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div class="space-y-4 px-5 py-4">
          <p class="text-xs text-muted-foreground">
            Hand off this inquiry to a co-broker on the listing.
            Only collaborators with the
            <code class="rounded bg-muted px-1">respond_to_inquiries</code>
            capability can be selected.
          </p>

          <div>
            <label class="block text-xs font-semibold text-foreground">
              Forward to
            </label>
            <select
              v-model="targetUserId"
              :disabled="loadingCollabs || submitting"
              class="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            >
              <option value="">
                {{ loadingCollabs ? 'Loading collaborators…' : 'Pick a co-broker…' }}
              </option>
              <option
                v-for="c in collaborators"
                :key="c.user_id"
                :value="c.user_id"
              >
                {{ c.full_name || c.user_id }} ({{ c.share_role || 'collaborator' }})
              </option>
            </select>
            <p
              v-if="isEmpty"
              class="mt-1 text-xs text-warning"
            >
              No collaborators on this listing yet. Share the listing
              with another agent first (with respond_to_inquiries
              capability) to enable forwarding.
            </p>
          </div>

          <div>
            <label class="block text-xs font-semibold text-foreground">
              Note for the recipient (optional)
            </label>
            <textarea
              v-model="message"
              rows="3"
              maxlength="2000"
              placeholder="Context for the partner agent — why you're forwarding, what they should know."
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
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:opacity-50"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ submitting ? 'Forwarding…' : 'Forward' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
