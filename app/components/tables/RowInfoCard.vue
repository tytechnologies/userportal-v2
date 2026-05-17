<template>
  <button
    type="button"
    class="group relative flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-150 ease-out hover:bg-accent focus-ring"
    :class="{ 'bg-accent': listingSelected }"
    @click="onActivate"
  >
    <!-- Thumbnail tile. Online state lives as a tiny dot in the
         lower-right corner of the tile so the row body stays clean
         (the dedicated isOnline column is the source of truth; this
         is just a quick visual cue when the column is hidden). -->
    <div class="relative h-16 w-24 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-border">
      <img
        :src="thumbnail || '/img/image-loading.gif'"
        :alt="`Listing ${props.listing_data.listing_data.listing_id}`"
        class="h-full w-full object-cover"
        loading="lazy"
        decoding="async"
        width="96"
        height="64"
      />
      <span
        v-if="props.showOnlineStatus"
        class="absolute right-1 top-1 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-card"
        :class="props.listing_data.listing_data?.is_online ? 'bg-success' : 'bg-muted-foreground/40'"
        :title="props.listing_data.listing_data?.is_online ? 'Online' : 'Offline'"
        aria-hidden="true"
      />
    </div>

    <!-- Title + ID. Title typography scales by length, but uses
         text-sm/text-base instead of arbitrary [1.5em] units so the
         visual hierarchy reads consistently with the rest of the
         table. -->
    <div class="flex min-w-0 flex-1 flex-col justify-center">
      <span
        class="block truncate font-semibold text-foreground"
        :class="formattedAddress.length <= 28 ? 'text-base leading-tight' : 'text-sm leading-snug'"
        :title="formattedAddress"
      >
        {{ formattedAddress || 'Untitled listing' }}
      </span>
      <span class="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
        ID #{{ props.listing_data.listing_data.listing_id }}
      </span>
    </div>
  </button>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue'
import ListingServices from '~/services/listing.services'

const props = defineProps({
  index: {
    type: Number,
    required: true,
  },
  listing_data: {
    type: Object,
    required: true,
  },
  showOnlineStatus: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['changeListingOnlineStatus', 'showListingDetails'])
const listingSelected = ref(false)
const thumbnail = ref('')

function onActivate() {
  emit('showListingDetails')
  listingSelected.value = true
}

// Compose the row's display address from the columnData shape. Two
// branches for condominium vs. house: condos lead with unit + street,
// houses include lot area + barangay. Either path drops empty
// segments so the result reads cleanly without a trailing comma.
const formattedAddress = computed(() => {
  const data = props.listing_data

  const isCondominium =
    data.property_type?.value === 'condo' ||
    (data.category?.value === 'residential' &&
      (data.property_name?.value || data.listing_data.unit_number))

  const parts: string[] = []
  if (isCondominium) {
    if (data.listing_data.unit_number) parts.push(data.listing_data.unit_number)
    if (data.listing_data.street_address) parts.push(data.listing_data.street_address)
    if (data.city?.value) parts.push(data.city.value)
  } else {
    if (data.listing_data.street_address) parts.push(data.listing_data.street_address)
    if (data.lot_area?.value) parts.push(`Lot: ${data.lot_area.value}`)
    if (data.barangay?.value) parts.push(data.barangay.value)
    if (data.city?.value) parts.push(data.city.value)
  }
  return parts.map((p) => p?.trim()).filter(Boolean).join(', ')
})

onMounted(async () => {
  const listingId = props.listing_data.listing_data.listing_id
  try {
    const response = await ListingServices._getListingThumbnail(listingId)
    thumbnail.value = (response as unknown as string) || '/img/hi_logo.svg'
  } catch {
    thumbnail.value = '/img/hi_logo.svg'
  }
})
</script>
