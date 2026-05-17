<script setup lang="ts">
/**
 * Inquiry → Deal + Client conversion wizard.
 *
 * Replaces the bare "Convert to deal" button with a modal that also
 * promotes the inquirer into a CRM contact. Three contact modes:
 *
 *   create   — make a new contact owned by the caller (default; pre-
 *              filled from the inquiry's sender_* fields)
 *   existing — link an already-known contact via search picker
 *   skip     — backwards-compat path; deal exists, no buyer link
 *
 * Submits to POST /api/inquiries/:id/convert-to-deal with the
 * extended { contact: {...} } body. On success, navigates to the
 * new deal detail page.
 *
 * Wizard intentionally lightweight — operator's first beat is "is
 * this person new or known?" then "edit the pre-filled fields if
 * needed". Goal: turn "convert" from 4 manual steps into 1 click.
 */
import { ref, computed, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type ContactMatch = {
  id: number
  full_name: string | null
  email: string | null
  mobile_phone: string | null
}

type Inquiry = {
  id: string
  listing_id: number
  sender_name: string | null
  sender_email: string | null
  sender_phone: string | null
}

const props = defineProps<{
  open: boolean
  inquiry: Inquiry | null
  /** Optional listing label rendered in the subtitle for context. */
  listingLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'converted', payload: { dealId: string; contactId: number | null }): void
}>()

type Mode = 'create' | 'existing' | 'skip'
const mode = ref<Mode>('create')

// Create-mode fields — pre-filled from inquiry sender_* on open.
const form = ref({
  full_name: '',
  email: '',
  mobile_phone: '',
  notes: '',
})

// Existing-mode picker.
const search = ref('')
const searching = ref(false)
const matches = ref<ContactMatch[]>([])
const picked = ref<ContactMatch | null>(null)
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

// Submit state.
const submitting = ref(false)

// Reset + pre-fill on (re-)open.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    mode.value = 'create'
    const i = props.inquiry
    form.value.full_name = (i?.sender_name ?? '').trim()
    form.value.email = (i?.sender_email ?? '').trim()
    form.value.mobile_phone = (i?.sender_phone ?? '').trim()
    form.value.notes = ''
    search.value = ''
    matches.value = []
    picked.value = null
  },
  { immediate: true },
)

// Existing-contact typeahead. /api/contacts already supports search via
// listContacts; we query it directly with a small page size.
async function runSearch() {
  const q = search.value.trim()
  if (q.length < 2) {
    matches.value = []
    return
  }
  searching.value = true
  const seq = ++searchSeq
  try {
    // Direct supabase query — RLS scopes to contacts the caller can see.
    // Avoids round-tripping through a dedicated endpoint for v1.
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
  return true // skip mode always submittable
})

async function submit() {
  if (!props.inquiry || !canSubmit.value) return
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
      body.contact = { mode: 'skip' }
    }

    const res = await $fetch<{ id: string; buyer_contact_id: number | null }>(
      `/api/inquiries/${props.inquiry.id}/convert-to-deal`,
      { method: 'POST', body },
    )
    showToast({
      title:
        mode.value === 'create'
          ? 'Client added and deal created'
          : mode.value === 'existing'
            ? 'Deal created with linked client'
            : 'Deal created',
      icon: 'success',
    })
    emit('converted', { dealId: res.id, contactId: res.buyer_contact_id })
    emit('update:open', false)
    await navigateTo(`/deals/${res.id}`)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Convert failed',
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
    title="Convert inquiry to deal"
    :subtitle="
      listingLabel
        ? `Promote ${inquiry?.sender_name || 'this lead'} into a client and start a deal on ${listingLabel}.`
        : `Promote ${inquiry?.sender_name || 'this lead'} into a client and start a deal.`
    "
    width="md"
    :persistent="submitting"
    @update:open="(v) => { if (!v) cancel() }"
  >
    <!-- Mode selector — segmented control so the choice is obvious -->
    <div class="space-y-3">
      <div role="radiogroup" aria-label="Client mode" class="grid grid-cols-3 gap-2">
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
          :aria-checked="mode === 'skip'"
          :class="[
            'rounded-md border px-3 py-2 text-xs font-medium transition-colors focus-ring',
            mode === 'skip'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:border-border-strong hover:bg-accent',
          ]"
          @click="mode = 'skip'"
        >
          Skip for now
        </button>
      </div>

      <!-- New-client form: pre-filled from inquiry sender_* -->
      <div v-if="mode === 'create'" class="space-y-3">
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
              placeholder="maria@example.com"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Mobile</span>
            <input
              v-model="form.mobile_phone"
              type="tel"
              maxlength="50"
              placeholder="+63 917 …"
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
            placeholder="Anything operationally useful — budget, timeline, decision-maker context."
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <p class="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-muted-foreground">
          Pre-filled from the inquiry submission. Edit any field — the saved contact uses what you submit here.
        </p>
      </div>

      <!-- Existing-client picker -->
      <div v-else-if="mode === 'existing'" class="space-y-2">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Find an existing client</span>
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
          <strong class="font-semibold">Linked: </strong>{{ picked.full_name || `Contact #${picked.id}` }}
          <span v-if="picked.email" class="text-success/80"> · {{ picked.email }}</span>
        </div>
      </div>

      <!-- Skip mode: backwards-compat -->
      <div v-else class="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        <strong class="font-semibold">Heads up:</strong>
        the deal will be created without a linked client. You can add one later from the deal page.
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-between gap-2">
        <p class="text-[11px] text-muted-foreground">
          Inquiry will be marked
          <span class="font-medium text-foreground">in progress</span>.
        </p>
        <div class="flex gap-2">
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
            class="btn-primary disabled:opacity-60"
            :disabled="!canSubmit"
            @click="submit"
          >
            <span v-if="submitting">Converting…</span>
            <span v-else-if="mode === 'create'">Create client + deal</span>
            <span v-else-if="mode === 'existing'">Link client + create deal</span>
            <span v-else>Create deal</span>
          </button>
        </div>
      </div>
    </template>
  </UiModal>
</template>
