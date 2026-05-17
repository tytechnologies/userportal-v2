<script setup lang="ts">
/**
 * Single row of the listings table. Extracted from ListingsTable.vue so the
 * parent can later virtualize the list (each row is a self-contained unit
 * with explicit props/emits and no closures over parent state).
 */
import { ref, watch } from 'vue'
import RowInfoCard from '~/components/tables/RowInfoCard.vue'
import Actions from '~/components/pages/listings/ListingActions.vue'
import InlineEditCell from '~/components/ui/InlineEditCell.vue'
import { currencySuffix, formatCurrency, showToast } from '~/helpers/helpers'
import ListingService from '~/services/listing.services'

// Status options match the statusMapping in store/index.ts. Hard-coded
// here because there's no existing enum source. If/when statuses move to
// a Supabase reference table, swap this for a fetched list.
const STATUS_OPTIONS = [
  { label: 'AVAILABLE', value: 'available' },
  { label: 'TENANTED', value: 'occupied-rented' },
  { label: 'ON HOLD', value: 'on-hold' },
  { label: 'UNDER NEGOTIATION', value: 'under-negotiation' },
  { label: 'SOLD', value: 'sold' },
]

// Optimistic local copy of the status value. Diverges from
// listing.status.value only during a save attempt; on failure we revert
// back so the cell stops lying to the user.
const optimisticStatus = ref<string | null>(null)
const isSavingStatus = ref(false)

async function onSaveStatus(id: number, next: string | number) {
  const original = String(props.listing.status.value)
  optimisticStatus.value = String(next)
  isSavingStatus.value = true
  try {
    await ListingService._updateListing(id, { status: next })
    showToast({
      title: 'Status updated',
      icon: 'success',
    })
    // Tell the parent to refresh its row state. The MV refresh hook on
    // the server side already keeps listing_details current.
    emit('getListings')
  } catch (err: any) {
    optimisticStatus.value = original
    showToast({
      title: 'Failed to update status',
      message: err?.message || 'Please try again.',
      icon: 'error',
    })
  } finally {
    isSavingStatus.value = false
  }
}

// Reset optimistic value when the parent gives us fresh data.
watch(
  () => props.listing?.status?.value,
  () => {
    optimisticStatus.value = null
  },
)

const props = defineProps<{
  /** The pre-built columnData entry (see store/index.ts buildColumns). */
  listing: any
  /** Row index inside the visible page (0-based). */
  index: number
  /** True when the listing is queued for client-side deletion. */
  isDeleting: boolean
  /** Tailwind class list applied to the <tr> wrapper. */
  rowClasses: string | string[]
  /** Phase 2 bulk-selection — only renders the checkbox cell when true. */
  selectionEnabled?: boolean
  /** Selected state for this row. */
  isSelected?: boolean
}>()

const emit = defineEmits<{
  (e: 'showListingDetails', id: number): void
  (e: 'openContactInfo', contactId: number): void
  (e: 'openUpdateAvailability', id: number, title: string, value: any): void
  (e: 'triggerStatusSwitch', id: number): void
  (e: 'triggerListingEnablement', id: number): void
  (e: 'showUpdateListing', payload: any): void
  (e: 'showRemarksModal', payload: any): void
  (e: 'showDownloadModal', payload: any): void
  (e: 'showPropertyLogs', payload: any): void
  (e: 'showHistory', listingId: number): void
  (e: 'resetListings'): void
  (e: 'showCloneListing', payload: any): void
  (e: 'getListings'): void
  (e: 'toggleRow', id: number): void
}>()

// Status pill variant: maps the row's status value to a UiBadge-style
// color so the cell reads consistently with status pills elsewhere
// in the app. Falls back to neutral on unknown statuses (legacy data
// drift).
type StatusVariant = 'success' | 'warning' | 'primary' | 'destructive' | 'neutral'
function statusVariant(value: string | number | null | undefined): StatusVariant {
  switch (String(value)) {
    case 'available':           return 'success'
    case 'on-hold':             return 'warning'
    case 'under-negotiation':   return 'primary'
    case 'occupied-rented':     return 'neutral'
    case 'sold':                return 'neutral'
    default:                    return 'neutral'
  }
}
</script>

<template>
  <!-- Modernized row layout. Replaces the legacy `border-b-6 border-t-6
       rounded-l-2xl rounded-r-2xl` pattern with a single divider +
       hover bg, drops the awkward scale-105 jitter, and switches the
       status / availability / contact pills to the shared UiBadge
       look so the table stops feeling like a 2018 admin panel. -->
  <tr
    :class="[
      'group border-b border-border transition-colors duration-150 ease-out',
      isDeleting ? 'bg-destructive/10' : 'hover:bg-accent/40',
      rowClasses,
    ]"
  >
    <!-- Bulk-select cell. Only renders when the parent enables
         selection, so non-selecting consumers keep their cell layout
         unchanged. Click is stop-propagated so checking the box
         doesn't also open the listing detail sidebar. -->
    <td
      v-if="props.selectionEnabled"
      class="w-10 px-2 align-middle"
      @click.stop
    >
      <input
        type="checkbox"
        class="h-4 w-4 cursor-pointer accent-primary"
        :checked="props.isSelected"
        :disabled="props.isDeleting"
        :aria-label="`Select listing ${listing.listing_data.listing_id}`"
        @change="emit('toggleRow', listing.listing_data.listing_id)"
      />
    </td>

    <!-- Listing card (thumbnail + title + ID). RowInfoCard handles
         its own click → showListingDetails. -->
    <td class="w-[260px] py-3 pl-2 pr-1 align-middle">
      <RowInfoCard
        :index="index"
        :listing_data="listing"
        :showOnlineStatus="true"
        @showListingDetails="
          () => {
            if (!isDeleting) emit('showListingDetails', listing.listing_data.listing_id)
          }
        "
      />
    </td>

    <!-- Price. Two stacked rows when both rent + sale are set. -->
    <td
      v-if="listing.price.visible"
      class="px-3 py-3 align-middle"
    >
      <div v-if="!isDeleting" class="text-xs leading-tight">
        <p
          v-if="listing.price.rent_price"
          class="font-semibold tabular-nums text-foreground"
        >
          {{ currencySuffix(listing.price.rent_price) }}
          <span class="font-normal text-muted-foreground">/mo</span>
        </p>
        <p
          v-if="listing.price.sale_price"
          class="mt-0.5 font-semibold tabular-nums text-foreground"
        >
          {{ currencySuffix(listing.price.sale_price) }}
          <span class="font-normal text-muted-foreground">sale</span>
        </p>
      </div>
      <p v-else class="text-xs font-bold uppercase tracking-wide text-destructive">
        Deleting…
      </p>
    </td>

    <!-- ₱/sqm -->
    <td
      v-if="listing.price_per_sqm.visible"
      class="px-3 py-3 align-middle text-center"
    >
      <p v-if="!isDeleting" class="text-xs tabular-nums text-foreground">
        {{
          listing.price_per_sqm.rent_price_per_sqm
            ? formatCurrency(listing.price_per_sqm.rent_price_per_sqm)
            : formatCurrency(listing.price_per_sqm.sale_price_per_sqm)
        }}
      </p>
    </td>

    <!-- Condition -->
    <td
      v-if="listing.condition.visible"
      class="px-3 py-3 align-middle text-center"
    >
      <p v-if="!isDeleting" class="text-xs text-foreground">
        {{ listing.condition.value }}
      </p>
    </td>

    <!-- City -->
    <td
      v-if="listing.city.visible"
      class="px-3 py-3 align-middle text-center"
    >
      <p v-if="!isDeleting" class="text-xs text-foreground">
        {{ listing.city.value }}
      </p>
    </td>

    <!-- Availability -->
    <td
      v-if="listing.availability.visible"
      class="px-3 py-3 align-middle text-center"
    >
      <button
        v-if="!isDeleting"
        type="button"
        class="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary transition-colors duration-150 ease-out hover:bg-primary/15 focus-ring"
        @click="emit('openUpdateAvailability', listing.listing_data.listing_id, listing.listing_data.title, listing.availability.value)"
      >
        {{ listing.availability.value }}
      </button>
    </td>

    <!-- Designation -->
    <td
      v-if="listing.designation.visible"
      class="px-3 py-3 align-middle text-center"
    >
      <p v-if="!isDeleting" class="text-xs text-foreground">
        {{ listing.designation.value }}
      </p>
    </td>

    <!-- Contact -->
    <td
      v-if="listing.contact.visible"
      class="px-3 py-3 align-middle"
    >
      <button
        v-if="!isDeleting"
        type="button"
        class="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary transition-colors duration-150 ease-out hover:bg-primary/15 focus-ring"
        @click="emit('openContactInfo', listing.contact.id)"
      >
        {{ listing.contact.name }}
      </button>
    </td>

    <!-- Beds / Baths / Floor / Lot / Parking — same column pattern -->
    <td v-if="listing.bedrooms.visible" class="px-3 py-3 align-middle text-center">
      <p v-if="!isDeleting" class="text-xs tabular-nums text-foreground">{{ listing.bedrooms.value }}</p>
    </td>
    <td v-if="listing.bathrooms.visible" class="px-3 py-3 align-middle text-center">
      <p v-if="!isDeleting" class="text-xs tabular-nums text-foreground">{{ listing.bathrooms.value }}</p>
    </td>
    <td v-if="listing.floor_area.visible" class="px-3 py-3 align-middle text-center">
      <p v-if="!isDeleting" class="text-xs tabular-nums text-foreground">{{ listing.floor_area.value }}</p>
    </td>
    <td v-if="listing.lot_area.visible" class="px-3 py-3 align-middle text-center">
      <p v-if="!isDeleting" class="text-xs tabular-nums text-foreground">{{ listing.lot_area.value }}</p>
    </td>
    <td v-if="listing.parking_spaces.visible" class="px-3 py-3 align-middle text-center">
      <p v-if="!isDeleting" class="text-xs tabular-nums text-foreground">{{ listing.parking_spaces.value }}</p>
    </td>

    <!-- Status (inline editable). The pill mode here uses the proper
         UiBadge color tokens via display-class so the cell reads
         consistently with status pills elsewhere in the app. -->
    <td
      v-if="listing.status.visible"
      class="px-3 py-3 align-middle"
    >
      <div
        v-if="!isDeleting"
        class="flex items-center"
        @click.stop
      >
        <InlineEditCell
          :modelValue="optimisticStatus ?? listing.status.value"
          :displayValue="
            STATUS_OPTIONS.find(
              (o) => o.value === (optimisticStatus ?? listing.status.value),
            )?.label ?? listing.status.label
          "
          mode="select"
          :options="STATUS_OPTIONS"
          :disabled="isSavingStatus"
          :display-class="`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors duration-150 ease-out
            ${ statusVariant(optimisticStatus ?? listing.status.value) === 'success'     ? 'bg-success/10 text-success' :
               statusVariant(optimisticStatus ?? listing.status.value) === 'warning'     ? 'bg-warning/10 text-warning' :
               statusVariant(optimisticStatus ?? listing.status.value) === 'primary'     ? 'bg-primary/10 text-primary' :
               statusVariant(optimisticStatus ?? listing.status.value) === 'destructive' ? 'bg-destructive/10 text-destructive' :
                                                                                            'bg-muted text-muted-foreground' }`"
          @save="(next) => onSaveStatus(listing.listing_data.listing_id, next)"
        />
      </div>
    </td>

    <!-- isOnline — minimalist green/gray dot replaces the old
         FontAwesome check/x with a hover-tooltip hack. -->
    <td
      v-if="listing.is_online.visible"
      class="px-3 py-3 align-middle text-center"
    >
      <button
        v-if="!isDeleting"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors duration-150 ease-out focus-ring"
        :class="listing.is_online.value
          ? 'bg-success/10 text-success hover:bg-success/15'
          : 'bg-muted text-muted-foreground hover:bg-accent'"
        :aria-label="listing.is_online.value ? 'Online — click to take offline' : 'Offline — click to publish'"
        @click="emit('triggerListingEnablement', listing.listing_data.listing_id)"
      >
        <span
          class="h-1.5 w-1.5 rounded-full"
          :class="listing.is_online.value ? 'bg-success' : 'bg-muted-foreground/60'"
        />
        {{ listing.is_online.value ? 'Online' : 'Offline' }}
      </button>
    </td>

    <!-- Last update -->
    <td
      v-if="listing.updated_at.visible"
      class="px-3 py-3 align-middle text-center"
    >
      <p class="text-[11px] tabular-nums text-muted-foreground">
        {{ listing.updated_at.value }}
      </p>
    </td>

    <!-- Uploaded by -->
    <td
      v-if="listing.uploaded_by && listing.uploaded_by.visible"
      class="px-3 py-3 align-middle text-center"
    >
      <p v-if="!isDeleting" class="text-[11px] text-muted-foreground">
        {{ listing.uploaded_by.value }}
      </p>
    </td>

    <!-- Actions menu -->
    <td class="px-2 py-3 align-middle">
      <Actions
        v-if="!isDeleting"
        :row="listing"
        :index="index"
        @showUpdateListing="(p) => emit('showUpdateListing', p)"
        @showRemarksModal="(p) => emit('showRemarksModal', p)"
        @showDownloadModal="(p) => emit('showDownloadModal', p)"
        @showPropertyLogs="(p) => emit('showPropertyLogs', p)"
        @showHistory="(id) => emit('showHistory', id)"
        @resetListings="emit('resetListings')"
        @showCloneListing="(p) => emit('showCloneListing', p)"
        @getListings="emit('getListings')"
      />
    </td>
  </tr>
</template>
