<script setup lang="ts">
// Share-listing dialog. Owner picks a recipient (typeahead over
// profiles), a role, optional expiry + message; POST creates the share
// with status='pending'. Recipient sees it on /shares and accepts via
// useListingShares.acceptShare().
//
// User picker queries `profiles` directly through supabase — that table
// is gated by an authenticated SELECT policy that allows reads for any
// signed-in user (so we can build user pickers across the app).
//
// Conflict (already shared with that user): the API returns 409 with
// existing_id; we show a "already shared" message rather than create
// a duplicate.

import { ref, watch } from 'vue'
import { useListingShares, type ShareRole } from '~/composables/useListingShares'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  open: boolean
  listingId: number
  listingTitle?: string | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'shared', listingId: number): void
}>()

const { createShare } = useListingShares()
const supabase = useSupabaseClient()

type ProfileMatch = { id: string; full_name: string | null; email: string | null; role: string | null }

const search = ref('')
const matches = ref<ProfileMatch[]>([])
const isSearching = ref(false)
const selected = ref<ProfileMatch | null>(null)

const role = ref<ShareRole>('co_broker')
const message = ref('')
const expiresAt = ref('')
const isSubmitting = ref(false)
const errorMessage = ref<string | null>(null)

// Debounced typeahead. 250ms is enough that quick typists don't flood
// the network; lower felt twitchy in testing.
let debounceHandle: ReturnType<typeof setTimeout> | null = null
watch(search, (q) => {
  if (debounceHandle) clearTimeout(debounceHandle)
  debounceHandle = setTimeout(() => runSearch(q), 250)
})

async function runSearch(q: string) {
  const trimmed = q.trim()
  if (trimmed.length < 2) {
    matches.value = []
    return
  }
  isSearching.value = true
  try {
    // Strip PostgREST OR-DSL chars before interpolation; same hygiene
    // pattern used in useAdmin.listProfiles.
    const safe = trimmed.replace(/[%,()]/g, '')
    const { data } = await (supabase as any)
      .from('profiles')
      .select('id, full_name, email, role')
      .or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
      .limit(8)
    matches.value = (data ?? []) as ProfileMatch[]
  } finally {
    isSearching.value = false
  }
}

function pick(p: ProfileMatch) {
  selected.value = p
  search.value = p.full_name || p.email || p.id
  matches.value = []
}

function reset() {
  search.value = ''
  matches.value = []
  selected.value = null
  role.value = 'co_broker'
  message.value = ''
  expiresAt.value = ''
  errorMessage.value = null
}

watch(() => props.open, (isOpen) => { if (isOpen) reset() })

async function onSubmit() {
  if (!selected.value) {
    errorMessage.value = 'Pick a user to share with.'
    return
  }
  isSubmitting.value = true
  errorMessage.value = null
  try {
    await createShare({
      listing_id: props.listingId,
      shared_with_user_id: selected.value.id,
      share_role: role.value,
      message: message.value.trim() || null,
      expires_at: expiresAt.value ? new Date(expiresAt.value).toISOString() : null,
    })
    showToast({ title: 'Share invite sent', icon: 'success' })
    emit('shared', props.listingId)
    emit('close')
  } catch (err: any) {
    if (err?.statusCode === 409) {
      errorMessage.value = err?.statusMessage || 'Already shared with that user.'
    } else {
      errorMessage.value = err?.statusMessage || err?.message || 'Failed to send invite'
    }
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <UiModal
    :open="open"
    title="Share listing"
    :subtitle="listingTitle || undefined"
    width="md"
    @update:open="(v) => { if (!v) $emit('close') }"
  >
    <div class="space-y-3">
      <!-- User picker -->
      <div class="relative">
        <label class="mb-1 block text-xs font-medium text-muted-foreground">Share with</label>
        <input
          v-model="search"
          type="text"
          placeholder="Search by name or email…"
          class="block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          autocomplete="off"
        />
        <div
          v-if="matches.length > 0"
          class="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border-strong bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-8px_rgba(15,23,42,0.16)]"
        >
          <button
            v-for="m in matches"
            :key="m.id"
            type="button"
            class="block w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            @click="pick(m)"
          >
            <div class="font-medium text-foreground">{{ m.full_name || '(no name)' }}</div>
            <div class="text-xs text-muted-foreground">{{ m.email }} · {{ m.role }}</div>
          </button>
        </div>
        <p v-if="isSearching" class="mt-1 text-xs text-muted-foreground/70">Searching…</p>
      </div>

      <!-- Role -->
      <div>
        <label class="mb-1 block text-xs font-medium text-muted-foreground">Role</label>
        <select
          v-model="role"
          class="block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        >
          <option value="co_broker">Co-broker (read + edit)</option>
          <option value="viewer">Viewer (read-only)</option>
        </select>
      </div>

      <!-- Optional expiry -->
      <div>
        <label class="mb-1 block text-xs font-medium text-muted-foreground">
          Expires <span class="text-muted-foreground/70">(optional)</span>
        </label>
        <input
          v-model="expiresAt"
          type="date"
          class="block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
      </div>

      <!-- Optional message -->
      <div>
        <label class="mb-1 block text-xs font-medium text-muted-foreground">
          Message <span class="text-muted-foreground/70">(optional)</span>
        </label>
        <textarea
          v-model="message"
          rows="2"
          maxlength="2000"
          class="block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          placeholder="Quick note for the recipient…"
        />
      </div>

      <p v-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>
    </div>
    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          @click="$emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn-primary disabled:opacity-50"
          :disabled="!selected || isSubmitting"
          @click="onSubmit"
        >
          {{ isSubmitting ? 'Sending…' : 'Send invite' }}
        </button>
      </div>
    </template>
  </UiModal>
</template>
