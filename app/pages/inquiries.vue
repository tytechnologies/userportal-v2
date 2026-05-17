<script setup lang="ts">
// Inquiries inbox. Lists every inquiry the caller can see (RLS:
// assigned + team + admins per inquiries.read.*). Tab strip at the
// top filters by status; click a row to open a detail drawer with
// the full message + reply context (mailto/tel: links to the
// submitter).
//
// Dashboard widget links to ?status=new; the bell's notification href
// links to ?id=<uuid> which auto-opens that row's drawer.

import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  useInquiries,
  type Inquiry,
  type InquiryStatus,
} from '~/composables/useInquiries'
import { showToast } from '~/helpers/helpers'
import ForwardInquiryModal from '~/components/inquiries/ForwardInquiryModal.vue'
import LogInquiryModal from '~/components/inquiries/LogInquiryModal.vue'
import ConvertInquiryModal from '~/components/inquiries/ConvertInquiryModal.vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiTabBar from '~/components/ui/UiTabBar.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'

const forwardOpen = ref(false)
const forwardTarget = ref<{ inquiryId: string; listingId: number } | null>(null)
function openForward(inquiry: { id: string; listing_id: number }) {
  forwardTarget.value = { inquiryId: inquiry.id, listingId: inquiry.listing_id }
  forwardOpen.value = true
}
function closeForward() {
  forwardOpen.value = false
}
function onForwarded() {
  // Forwarding flips assigned_user_id and the current view may no longer
  // match (e.g. user filtered to "mine"). Re-run the list query so the
  // row's new state is reflected.
  load()
}

// Manual inquiry logging — for phone calls / WhatsApp / walk-ins / referrals.
const logOpen = ref(false)
function onLogged(_inquiry: any) {
  // Day-1 user just logged their first one; flip the empty-state probe
  // and refresh the list so the new row appears immediately.
  hasAnyInquiryEver.value = true
  load()
}

// Convert wizard — replaces the prior bare "Convert to deal" call so
// the operator can promote the inquirer into a CRM contact in the
// same step. The endpoint stays backwards-compatible (skip mode is
// the legacy behavior).
const convertOpen = ref(false)
const convertTarget = ref<Inquiry | null>(null)
function openConvert(inquiry: Inquiry) {
  convertTarget.value = inquiry
  convertOpen.value = true
}
function onConverted(_payload: { dealId: string; contactId: number | null }) {
  // The wizard handles toast + navigation; this hook lets us refresh
  // the list so the converted inquiry's status flips to in_progress
  // when the user navigates back. Cheap reload via the existing
  // load() pathway — the wizard already navigates away, so this
  // mostly exists for the rare case where the navigation fails.
  load()
}

definePageMeta({ layout: 'default' })
useHead({ title: 'Inquiries | Housing Interactive' })

const route = useRoute()
const { listInquiries, updateInquiry } = useInquiries()
const supabase = useSupabaseClient()

type StatusTab = InquiryStatus | 'all'
type Scope = 'mine' | 'all'
const activeStatus = ref<StatusTab>('new')
// Scope toggle — Mine narrows to inquiries assigned to the caller
// (server-side filter via ?mine=true); All falls back to whatever
// the caller's RLS scope allows (own + team for managers, all for
// admin). Default 'mine' matches the inbox mental model: an agent's
// first beat is "what's been routed to me?"
const scope = ref<Scope>('mine')
const inquiries = ref<Inquiry[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 50
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const isUpdating = ref<string | null>(null)

// Detail drawer.
const selectedId = ref<string | null>(null)
const selected = computed(() => inquiries.value.find(i => i.id === selectedId.value) ?? null)

// Listing title hydration so we don't show bare numeric ids.
const listingTitles = ref<Record<number, string>>({})

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const res = await listInquiries({
      page: page.value,
      pageSize,
      status: activeStatus.value === 'all' ? undefined : activeStatus.value,
      mine: scope.value === 'mine',
    })
    inquiries.value = res.data
    total.value = res.total
    hydrateTitles(res.data)
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load inquiries.'
  } finally {
    isLoading.value = false
  }
}

// Day-1 vs filter-narrow detection. The page's `total` is scoped to
// the active status tab, so it can't tell us whether the user has
// ANY inquiries across all statuses. One LIMIT 1 probe answers that
// for the empty-state copy. Re-probed when the user lands on a tab
// that returns 0 — cheap and avoids a stale "no inquiries ever" copy
// after their first inquiry comes in.
const hasAnyInquiryEver = ref<boolean | null>(null)
async function probeAnyInquiry() {
  try {
    const { data } = await (supabase as any)
      .from('inquiries')
      .select('id')
      .limit(1)
    hasAnyInquiryEver.value = (data?.length ?? 0) > 0
  } catch {
    hasAnyInquiryEver.value = null
  }
}

async function hydrateTitles(rows: Inquiry[]) {
  const ids = Array.from(new Set(rows.map(r => r.listing_id)))
    .filter(id => listingTitles.value[id] === undefined)
  if (ids.length === 0) return
  const { data } = await (supabase as any)
    .from('listing_details')
    .select('listing_id, title')
    .in('listing_id', ids)
  for (const row of (data ?? [])) {
    listingTitles.value[row.listing_id] = row.title || `Listing #${row.listing_id}`
  }
}

function listingLabel(i: Inquiry) {
  return listingTitles.value[i.listing_id] ?? `Listing #${i.listing_id}`
}

watch(activeStatus, () => { page.value = 1; load() })
watch(scope, () => { page.value = 1; load() })

// Re-probe the day-1-detector when a load returns 0 — guarantees the
// empty-state copy flips from "you have none" to "this filter is
// narrow" the moment the user's first inquiry lands.
watch(inquiries, (rows) => {
  if (rows.length === 0 && hasAnyInquiryEver.value !== true) probeAnyInquiry()
})

onMounted(async () => {
  // Deep link via ?id=<uuid> — open the row's drawer once the list
  // has loaded. ?status=<x> can also pre-select a tab. ?scope=<x>
  // pre-selects the Mine/All scope (e.g. dashboard widgets link to
  // /inquiries?scope=mine&status=new).
  const queryStatus = route.query.status as string | undefined
  if (queryStatus && ['new', 'in_progress', 'replied', 'closed', 'spam', 'all'].includes(queryStatus)) {
    activeStatus.value = queryStatus as StatusTab
  }
  const queryScope = route.query.scope as string | undefined
  if (queryScope === 'mine' || queryScope === 'all') {
    scope.value = queryScope
  }
  await Promise.all([load(), probeAnyInquiry()])
  const queryId = route.query.id as string | undefined
  if (queryId) selectedId.value = queryId
})

async function setStatus(i: Inquiry, status: InquiryStatus) {
  isUpdating.value = i.id
  try {
    const updated = await updateInquiry(i.id, { status })
    const idx = inquiries.value.findIndex(x => x.id === i.id)
    if (idx >= 0) inquiries.value[idx] = updated
    showToast({ title: `Inquiry marked ${status.replace('_', ' ')}.`, icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to update inquiry.', icon: 'error' })
  } finally {
    isUpdating.value = null
  }
}

type BadgeVariant = 'primary' | 'warning' | 'success' | 'neutral' | 'destructive'
function statusVariant(s: InquiryStatus): BadgeVariant {
  switch (s) {
    case 'new':         return 'primary'
    case 'in_progress': return 'warning'
    case 'replied':     return 'success'
    case 'closed':      return 'neutral'
    case 'spam':        return 'destructive'
  }
}

const STATUS_TABS = [
  { value: 'new',         label: 'New' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'replied',     label: 'Replied' },
  { value: 'closed',      label: 'Closed' },
  { value: 'spam',        label: 'Spam' },
  { value: 'all',         label: 'All' },
] as const

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl" data-tour="inquiries-table">
    <UiPageHeader
      title="Inquiries"
      description="Submissions from the public website on listings you're assigned to."
    >
      <template #actions>
        <UiBadge variant="neutral" size="sm">
          <span class="tabular-nums">{{ total.toLocaleString() }} total</span>
        </UiBadge>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          @click="logOpen = true"
        >
          <span aria-hidden="true">+</span>
          Log inquiry
        </button>
      </template>
    </UiPageHeader>

    <!-- Scope toggle (Mine / All) — sits above the status tabs.
         Mine narrows to assigned_user_id = caller via the server's
         ?mine=true filter. All falls back to whatever the caller's
         RLS scope allows. -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div role="radiogroup" aria-label="Inquiry scope" class="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 p-0.5">
        <button
          type="button"
          role="radio"
          :aria-checked="scope === 'mine'"
          :class="[
            'h-7 rounded-sm px-3 text-xs font-medium transition-colors focus-ring',
            scope === 'mine'
              ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
              : 'text-muted-foreground hover:text-foreground',
          ]"
          @click="scope = 'mine'"
        >
          Mine
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="scope === 'all'"
          :class="[
            'h-7 rounded-sm px-3 text-xs font-medium transition-colors focus-ring',
            scope === 'all'
              ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
              : 'text-muted-foreground hover:text-foreground',
          ]"
          @click="scope = 'all'"
        >
          All visible
        </button>
      </div>
      <p class="text-xs text-muted-foreground">
        <template v-if="scope === 'mine'">Inquiries assigned to you.</template>
        <template v-else>Everything your role allows you to see.</template>
      </p>
    </div>

    <UiTabBar
      v-model="activeStatus"
      :tabs="STATUS_TABS as any"
      variant="underline"
      :underline-full="true"
      aria-label="Inquiry status"
    />

    <!-- Loading: row-shaped skeleton -->
    <UiCard v-if="isLoading" padding="none">
      <div
        v-for="n in 5"
        :key="n"
        class="space-y-1.5 border-b border-border px-4 py-3 last:border-0"
      >
        <div class="flex items-baseline justify-between gap-2">
          <UiSkeleton class="h-3 w-1/3" />
          <UiSkeleton class="h-3 w-12" />
        </div>
        <UiSkeleton class="h-2 w-1/2" />
        <UiSkeleton class="h-2 w-full" />
      </div>
    </UiCard>

    <UiCard
      v-else-if="errorMessage"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-sm text-destructive"
    >
      {{ errorMessage }}
    </UiCard>

    <!-- Day-1 empty state: user has zero inquiries across every status.
         Drives them to the funnel-start (add a listing) since inquiries
         only flow in once a listing is live + discoverable. -->
    <UiCard v-else-if="inquiries.length === 0 && hasAnyInquiryEver === false" padding="lg">
      <div class="mx-auto max-w-md py-6 text-center">
        <h3 class="text-lg font-semibold text-foreground">No inquiries yet</h3>
        <p class="mt-2 text-sm text-muted-foreground">
          Inquiries land here automatically when buyers reach out about your listings.
          Get a listing live to start receiving them.
        </p>
        <div class="mt-5 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <NuxtLink
            to="/listings/new"
            class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Add a listing
            <span aria-hidden="true">→</span>
          </NuxtLink>
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent/40"
            @click="logOpen = true"
          >
            Log a phone-call inquiry
          </button>
        </div>
      </div>
    </UiCard>

    <!-- Filter-narrow empty state: the user has inquiries elsewhere
         but none in the active tab. -->
    <UiCard v-else-if="inquiries.length === 0" padding="none">
      <EmptyState
        variant="success"
        size="cozy"
        title="No inquiries match this filter"
        description="Try the All tab to see every inquiry — or wait for new ones to come in."
      />
    </UiCard>

    <div v-else class="grid gap-4 lg:grid-cols-[1fr_24rem]">
      <!-- List -->
      <UiCard padding="none">
        <ul class="divide-y divide-border">
          <li
            v-for="i in inquiries"
            :key="i.id"
            class="group relative cursor-pointer px-4 py-3 transition-colors duration-150 ease-out hover:bg-accent/40 focus-ring"
            :class="selectedId === i.id ? 'bg-accent/60' : ''"
            tabindex="0"
            @click="selectedId = i.id"
            @keydown.enter.prevent="selectedId = i.id"
            @keydown.space.prevent="selectedId = i.id"
          >
            <span
              v-if="selectedId === i.id"
              class="absolute inset-y-1 left-0 w-0.5 rounded-r bg-primary"
              aria-hidden="true"
            />
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2">
                  <span class="truncate text-sm font-semibold text-foreground">
                    {{ i.sender_name }}
                  </span>
                  <UiBadge :variant="statusVariant(i.status)" size="xs">
                    {{ i.status.replace('_', ' ') }}
                  </UiBadge>
                </p>
                <p class="truncate text-xs text-muted-foreground">
                  On
                  <NuxtLink
                    :to="`/listings/${i.listing_id}`"
                    class="font-medium text-primary hover:underline"
                    @click.stop
                  >
                    {{ listingLabel(i) }}
                  </NuxtLink>
                </p>
                <p class="mt-1 line-clamp-2 text-sm text-foreground/80">
                  {{ i.message }}
                </p>
              </div>
              <span class="shrink-0 text-xs text-muted-foreground">
                {{ relativeTime(i.created_at) }}
              </span>
            </div>
          </li>
        </ul>
      </UiCard>

      <!-- Detail aside -->
      <UiCard padding="none" class="self-start">
        <EmptyState
          v-if="!selected"
          variant="neutral"
          size="cozy"
          title="Select an inquiry"
          description="Click any row on the left to view the full message and reply context."
        />
        <div v-else class="space-y-4 p-5">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold text-foreground">
                {{ selected.sender_name }}
              </p>
              <p class="text-xs text-muted-foreground">
                {{ formatDate(selected.created_at) }}
              </p>
            </div>
            <UiBadge :variant="statusVariant(selected.status)" size="xs">
              {{ selected.status.replace('_', ' ') }}
            </UiBadge>
          </div>

          <p class="text-xs text-muted-foreground">
            Listing:
            <NuxtLink
              :to="`/listings/${selected.listing_id}`"
              class="font-medium text-primary hover:underline"
            >
              {{ listingLabel(selected) }}
            </NuxtLink>
          </p>

          <div class="rounded-lg border border-border bg-background p-3 text-sm text-foreground">
            <p class="whitespace-pre-wrap break-words">{{ selected.message }}</p>
          </div>

          <div class="space-y-1 text-sm">
            <p v-if="selected.sender_email">
              <span class="text-xs text-muted-foreground">Email: </span>
              <a
                :href="`mailto:${selected.sender_email}`"
                class="text-primary hover:underline"
              >
                {{ selected.sender_email }}
              </a>
            </p>
            <p v-if="selected.sender_phone">
              <span class="text-xs text-muted-foreground">Phone: </span>
              <a
                :href="`tel:${selected.sender_phone}`"
                class="text-primary hover:underline"
              >
                {{ selected.sender_phone }}
              </a>
            </p>
          </div>

          <div class="flex flex-wrap gap-2 border-t border-border pt-3">
            <!-- Status-progression actions first -->
            <button
              v-if="selected.status !== 'in_progress'"
              class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isUpdating === selected.id"
              @click="setStatus(selected, 'in_progress')"
            >
              In progress
            </button>
            <button
              v-if="selected.status !== 'replied'"
              class="rounded-lg bg-success px-3 py-1.5 text-xs font-semibold text-success-foreground transition-colors duration-150 ease-out hover:bg-success/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isUpdating === selected.id"
              @click="setStatus(selected, 'replied')"
            >
              Mark replied
            </button>
            <button
              v-if="selected.status !== 'closed'"
              class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isUpdating === selected.id"
              @click="setStatus(selected, 'closed')"
            >
              Close
            </button>

            <!-- Secondary actions -->
            <button
              v-if="selected"
              class="rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors duration-150 ease-out hover:bg-primary/15 focus-ring disabled:opacity-60"
              @click="openForward(selected)"
            >
              Forward
            </button>
            <button
              v-if="selected && selected.status !== 'spam' && selected.status !== 'closed'"
              class="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              @click="openConvert(selected)"
            >
              Convert to deal
            </button>

            <!-- Destructive, right-aligned -->
            <button
              v-if="selected.status !== 'spam'"
              class="ml-auto rounded-lg border border-destructive/30 bg-card px-3 py-1.5 text-xs font-medium text-destructive transition-colors duration-150 ease-out hover:bg-destructive/10 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isUpdating === selected.id"
              @click="setStatus(selected, 'spam')"
            >
              Mark spam
            </button>
          </div>
        </div>
      </UiCard>
    </div>

    <ForwardInquiryModal
      :open="forwardOpen"
      :inquiry-id="forwardTarget?.inquiryId ?? null"
      :listing-id="forwardTarget?.listingId ?? null"
      @close="closeForward"
      @forwarded="onForwarded"
    />

    <LogInquiryModal
      :open="logOpen"
      @update:open="logOpen = $event"
      @created="onLogged"
    />

    <ConvertInquiryModal
      :open="convertOpen"
      :inquiry="convertTarget"
      :listing-label="convertTarget ? listingLabel(convertTarget) : ''"
      @update:open="convertOpen = $event"
      @converted="onConverted"
    />
  </AdminPageShell>
</template>
