<template>
  <div class="flex flex-col gap-2 p-4 h-[16vw]">
    <!-- Sidebar Header -->
    <div
      class="flex justify-between items-center border-b border-border pb-2"
    >
      <span class="text-[1.2em] text-foreground font-bold">Listing Details</span>
      <div
        class="cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 h-[1.5vw] w-[1.5vw] hover:bg-primary/10 mr-2"
        :class="{ 'bg-primary/10': listingDetailsSidebarOpen }"
        @click="toggleSidebarListingDetails"
      >
        <font-awesome-icon
          icon="close"
          class="text-gray-350 group-hover:text-primary"
          :class="{ 'text-primary': listingDetailsSidebarOpen }"
          size="lg"
        />
      </div>
    </div>
    <!-- Listing Image -->
    <div
      class="cursor-pointer hover:opacity-60 transition duration-300 ease-in-out relative"
    >
      <div
        v-if="!imageLoading && thumbnail !== '/img/hi_logo.svg'"
        class="absolute top-0 left-0 w-full h-full hover:opacity-[0.8] transition-opacity duration-300 cursor-pointer bg-muted-foreground opacity-[0] flex justify-center items-center"
        @click="toggleImageGallery"
      >
        <span class="text-lg font-bold text-white">See picture</span>
      </div>
      <img
        :src="thumbnail ? thumbnail : '/img/hi_logo.svg'"
        alt="Listing Image"
        class="w-full sm:h-[16vw] h-96 rounded-lg"
      />
    </div>
    <!-- Listing Main Details -->
    <div class="text-foreground">
      <div class="flex items-center justify-between relative">
        <span class="font-bold text-[1.2em]">
          {{
            props.selectedListingDetails
              ? props.selectedListingDetails.listing_data.title
              : ''
          }}
        </span>
        <div
          class="cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 h-[2vw] w-[2vw] hover:bg-primary/10 mr-2"
          :class="{ 'bg-primary/10': optionsMenuOpen }"
          @click="toggleOptionsMenu"
        >
          <font-awesome-icon
            :icon="faEllipsisVertical"
            class="text-gray-350 group-hover:text-primary"
            :class="{ 'text-primary': optionsMenuOpen }"
            size="lg"
          />
        </div>
        <!-- options menu -->
        <div
          id="options-menu"
          class="absolute right-[2vw] top-[2vw] w-[5vw] bg-card rounded-md shadow-md p-2"
          :class="{ hidden: !optionsMenuOpen }"
        >
          <div class="flex flex-col gap-2">
            <span
              class="text-black text-[.9em] cursor-pointer hover:text-primary"
              @click="showUpdateListing"
              >Edit</span
            >
            <span
              class="text-black text-[.9em] cursor-pointer hover:text-primary"
              @click="cloneSelectedListing"
              >Clone</span
            >
            <!-- <span
              @click="archiveListing"
              v-if="props.selectedListingDetails?.listing_data.is_online"
              class="text-black text-[.9em] cursor-pointer hover:text-primary"
              >Archive
            </span> -->
            <!-- <span
              @click="unarchiveListing"
              v-else
              class="text-black text-[.9em] cursor-pointer hover:text-primary"
              >Unarchive</span
            > -->
            <span
              v-if="canDelete"
              @click="deleteListing"
              class="text-black text-[.9em] cursor-pointer hover:text-primary"
              >Delete</span
            >
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span
          class="min-w-[5vw] font-semibold text-[.9em] flex items-center gap-2 text-muted-foreground"
        >
          ID:
          {{
            props.selectedListingDetails
              ? props.selectedListingDetails.listing_data.listing_id
              : ''
          }}
        </span>
        <span
          v-if="props.selectedListingDetails?.listing_data.is_online"
          class="flex items-center gap-2"
        >
          <div class="h-4 w-4 rounded-md bg-success"></div>
          <span class="text-[.9em] text-muted-foreground font-semibold">Online</span>
        </span>
        <span v-else class="flex items-center gap-2">
          <div class="h-4 w-4 rounded-md bg-muted/500"></div>
          <span class="text-[.9em] text-muted-foreground font-semibold">Archived</span>
        </span>
      </div>
    </div>
    <!-- Listing Details -->
    <div class="flex flex-col gap-2 px-[5px] mt-5">
      <div
        v-for="listingDetail of listingDetailsData"
        :key="listingDetail.label"
        class="flex flex-col grid grid-cols-2 gap-2"
      >
        <span class="font-semibold text-[.9em]">
          {{ listingDetail.label }}
        </span>
        <span class="text-[.9em] text-muted-foreground font-semibold">
          {{ listingDetail.value }}
        </span>
      </div>
      <!-- Phase 4: ownership attribution. Admins/managers will commonly
           see rows owned by other users; surface that explicitly so it's
           obvious who's responsible for any given listing. -->
      <div class="flex flex-col grid grid-cols-2 gap-2">
        <span class="font-semibold text-[.9em]">Owned by</span>
        <span class="text-[.9em] text-muted-foreground font-semibold">
          {{ ownerName ?? 'Unassigned' }}
        </span>
      </div>
    </div>
    <!-- View Listing + Start a Deal action row -->
    <div class="flex justify-end gap-2 my-2 flex-wrap">
      <!-- "Start a deal" — quick-create flow for a walked-in buyer.
           Spawns a deal scoped to this listing with the broker as
           buyer_agent. Available regardless of online status because
           a deal can be tracked even if the listing isn't published. -->
      <button
        type="button"
        class="rounded-md border border-border bg-card px-3 py-2 text-[.9em] font-semibold text-foreground transition-colors hover:bg-accent focus-ring"
        @click="openCreateDeal"
      >
        Start a deal
      </button>
      <button
        @click="isOnline ? navigateToPostedListing() : null"
        :class="[
          'rounded-md px-[2vw] py-2 font-semibold text-[.9em]',
          isOnline
            ? 'bg-primary text-primary-foreground'
            : 'bg-primary/50 text-primary-foreground cursor-not-allowed',
        ]"
      >
        View Listing
      </button>
    </div>
    <p v-if="!isOnline" class="text-destructive text-[.9em] text-right">
      Listing is not online so it cannot be viewed.
    </p>

    <!-- Quick-create deal modal — listing pre-set, three-mode contact
         picker (create / existing / skip). On success, navigates to
         the new deal detail page. -->
    <CreateDealModal
      :open="createDealOpen"
      :listing-id="
        props.selectedListingDetails?.listing_data?.listing_id ?? null
      "
      :listing-label="
        props.selectedListingDetails?.listing_data?.title ||
        (props.selectedListingDetails?.listing_data?.listing_id
          ? `Listing #${props.selectedListingDetails.listing_data.listing_id}`
          : '')
      "
      @update:open="createDealOpen = $event"
    />

    <!-- Documents attached to this listing — drafts, in-review,
         signed, archived. Click a row to drill into the editor;
         + New document opens /document-drafts/new with this listing
         pre-filled. -->
    <ListingDocumentsSection
      :listing-id="
        props.selectedListingDetails?.listing_data?.listing_id ?? null
      "
    />

    <!-- Unified activity timeline (post-Phase 4). Uses
         useTimeline.fetchListingTimeline(id) so the feed shows listing
         events AND any document/contact actions linked via metadata.
         Empty state replaces the previous derived-timestamps fallback —
         legacy listings without audit history simply show the empty
         state until their next mutation logs an activity. -->
    <div class="mt-4 border-t border-border pt-4">
      <h3 class="mb-3 text-sm font-semibold text-foreground">Activity</h3>

      <div v-if="timelineLoading" class="space-y-2">
        <div v-for="n in 3" :key="n" class="h-3 w-2/3 animate-pulse rounded bg-muted" />
      </div>

      <p
        v-else-if="timelineEvents.length === 0"
        class="text-xs text-muted-foreground/70"
      >
        No activity recorded yet.
      </p>

      <ol v-else class="relative ml-2 border-l border-border">
        <TimelineEntry
          v-for="event in timelineEvents"
          :key="event.id"
          :event="event"
        />
      </ol>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { faEllipsisVertical } from '@fortawesome/free-solid-svg-icons'
import { useListingColumnsAtom } from '@/store/index'
import { showLoading, dismissLoading, showToast } from '~/helpers/helpers'
import listingsServices from '~/services/listing.services'
import { computed, ref, watch, onMounted } from 'vue'
import { canRef, ownsListing, useUserRole } from '~/composables/useAuth'
import { useTimeline, type TimelineEvent } from '~/composables/useTimeline'
import TimelineEntry from '~/components/timeline/TimelineEntry.vue'
import CreateDealModal from '~/components/listings/CreateDealModal.vue'
const listingColumnsStore = useListingColumnsAtom()
const { fetchListingTimeline } = useTimeline()

const props = defineProps({
  selectedListingDetails: Object,
  listingDetailsSidebarOpen: Boolean,
})

// "Start a deal" modal state — pure UI flag, no persistence needed.
// Closes itself on success after navigating to the new deal page.
const createDealOpen = ref(false)
function openCreateDeal() {
  if (!props.selectedListingDetails?.listing_data?.listing_id) return
  createDealOpen.value = true
}

// Phase 4: per-row permission gate. Delete is allowed if the user owns the
// row (any role can soft-delete their own) or has admin / manager scope.
// The server enforces this via RLS — these flags are pure UX hints.
const role = useUserRole()
const canEditAny = canRef('edit_any_listing')
const canDeleteAny = canRef('hard_delete_listing')
const canDelete = computed(() => {
  const ld: any = props.selectedListingDetails?.listing_data
  return canDeleteAny.value || canEditAny.value || ownsListing(ld ?? null)
})

const ownerName = computed<string | null>(() => {
  const d: any = props.selectedListingDetails
  return (
    d?.created_by_name ??
    d?.listing_data?.created_by_name ??
    d?.creator?.full_name ??
    null
  )
})

// Unified timeline. Returns activities pivoted on metadata.listing_id —
// includes listing.* events plus any document.* / contact.* events
// stamped with this listing_id. RLS scopes what the caller actually
// sees per Phase-4 has_permission policy.
const timelineEvents = ref<TimelineEvent[]>([])
const timelineLoading = ref(false)

async function loadActivities(listingId: number | string | null | undefined) {
  if (!listingId) {
    timelineEvents.value = []
    return
  }
  const id = Number(listingId)
  if (!Number.isFinite(id)) {
    timelineEvents.value = []
    return
  }
  timelineLoading.value = true
  try {
    timelineEvents.value = await fetchListingTimeline(id)
  } finally {
    timelineLoading.value = false
  }
}

watch(
  () => props.selectedListingDetails?.listing_data?.listing_id ?? null,
  (id) => loadActivities(id),
  { immediate: true },
)

const thumbnail = ref('')
const imageLoading = ref(false)
const emit = defineEmits([
  'toggleSidebarListingDetails',
  'toggleImageGallery',
  'toggleOptionsMenu',
  'showUpdateListing',
])

function navigateToPostedListing() {
  const listingId = props.selectedListingDetails?.listing_data.listing_id
  const citySlug = props.selectedListingDetails?.city.city_slug
  const websiteUrl = useRuntimeConfig().public.WEBSITE_URL

  console.log('listingId: ', listingId)
  console.log('citySlug: ', citySlug)
  console.log('websiteUrl: ', websiteUrl)

  window.open(`${websiteUrl}property/${citySlug}-${listingId}`)
}

function toggleSidebarListingDetails() {
  emit('toggleSidebarListingDetails', props.selectedListingDetails)
}

function toggleImageGallery() {
  emit('toggleImageGallery', toRaw(props.selectedListingDetails))
}

function formatPrice(price: number | undefined) {
  if (!price) return '0'
  return price.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

async function archiveListing() {
  const id = props.selectedListingDetails!.listing_data.listing_id
  const title = props.selectedListingDetails!.listing_data.title ?? ''
  try {
    await listingColumnsStore.archiveListing(id)
  } catch (error) {
    showToast({
      title: 'Something went wrong archiving the listing. Please try again.',
      icon: 'warning',
    })
    return
  }
  showToast({
    title: title ? `Archived "${title}".` : 'Listing archived.',
    icon: 'success',
    button: { text: 'Undo' },
    onButtonClick: async () => {
      try {
        await listingColumnsStore.unarchiveListing(id)
        showToast({ title: 'Restored.', icon: 'success' })
      } catch (e) {
        showToast({ title: 'Could not undo. Please try again.', icon: 'error' })
      }
    },
  })
}

async function unarchiveListing() {
  const id = props.selectedListingDetails!.listing_data.listing_id
  const title = props.selectedListingDetails!.listing_data.title ?? ''
  try {
    await listingColumnsStore.unarchiveListing(id)
  } catch (error) {
    showToast({
      title: 'Something went wrong unarchiving the listing. Please try again.',
      icon: 'warning',
    })
    return
  }
  showToast({
    title: title ? `Unarchived "${title}".` : 'Listing unarchived.',
    icon: 'success',
    button: { text: 'Undo' },
    onButtonClick: async () => {
      try {
        await listingColumnsStore.archiveListing(id)
        showToast({ title: 'Re-archived.', icon: 'success' })
      } catch (e) {
        showToast({ title: 'Could not undo. Please try again.', icon: 'error' })
      }
    },
  })
}

async function deleteListing() {
  showLoading()
  const response = await listingColumnsStore.deleteListing(
    props.selectedListingDetails!.listing_data.listing_id
  )

  console.log('response: ', response)

  dismissLoading()
  window.location.reload()
}

async function cloneSelectedListing() {
  showLoading()
  try {
    const listingId = props.selectedListingDetails?.listing_data.listing_id
    if (!listingId) throw new Error('No listing selected to clone')
    await listingColumnsStore.cloneListing(listingId)
    dismissLoading()
    window.location.reload()
  } catch (error) {
    dismissLoading()
    alert('Failed to clone listing: ' + (error as Error).message)
  }
}

const optionsMenuOpen = ref(false)

const isOnline = computed(() => {
  return props.selectedListingDetails?.listing_data?.is_online || false
})

function toggleOptionsMenu() {
  optionsMenuOpen.value = !optionsMenuOpen.value
}

function showUpdateListing() {
  if (props.selectedListingDetails?.listing_data?.listing_id) {
    emit(
      'showUpdateListing',
      props.selectedListingDetails.listing_data.listing_id
    )
  }
}

onMounted(async () => {
  console.log('props.selectedListingDetails: ', props.selectedListingDetails)
  thumbnail.value = '/img/image-loading.gif'
  const response = await listingsServices._getListingThumbnail(
    props.selectedListingDetails?.listing_data.listing_id
  )
  thumbnail.value = (response as unknown as string) || '/img/hi_logo.svg'
  console.log('thumbnail from SidebarListingDetails: ', thumbnail.value)
  imageLoading.value = false
})

type ListingDetailsData = {
  contact_person: String
  street_address: String
  city: String
  for: String
  property_category: String
  unit_number: String
  price: String
  price_per_sqm: String
  condition: String
  approvement: Boolean
}

const listingDetailsData = computed(() => {
  console.log('props.selectedListingDetails: ', props.selectedListingDetails)
  const correctedData: ListingDetailsData = {
    contact_person: '',
    street_address: '',
    city: '',
    for: '',
    property_category: '',
    unit_number: '',
    price: '',
    price_per_sqm: '',
    condition: '',
    approvement: false,
  }

  correctedData.contact_person = props.selectedListingDetails?.contact.name
  correctedData.street_address =
    props.selectedListingDetails?.listing_data.street_address
  correctedData.city = props.selectedListingDetails?.city.value

  correctedData.for = props.selectedListingDetails?.price.sale_price
    ? 'Sale'
    : props.selectedListingDetails?.price.rent_price
    ? 'Rent'
    : '???'
  correctedData.property_category = 'residential'

  correctedData.unit_number =
    props.selectedListingDetails?.listing_data.unit_number

  const formattedPrice = props.selectedListingDetails?.price.rent_price
    ? formatPrice(props.selectedListingDetails.price.rent_price)
    : formatPrice(props.selectedListingDetails?.price.sale_price)

  const formattedPricePerSqm = props.selectedListingDetails?.price_per_sqm
    .sale_price_per_sqm
    ? formatPrice(props.selectedListingDetails.price_per_sqm.sale_price_per_sqm)
    : formatPrice(
        props.selectedListingDetails?.price_per_sqm.rent_price_per_sqm
      )

  correctedData.price = formattedPrice
  correctedData.price_per_sqm = formattedPricePerSqm
  correctedData.condition = props.selectedListingDetails?.condition.value

  console.log('correctedData: ', correctedData)
  return {
    contact_person: {
      value: correctedData.contact_person,
      label: 'Contact Person',
    },
    city: { value: correctedData.city, label: 'City' },
    street_address: {
      value: correctedData.street_address,
      label: 'Street Address',
    },
    for: { value: correctedData.for, label: 'For' },
    unit_number: { value: correctedData.unit_number, label: 'Unit Number' },
    property_category: {
      value: correctedData.property_category,
      label: 'Property Category',
    },
    price: { value: `₱${correctedData.price}`, label: 'Price' },
    price_per_sqm: {
      value: `₱${correctedData.price_per_sqm}`,
      label: 'Price per Sqm',
    },
    condition: { value: correctedData.condition, label: 'Condition' },
  }
})
</script>

<style></style>
