<script setup lang="ts">
// Reusable listing-detail block. Used both on the standalone
// /listings/:id page and inside the ListingPreviewModal so the
// content stays in lockstep without copy-paste drift.
//
// Responsibilities:
//   - Fetch the listing_details row for the id.
//   - Fetch the gallery image URLs via /api/listings/get-gallery-images
//     (server-signed S3 URLs — same path the legacy /listing.vue uses).
//   - Render: header card, image carousel, key fields, description,
//     CRM panels (tasks + notes), activity timeline.
//   - Show + open the share modal.
//
// `compact` prop hides the activity timeline + tasks/notes panels for
// the modal preview (which is space-constrained); the standalone page
// renders everything.

import { computed, onMounted, ref, watch } from 'vue'
import { useTimeline, type TimelineEvent } from '~/composables/useTimeline'
import { formatMoney } from '~/utils'
import TasksPanel from '~/components/crm/TasksPanel.vue'
import NotesPanel from '~/components/crm/NotesPanel.vue'
import DocumentsPanel from '~/components/crm/DocumentsPanel.vue'
import ShareListingModal from '~/components/crm/ShareListingModal.vue'
import TimelineEntry from '~/components/timeline/TimelineEntry.vue'
import ListingSharesPanel from '~/components/listings/ListingSharesPanel.vue'
import ListingVerificationRequest from '~/components/listings/ListingVerificationRequest.vue'
import ListingHistoryDrawer from '~/components/listings/ListingHistoryDrawer.vue'

const props = defineProps<{
  listingId: number
  /** Modal preview hides timeline + panels for space. */
  compact?: boolean
}>()

// Loose type — listing_details is a wide MV whose exact column shape
// has shifted over time; rather than pin specific columns and 500 when
// one gets renamed (e.g. `street` was renamed to `street_address`),
// we read `select('*')` and render defensively (every field optional,
// every renderer null-tolerant).
type ListingRow = {
  listing_id: number
  title?: string | null
  is_online?: boolean | null
  for_sale?: boolean | null
  for_rent?: boolean | null
  sale_price?: number | null
  rent_price?: number | null
  property_category?: string | null
  property_type?: string | null
  city_name?: string | null
  property_name?: string | null
  street_address?: string | null
  unit_number?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  total_floor_area?: number | null
  description?: string | null
  created_at?: string | null
  updated_at?: string | null
  created_by?: string | null
}

const supabase = useSupabaseClient()
const me = useSupabaseUser()
const { fetchListingTimeline } = useTimeline()

const listing = ref<ListingRow | null>(null)
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const notFound = ref(false)

const timeline = ref<TimelineEvent[]>([])
const timelineLoading = ref(false)

const galleryUrls = ref<string[]>([])
const galleryLoading = ref(false)
const activeImageIndex = ref(0)

const shareModalOpen = ref(false)
// History drawer renders the same field-level diffs ListingsTableRow
// surfaces — listing.updated rows from the listings_audit_diff
// trigger, with from→to value pairs per changed column. The inline
// timeline below shows the verbs but not the diffs.
const historyDrawerOpen = ref(false)
// Owner check drives the "Revoke" button visibility on the shares
// panel + gates the verification-request UX. Non-owners see only a
// read-only shares list (RLS-filtered to their own row anyway).
const isOwner = computed(() =>
  Boolean(
    me.value?.id
      && listing.value?.created_by
      && me.value.id === listing.value.created_by,
  ),
)

async function load() {
  if (!Number.isFinite(props.listingId) || props.listingId <= 0) {
    notFound.value = true
    isLoading.value = false
    return
  }
  isLoading.value = true
  errorMessage.value = null
  notFound.value = false
  try {
    // select('*') so we don't hard-fail on column renames in the wide
    // MV. Defensive rendering below tolerates any field being missing.
    const { data, error } = await (supabase as any)
      .from('listing_details')
      .select('*')
      .eq('listing_id', props.listingId)
      .maybeSingle()
    if (error) throw error
    if (!data) {
      notFound.value = true
      return
    }
    listing.value = data as ListingRow
    // Kick off image + timeline fetches in parallel; they don't block
    // the header card paint.
    void loadGallery(props.listingId)
    if (!props.compact) void loadTimeline(props.listingId)
  } catch (err: any) {
    errorMessage.value = err?.message || 'Failed to load listing'
  } finally {
    isLoading.value = false
  }
}

async function loadGallery(listingId: number) {
  galleryLoading.value = true
  galleryUrls.value = []
  activeImageIndex.value = 0
  try {
    // Same endpoint the legacy /listing.vue + RowInfoCard use. Returns
    // signed S3 URLs for the 635x423 sized variants.
    const res = await $fetch<{ success: boolean; data: string[] }>(
      '/api/listings/get-gallery-images',
      { method: 'POST', body: { listingId } },
    )
    if (res?.success && Array.isArray(res.data)) {
      galleryUrls.value = res.data
    }
  } catch {
    // Non-fatal — page renders without images.
  } finally {
    galleryLoading.value = false
  }
}

async function loadTimeline(listingId: number) {
  timelineLoading.value = true
  try {
    timeline.value = await fetchListingTimeline(listingId)
  } finally {
    timelineLoading.value = false
  }
}

watch(() => props.listingId, () => load())
onMounted(load)

function priceLabel(l: ListingRow) {
  if (l.for_sale && l.sale_price) return formatMoney(l.sale_price, true)
  if (l.for_rent && l.rent_price) return `${formatMoney(l.rent_price, true)}/mo`
  return '—'
}

function tagLabel(l: ListingRow) {
  const parts: string[] = []
  if (l.for_sale) parts.push('For Sale')
  if (l.for_rent) parts.push('For Rent')
  return parts.join(' • ') || '—'
}

function nextImage() {
  if (galleryUrls.value.length === 0) return
  activeImageIndex.value = (activeImageIndex.value + 1) % galleryUrls.value.length
}
function prevImage() {
  if (galleryUrls.value.length === 0) return
  activeImageIndex.value =
    (activeImageIndex.value - 1 + galleryUrls.value.length) % galleryUrls.value.length
}
</script>

<template>
  <div>
    <div v-if="isLoading" class="rounded-xl border border-border bg-background p-8 text-center text-sm text-muted-foreground/70">
      Loading…
    </div>

    <div
      v-else-if="notFound"
      class="rounded-xl border border-border bg-background p-8 text-center"
    >
      <p class="text-sm font-semibold text-foreground">Listing not found</p>
      <p class="mt-1 text-xs text-muted-foreground">
        It may have been deleted, or your role doesn't have access.
      </p>
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </div>

    <template v-else-if="listing">
      <!-- Image gallery -->
      <section class="mb-4 overflow-hidden rounded-xl border border-border bg-muted/50">
        <div v-if="galleryLoading" class="flex h-64 items-center justify-center text-sm text-muted-foreground/70">
          Loading photos…
        </div>
        <div v-else-if="galleryUrls.length === 0" class="flex h-48 items-center justify-center text-sm text-muted-foreground/70">
          No photos available.
        </div>
        <div v-else class="relative">
          <img
            :src="galleryUrls[activeImageIndex]"
            :alt="listing.title || 'Listing photo'"
            class="h-64 w-full object-cover sm:h-96"
          />
          <button
            v-if="galleryUrls.length > 1"
            type="button"
            class="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-foreground/50 px-3 py-2 text-white hover:bg-foreground/55"
            aria-label="Previous photo"
            @click="prevImage"
          >
            ‹
          </button>
          <button
            v-if="galleryUrls.length > 1"
            type="button"
            class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-foreground/50 px-3 py-2 text-white hover:bg-foreground/55"
            aria-label="Next photo"
            @click="nextImage"
          >
            ›
          </button>
          <span
            v-if="galleryUrls.length > 1"
            class="absolute bottom-2 right-3 rounded-full bg-foreground/50 px-2 py-0.5 text-xs text-white"
          >
            {{ activeImageIndex + 1 }} / {{ galleryUrls.length }}
          </span>
        </div>

        <!-- Thumbnail strip — only when multiple photos. Click jumps. -->
        <div
          v-if="galleryUrls.length > 1"
          class="flex gap-1 overflow-x-auto bg-card p-2"
        >
          <button
            v-for="(url, i) in galleryUrls"
            :key="i"
            type="button"
            class="h-12 w-16 shrink-0 overflow-hidden rounded border-2 transition-colors"
            :class="activeImageIndex === i ? 'border-primary' : 'border-transparent hover:border-border'"
            :aria-label="`View photo ${i + 1}`"
            @click="activeImageIndex = i"
          >
            <img :src="url" :alt="`Photo ${i + 1}`" class="h-full w-full object-cover" />
          </button>
        </div>
      </section>

      <!-- Header card -->
      <section class="rounded-xl border border-border bg-background p-5 shadow-sm">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
              {{ listing.property_category }} · {{ listing.property_type || 'Listing' }}
            </p>
            <h2 class="mt-1 text-xl font-bold text-foreground">
              {{ listing.title || `Listing #${listing.listing_id}` }}
            </h2>
            <p class="mt-1 text-sm text-muted-foreground">
              <span v-if="listing.unit_number">{{ listing.unit_number }} </span>
              <span v-if="listing.street_address">{{ listing.street_address }}</span>
              <span v-if="listing.city_name"> · {{ listing.city_name }}</span>
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span
              class="rounded-full px-2 py-0.5 text-xs font-medium"
              :class="listing.is_online ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'"
            >
              {{ listing.is_online ? 'Online' : 'Offline' }}
            </span>
            <NuxtLink
              :to="{ path: '/document-drafts/new', query: { listing_id: listing.listing_id } }"
              class="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
              title="Create a new document draft pre-linked to this listing"
            >
              + Document
            </NuxtLink>
            <button
              type="button"
              class="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
              :title="`See every change made to listing #${listing.listing_id}`"
              @click="historyDrawerOpen = true"
            >
              ⏱ History
            </button>
            <NuxtLink
              :to="`/listings/${listing.listing_id}/edit`"
              class="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
              title="Edit this listing in the guided wizard"
            >
              ✎ Edit
            </NuxtLink>
            <button
              class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
              @click="shareModalOpen = true"
            >
              Share
            </button>
          </div>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <p class="text-xs uppercase tracking-wide text-muted-foreground/70">Price</p>
            <p class="mt-1 font-semibold text-foreground">{{ priceLabel(listing) }}</p>
          </div>
          <div>
            <p class="text-xs uppercase tracking-wide text-muted-foreground/70">Status</p>
            <p class="mt-1 font-semibold text-foreground">{{ tagLabel(listing) }}</p>
          </div>
          <div>
            <p class="text-xs uppercase tracking-wide text-muted-foreground/70">Bedrooms</p>
            <p class="mt-1 font-semibold text-foreground">{{ listing.bedrooms ?? '—' }}</p>
          </div>
          <div>
            <p class="text-xs uppercase tracking-wide text-muted-foreground/70">Bathrooms</p>
            <p class="mt-1 font-semibold text-foreground">{{ listing.bathrooms ?? '—' }}</p>
          </div>
        </div>

        <div v-if="listing.description" class="mt-4 border-t border-border pt-4">
          <p class="whitespace-pre-wrap text-sm text-foreground">{{ listing.description }}</p>
        </div>
      </section>

      <!-- Compact mode (modal preview) skips panels + timeline; the
           "Open full page" link in the modal footer takes the user to
           the standalone /listings/:id route. -->
      <div v-if="!compact" class="mt-4 grid gap-4 lg:grid-cols-2">
        <!-- Trust + collaboration panels at the top of the work
             surface. ListingVerificationRequest reads its own state
             via RLS-scoped query and reflects pending/approved/
             rejected automatically. ListingSharesPanel honors RLS
             too — non-owners see only their own share row, owners
             see every share. -->
        <section class="rounded-xl border border-border bg-background p-3 shadow-sm">
          <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Verification
          </p>
          <ListingVerificationRequest :listing-id="listing.listing_id" />
        </section>
        <ListingSharesPanel
          :listing-id="listing.listing_id"
          :is-owner="isOwner"
        />

        <TasksPanel :listing-id="listing.listing_id" />
        <NotesPanel :listing-id="listing.listing_id" />
        <DocumentsPanel :listing-id="listing.listing_id" class="lg:col-span-2" />

        <section class="rounded-xl border border-border bg-background shadow-sm lg:col-span-2">
          <header class="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 class="text-sm font-semibold text-foreground">Activity</h3>
            <span v-if="!timelineLoading" class="text-xs text-muted-foreground/70">
              {{ timeline.length }}
            </span>
          </header>

          <div v-if="timelineLoading" class="space-y-3 p-4">
            <div v-for="n in 3" :key="n" class="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>

          <div
            v-else-if="timeline.length === 0"
            class="px-4 py-10 text-center text-sm text-muted-foreground"
          >
            No activity recorded yet.
          </div>

          <ol v-else class="relative border-l border-border px-4 py-4">
            <TimelineEntry
              v-for="event in timeline"
              :key="event.id"
              :event="event"
            />
          </ol>
        </section>
      </div>

      <ShareListingModal
        :open="shareModalOpen"
        :listing-id="listing.listing_id"
        :listing-title="listing.title"
        @close="shareModalOpen = false"
      />

      <ListingHistoryDrawer
        :open="historyDrawerOpen"
        :listing-id="listing.listing_id"
        @close="historyDrawerOpen = false"
      />
    </template>
  </div>
</template>
