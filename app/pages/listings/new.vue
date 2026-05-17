<script setup lang="ts">
/**
 * /listings/new — guided multi-step "Add Listing" flow.
 *
 * Replaces the legacy single-page NewForm with AddListingWizard.
 * NewForm is still used by the in-place /listings/[id] update flow,
 * which has thousands of lines of edge-case behavior we don't want
 * to regress in a launch sweep.
 *
 * The wizard handles its own submit (calls into ListingService) and
 * navigates to /listings/{id} on success — no callback needed here.
 */
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import AddListingWizard from '~/components/listings/AddListingWizard.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'New listing | Housinginteractive' })
</script>

<template>
  <AdminPageShell max-width="wide">
    <UiPageHeader
      title="New listing"
      description="Six guided steps. Required fields are validated as you go; you can save as a draft any time on the final step."
      :back="{ to: '/listings', label: 'Back to listings' }"
    />
    <AddListingWizard />
  </AdminPageShell>
</template>
