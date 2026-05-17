<script setup lang="ts">
/**
 * /listings/[id]/edit — guided edit flow.
 *
 * Mounts the same six-step AddListingWizard used by /listings/new,
 * passing the listing id as a prop. The wizard hydrates form fields
 * from the existing listing on mount, fetches existing photos for
 * step 5, and branches its submit logic to call _updateListing
 * instead of _createListingOnly. Audit trail is automatic — the
 * listings_audit_diff trigger writes a listing.updated activity row
 * with field-level diffs for every save, viewable via the wizard's
 * "View history" button (opens ListingHistoryDrawer).
 *
 * Replaces the legacy NewForm.vue path (3881 lines, TDZ-prone, missing
 * the wizard's new fields: description / original_*_price / year_built /
 * developer_name / attributes.commercial.* / attributes.media.*).
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import AddListingWizard from '~/components/listings/AddListingWizard.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Edit listing | Housinginteractive' })

const route = useRoute()
const listingId = computed<number | null>(() => {
  const raw = route.params.id
  const id = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(id) ? id : null
})
</script>

<template>
  <AdminPageShell max-width="wide">
    <UiPageHeader
      title="Edit listing"
      :description="listingId ? `Listing #${listingId} — changes are tracked in the activity log` : 'Invalid listing id'"
      :back="{ to: '/listings', label: 'Back to listings' }"
    />
    <AddListingWizard
      v-if="listingId"
      :key="`edit-${listingId}`"
      :listing-id="listingId"
    />
  </AdminPageShell>
</template>
