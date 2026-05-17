<script setup lang="ts">
/**
 * Log a manually-received inquiry — phone, WhatsApp, walk-in, or
 * referral leads agents collect outside the website. POSTs to
 * /api/inquiries (NOT /api/public/inquiries which is for the public
 * website only).
 *
 * Listing picker is a typeahead against /api/listings?search=…. The
 * picked listing's `created_by` becomes the assigned_user_id on the
 * server side (matches the public endpoint's snapshot semantics).
 */
import { ref, computed, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'created', inquiry: any): void
}>()

type ListingOption = {
  id: number
  listing_title: string | null
  building_name?: string | null
}

const form = ref({
  listing: null as ListingOption | null,
  sender_name: '',
  sender_email: '',
  sender_phone: '',
  message: '',
  channel: 'phone' as 'phone' | 'whatsapp' | 'walk_in' | 'referral' | 'manual',
})

const search = ref('')
const searching = ref(false)
const results = ref<ListingOption[]>([])
const showResults = ref(false)
let searchSeq = 0

async function runSearch() {
  const q = search.value.trim()
  if (q.length < 2) {
    results.value = []
    return
  }
  searching.value = true
  const seq = ++searchSeq
  try {
    const res = await $fetch<{ data?: ListingOption[]; items?: ListingOption[] }>(
      '/api/listings',
      { query: { search: q, pageSize: 8, page: 1 } },
    )
    if (seq !== searchSeq) return // discarded — newer request fired
    results.value = (res.data ?? res.items ?? []) as ListingOption[]
    showResults.value = true
  } catch {
    if (seq === searchSeq) results.value = []
  } finally {
    if (seq === searchSeq) searching.value = false
  }
}

let typeTimer: ReturnType<typeof setTimeout> | null = null
watch(search, (v) => {
  if (typeTimer) clearTimeout(typeTimer)
  if (!v.trim()) {
    results.value = []
    showResults.value = false
    return
  }
  typeTimer = setTimeout(runSearch, 220)
})

function pickListing(l: ListingOption) {
  form.value.listing = l
  search.value = l.listing_title ?? `Listing #${l.id}`
  showResults.value = false
}

function clearListing() {
  form.value.listing = null
  search.value = ''
  results.value = []
  showResults.value = false
}

const validEmail = computed(() => {
  const e = form.value.sender_email.trim()
  return !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
})
const hasContact = computed(
  () => !!(form.value.sender_email.trim() || form.value.sender_phone.trim()),
)
const canSubmit = computed(
  () =>
    !!form.value.listing &&
    form.value.sender_name.trim().length >= 1 &&
    form.value.message.trim().length >= 1 &&
    validEmail.value &&
    hasContact.value &&
    !submitting.value,
)

const submitting = ref(false)
const formError = ref<string | null>(null)

async function submit() {
  if (!canSubmit.value || !form.value.listing) return
  submitting.value = true
  formError.value = null
  try {
    const res = await $fetch<{ inquiry: any }>('/api/inquiries', {
      method: 'POST',
      body: {
        listing_id:   form.value.listing.id,
        sender_name:  form.value.sender_name.trim(),
        sender_email: form.value.sender_email.trim() || null,
        sender_phone: form.value.sender_phone.trim() || null,
        message:      form.value.message.trim(),
        channel:      form.value.channel,
      },
    })
    showToast({ title: 'Inquiry logged.', icon: 'success' })
    emit('created', res.inquiry)
    reset()
    emit('update:open', false)
  } catch (err: any) {
    const status = err?.statusCode ?? err?.response?.status
    const msg    = err?.statusMessage ?? err?.data?.statusMessage ?? err?.message ?? 'Could not log inquiry'
    if (status === 403) {
      formError.value = 'You can\'t log inquiries for this listing\'s team.'
    } else {
      formError.value = msg
    }
  } finally {
    submitting.value = false
  }
}

function reset() {
  form.value = {
    listing: null,
    sender_name: '',
    sender_email: '',
    sender_phone: '',
    message: '',
    channel: 'phone',
  }
  search.value = ''
  results.value = []
  showResults.value = false
}

function close() {
  if (submitting.value) return
  emit('update:open', false)
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 p-0 sm:items-center sm:p-4"
    @click.self="close"
  >
    <div class="w-full max-w-lg rounded-t-2xl border border-border bg-card text-card-foreground shadow-xl sm:rounded-lg">
      <header class="flex items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <h2 class="text-lg font-semibold text-foreground">Log inquiry</h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            For phone calls, WhatsApp, walk-ins, or referrals — leads you got outside the public site.
          </p>
        </div>
        <button
          type="button"
          class="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Close"
          @click="close"
        >
          ✕
        </button>
      </header>

      <form class="space-y-4 p-5" @submit.prevent="submit">
        <!-- Listing picker -->
        <div class="relative">
          <label for="li-listing" class="block text-sm font-medium text-foreground">Listing</label>
          <div class="mt-1.5 flex items-stretch gap-2">
            <input
              id="li-listing"
              v-model="search"
              type="text"
              autocomplete="off"
              placeholder="Search by title, building, location…"
              class="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              @focus="showResults = results.length > 0"
              @input="form.listing = null"
            />
            <button
              v-if="form.listing || search"
              type="button"
              class="flex-shrink-0 rounded-lg border border-border px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              @click="clearListing"
            >
              Clear
            </button>
          </div>
          <ul
            v-if="showResults && results.length > 0"
            class="absolute left-0 right-0 z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
          >
            <li v-for="r in results" :key="r.id">
              <button
                type="button"
                class="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                @click="pickListing(r)"
              >
                <span class="block truncate font-medium">{{ r.listing_title || `Listing #${r.id}` }}</span>
                <span class="block text-xs text-muted-foreground">#{{ r.id }}</span>
              </button>
            </li>
          </ul>
          <p v-if="searching" class="mt-1 text-xs text-muted-foreground">Searching…</p>
          <p v-else-if="form.listing" class="mt-1 text-xs text-success">
            ✓ Selected: {{ form.listing.listing_title || `Listing #${form.listing.id}` }}
          </p>
          <p v-else-if="!searching && !form.listing && search.length >= 2 && results.length === 0" class="mt-1 text-xs text-muted-foreground">
            No matching listings.
          </p>
        </div>

        <!-- Channel + sender name -->
        <div class="grid gap-4 sm:grid-cols-[auto_1fr]">
          <div>
            <label for="li-channel" class="block text-sm font-medium text-foreground">Channel</label>
            <select
              id="li-channel"
              v-model="form.channel"
              class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
            >
              <option value="phone">Phone</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="walk_in">Walk-in</option>
              <option value="referral">Referral</option>
              <option value="manual">Other</option>
            </select>
          </div>
          <div>
            <label for="li-name" class="block text-sm font-medium text-foreground">Sender name</label>
            <input
              id="li-name"
              v-model="form.sender_name"
              type="text"
              required
              maxlength="200"
              placeholder="Maria Santos"
              class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <!-- Email + phone -->
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for="li-email" class="block text-sm font-medium text-foreground">Email</label>
            <input
              id="li-email"
              v-model="form.sender_email"
              type="email"
              maxlength="320"
              placeholder="optional"
              class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label for="li-phone" class="block text-sm font-medium text-foreground">Phone</label>
            <input
              id="li-phone"
              v-model="form.sender_phone"
              type="tel"
              maxlength="40"
              placeholder="+63 917 …"
              class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
        <p v-if="!hasContact && (form.sender_email || form.sender_phone || form.sender_name)" class="-mt-2 text-xs text-muted-foreground">
          Provide at least one of email or phone so the agent can reply.
        </p>

        <!-- Message -->
        <div>
          <label for="li-message" class="block text-sm font-medium text-foreground">Message / notes</label>
          <textarea
            id="li-message"
            v-model="form.message"
            rows="4"
            required
            maxlength="5000"
            placeholder="What did they ask about? Budget, timeline, preferred contact times…"
            class="mt-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <p v-if="formError" class="text-xs text-destructive">{{ formError }}</p>

        <div class="flex items-center justify-end gap-2 border-t border-border pt-4 -mx-5 -mb-5 px-5 pb-5">
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent/40"
            @click="close"
          >
            Cancel
          </button>
          <button
            type="submit"
            :disabled="!canSubmit"
            class="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span v-if="submitting">Logging…</span>
            <span v-else>Log inquiry</span>
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
