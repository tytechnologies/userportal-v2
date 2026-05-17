<script setup lang="ts">
// Listing detail page (permalink). Thin shell over ListingDetailContent
// so the standalone page and the modal preview render the same UI.
//
// Use cases:
//   - Direct URL navigation (sharing a link to a listing).
//   - Click-through from the modal's "Open full page" link.

import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ListingDetailContent from '~/components/listings/ListingDetailContent.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const id = computed(() => Number(route.params.id))

useHead(() => ({
  title: 'Listing detail',
}))
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6 lg:px-8">
    <NuxtLink
      :to="{ name: 'listings' }"
      class="inline-flex items-center gap-1 text-meta hover:text-foreground"
    >
      <span aria-hidden="true">←</span>
      All listings
    </NuxtLink>
    <ListingDetailContent v-if="Number.isFinite(id)" :listing-id="id" />
    <UiEmptyState
      v-else
      title="Invalid listing"
      description="The listing id in the URL isn't a valid number. Use the link below to return to the index."
    >
      <template #action>
        <NuxtLink
          :to="{ name: 'listings' }"
          class="btn-primary focus-ring"
        >
          Back to listings
        </NuxtLink>
      </template>
    </UiEmptyState>
  </div>
</template>
