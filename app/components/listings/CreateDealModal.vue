<script setup lang="ts">
/**
 * Create-deal-from-listing modal — the "walked-in buyer" surface.
 *
 * Distinct from ConvertInquiryModal in two ways:
 *   1. There's no source inquiry, so the create-mode form starts
 *      blank instead of pre-filling from sender_*.
 *   2. The "skip" option labels as "No buyer yet" — for a deal
 *      created proactively (e.g. broker walking a list of cold
 *      prospects through this listing) it's a meaningful state,
 *      not just a backwards-compat escape hatch.
 *
 * Shares the three-mode contact pattern (create/existing/skip) and
 * the same server endpoint shape — POST /api/deals now accepts the
 * `contact` discriminated union, so this modal hits exactly one
 * round-trip per submit.
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
  /** Listing the deal will be created against — required, drives the
   *  POST body's listing_id and the title shown in the subtitle. */
  listingId: number | null
  /** Optional listing label rendered in the subtitle for context. */
  listingLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'created', payload: { dealId: string; contactId: number | null }): void
}>()

type Mode = 'create' | 'existing' | 'skip'
const mode = ref<Mode>('create')

// Create-mode fields. Unlike the inquiry modal there's no pre-fill —
// the broker is starting from a blank buyer.
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

const submitting = ref(false)

// Reset on open. Default to 'create' — the broker invoking this from
// a listing detail almost always has a buyer in front of them.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    mode.value = 'create'
    form.value = { full_name: '', email: '', mobile_phone: '', notes: '' }
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
  if (!props.listingId) return false
  if (mode.value === 'create') return form.value.full_name.trim().length > 0
  if (mode.value === 'existing') return !!picked.value
  return true
})

async function submit() {
  if (!props.listingId || !canSubmit.value) return
  submitting.value = true
  try {
    const body: Record<string, unknown> = {
      listing_id: props.listingId,
    }
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
      '/api/deals',
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
    emit('created', { dealId: res.id, contactId: res.buyer_contact_id })
    emit('update:open', false)
    await navigateTo(`/deals/${res.id}`)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not create deal',
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
    title="Start a deal on this listing"
    :subtitle="
      listingLabel
        ? `Track a buyer through this listing — ${listingLabel}.`
        : 'Track a buyer through this listing.'
    "
    width="md"
    :persistent="submitting"
    @update:open="(v) => { if (!v) cancel() }"
  >
    <div class="space-y-3">
      <!-- Mode selector -->
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
          No buyer yet
        </button>
      </div>

      <!-- New-client form -->
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
                class="block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-accent focus-ring last:border-b-0"
                @click="pickMatch(m)"
              >
                <span class="font-semibold text-foreground">
                  {{ m.full_name || m.email || `Contact #${m.id}` }}
                </span>
                <span v-if="m.email || m.mobile_phone" class="ml-1 text-muted-foreground">
                  ({{ [m.email, m.mobile_phone].filter(Boolean).join(' · ') }})
                </span>
              </button>
            </div>
            <p
              v-else-if="searching"
              class="mt-1 text-[11px] text-muted-foreground"
            >
              Searching…
            </p>
            <p
              v-else-if="search.trim().length >= 2 && matches.length === 0 && !picked"
              class="mt-1 text-[11px] text-muted-foreground"
            >
              No matches. Try a different name, email, or phone — or add as new.
            </p>
          </div>
        </label>
        <p
          v-if="picked"
          class="rounded-md border border-success/40 bg-success/5 px-3 py-2 text-[11px] text-foreground"
        >
          Selected: <span class="font-semibold">{{ picked.full_name || picked.email }}</span>
        </p>
      </div>

      <!-- Skip mode: short note explaining the state -->
      <p
        v-else
        class="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground"
      >
        The deal will be created with no buyer attached. You can link a
        client later from the deal detail page.
      </p>
    </div>

    <template #footer>
      <button
        type="button"
        class="rounded-md border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-ring"
        :disabled="submitting"
        @click="cancel"
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!canSubmit"
        @click="submit"
      >
        {{ submitting ? 'Creating…' : 'Create deal' }}
      </button>
    </template>
  </UiModal>
</template>
