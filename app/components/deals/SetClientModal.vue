<script setup lang="ts">
/**
 * Deal client (buyer contact) picker.
 *
 * Three modes:
 *   create   — new contact owned by the caller
 *   existing — typeahead pick from contacts the caller can read
 *   clear    — only available when the deal already has a buyer
 *
 * Submits to PATCH /api/deals/:id/buyer-contact and emits 'updated'
 * with the refreshed deal payload (same shape getById returns) so
 * the parent page can patch state without a follow-up GET.
 */
import { ref, computed, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type ContactMatch = {
  id: number
  full_name: string | null
  email: string | null
  mobile_phone: string | null
}

const props = defineProps<{
  open: boolean
  dealId: string
  /** Whether the deal already has a buyer set (drives the 'clear' tab visibility). */
  hasExistingBuyer: boolean
  /** Pre-fill values for the create-mode form (e.g. from inquiry sender_*). */
  prefill?: {
    full_name?: string
    email?: string
    mobile_phone?: string
  }
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'updated', payload: { deal: any }): void
}>()

type Mode = 'create' | 'existing' | 'clear'
const mode = ref<Mode>('existing')

const form = ref({
  full_name: '',
  email: '',
  mobile_phone: '',
  notes: '',
})

const search = ref('')
const searching = ref(false)
const matches = ref<ContactMatch[]>([])
const picked = ref<ContactMatch | null>(null)
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

const submitting = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    // Default mode: existing if a buyer is already set (most common
    // is "swap to a different contact"), create otherwise (because the
    // operator hit "Set client" specifically to add one).
    mode.value = props.hasExistingBuyer ? 'existing' : 'create'
    form.value.full_name = props.prefill?.full_name ?? ''
    form.value.email = props.prefill?.email ?? ''
    form.value.mobile_phone = props.prefill?.mobile_phone ?? ''
    form.value.notes = ''
    search.value = ''
    matches.value = []
    picked.value = null
  },
  { immediate: true },
)

async function runSearch() {
  const q = search.value.trim()
  if (q.length < 2) {
    matches.value = []
    return
  }
  searching.value = true
  const seq = ++searchSeq
  try {
    const supabase = useSupabaseClient()
    const { data } = await (supabase as any)
      .from('contacts')
      .select('id, full_name, email, mobile_phone')
      .or(`full_name.ilike.%${q}%,email.ilike.%${q}%,mobile_phone.ilike.%${q}%`)
      .limit(8)
    if (seq !== searchSeq) return
    matches.value = (data ?? []) as ContactMatch[]
  } catch {
    if (seq === searchSeq) matches.value = []
  } finally {
    if (seq === searchSeq) searching.value = false
  }
}

watch(search, (v) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!v.trim()) {
    matches.value = []
    picked.value = null
    return
  }
  if (picked.value && v !== (picked.value.full_name || picked.value.email || '')) {
    picked.value = null
  }
  searchTimer = setTimeout(runSearch, 220)
})

function pickMatch(m: ContactMatch) {
  picked.value = m
  search.value = m.full_name || m.email || `Contact #${m.id}`
  matches.value = []
}

const canSubmit = computed(() => {
  if (submitting.value) return false
  if (mode.value === 'create') return form.value.full_name.trim().length > 0
  if (mode.value === 'existing') return !!picked.value
  return true // clear
})

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const body: Record<string, unknown> = {}
    if (mode.value === 'create') {
      body.contact = {
        mode: 'create',
        full_name: form.value.full_name.trim(),
        email: form.value.email.trim() || undefined,
        mobile_phone: form.value.mobile_phone.trim() || undefined,
        notes: form.value.notes.trim() || undefined,
      }
    } else if (mode.value === 'existing') {
      body.contact = { mode: 'existing', contact_id: picked.value!.id }
    } else {
      body.contact = { mode: 'clear' }
    }

    const deal = await $fetch<any>(
      `/api/deals/${props.dealId}/buyer-contact`,
      { method: 'PATCH', body },
    )
    showToast({
      title:
        mode.value === 'create'
          ? 'Client created and linked'
          : mode.value === 'existing'
            ? 'Client linked to deal'
            : 'Client unlinked',
      icon: 'success',
    })
    emit('updated', { deal })
    emit('update:open', false)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Update failed',
      icon: 'error',
    })
  } finally {
    submitting.value = false
  }
}

function cancel() {
  if (submitting.value) return
  emit('update:open', false)
}
</script>

<template>
  <UiModal
    :open="open"
    :title="hasExistingBuyer ? 'Change client' : 'Set client'"
    subtitle="Link a CRM contact to this deal as the buyer / client."
    width="md"
    :persistent="submitting"
    @update:open="(v) => { if (!v) cancel() }"
  >
    <div class="space-y-3">
      <div role="radiogroup" aria-label="Mode" class="grid gap-2" :class="hasExistingBuyer ? 'grid-cols-3' : 'grid-cols-2'">
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'existing'"
          :class="[
            'rounded-md border px-3 py-2 text-xs font-medium transition-colors focus-ring',
            mode === 'existing'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:border-border-strong hover:bg-accent',
          ]"
          @click="mode = 'existing'"
        >
          Existing client
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'create'"
          :class="[
            'rounded-md border px-3 py-2 text-xs font-medium transition-colors focus-ring',
            mode === 'create'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:border-border-strong hover:bg-accent',
          ]"
          @click="mode = 'create'"
        >
          New client
        </button>
        <button
          v-if="hasExistingBuyer"
          type="button"
          role="radio"
          :aria-checked="mode === 'clear'"
          :class="[
            'rounded-md border px-3 py-2 text-xs font-medium transition-colors focus-ring',
            mode === 'clear'
              ? 'border-destructive bg-destructive text-destructive-foreground'
              : 'border-border bg-card text-foreground hover:border-destructive/40 hover:bg-destructive/10',
          ]"
          @click="mode = 'clear'"
        >
          Unlink
        </button>
      </div>

      <div v-if="mode === 'existing'" class="space-y-2">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Find a client</span>
          <div class="relative">
            <input
              v-model="search"
              type="text"
              placeholder="Search by name, email, or phone…"
              autocomplete="off"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <div
              v-if="matches.length > 0 && !picked"
              class="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border-strong bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-8px_rgba(15,23,42,0.16)]"
            >
              <button
                v-for="m in matches"
                :key="m.id"
                type="button"
                class="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                @click="pickMatch(m)"
              >
                <div class="font-medium text-foreground">{{ m.full_name || '(no name)' }}</div>
                <div class="text-xs text-muted-foreground">
                  {{ m.email || m.mobile_phone || `Contact #${m.id}` }}
                </div>
              </button>
            </div>
            <p v-if="searching" class="mt-1 text-xs text-muted-foreground">Searching…</p>
            <p
              v-else-if="search.length >= 2 && matches.length === 0 && !picked"
              class="mt-1 text-xs text-muted-foreground"
            >
              No matches. Switch to <button type="button" class="underline hover:text-foreground" @click="mode = 'create'">New client</button>?
            </p>
          </div>
        </label>
        <div
          v-if="picked"
          class="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success"
        >
          <strong class="font-semibold">Will link: </strong>{{ picked.full_name || `Contact #${picked.id}` }}
          <span v-if="picked.email" class="text-success/80"> · {{ picked.email }}</span>
        </div>
      </div>

      <div v-else-if="mode === 'create'" class="space-y-3">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Full name <span class="text-destructive">*</span></span>
          <input
            v-model="form.full_name"
            type="text"
            maxlength="200"
            placeholder="e.g. Maria Santos"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Email</span>
            <input
              v-model="form.email"
              type="email"
              maxlength="320"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Mobile</span>
            <input
              v-model="form.mobile_phone"
              type="tel"
              maxlength="50"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Notes (optional)</span>
          <textarea
            v-model="form.notes"
            rows="2"
            maxlength="2000"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
      </div>

      <div v-else class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <strong class="font-semibold">Unlink current client.</strong>
        The contact row is preserved — only the deal's buyer link is cleared.
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="btn-secondary"
          :disabled="submitting"
          @click="cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          :class="mode === 'clear' ? 'btn-destructive disabled:opacity-60' : 'btn-primary disabled:opacity-60'"
          :disabled="!canSubmit"
          @click="submit"
        >
          <span v-if="submitting">Saving…</span>
          <span v-else-if="mode === 'create'">Create + link</span>
          <span v-else-if="mode === 'existing'">Link client</span>
          <span v-else>Confirm unlink</span>
        </button>
      </div>
    </template>
  </UiModal>
</template>
