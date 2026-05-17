<script setup lang="ts">
/**
 * /admin/properties/[id] — property detail with variant list.
 *
 * Surfaces:
 *   - the property record from db-main-reference tables.sql
 *   - every listing that shares this property_id (the variants)
 *   - properties.primary_listing_id (admin-pinned) vs. elect_primary_listing_id (fallback)
 *   - properties.internal_authoritative toggle (drives the search-ranking boost)
 *
 * Endpoints:
 *   GET   /api/admin/properties/:id
 *   POST  /api/admin/properties/:id/promote-primary           { listing_id }
 *   PATCH /api/admin/properties/:id/internal-authoritative    { value }
 */

import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'

definePageMeta({ layout: 'default' })

type Variant = {
  id: number
  property_id: number | null
  title: string | null
  sale_price: number | null
  rent_price: number | null
  bedrooms: number | null
  bathrooms: number | null
  floor_area: number | null
  parking_spaces: number | null
  is_online: boolean
  deleted_at: string | null
  duplicate_of_id: number | null
  source_id: number | null
  foreign_id: string | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
  broker: { id: string; full_name: string | null; email: string | null } | null
  source: { id: number; slug: string; display_name: string | null } | null
  is_primary_pin: boolean
}

type Property = {
  id: number
  name: string | null
  slug: string | null
  street_address: string | null
  category: string | null
  type: string | null
  year_built: number | null
  primary_listing_id: number | null
  internal_authoritative: boolean
  city: { id: number; name: string | null; slug: string | null } | null
  barangay: { id: number; name: string | null; slug: string | null } | null
  created_at: string | null
  updated_at: string | null
}

const route = useRoute()
const propertyId = computed(() => Number(route.params.id))

const property = ref<Property | null>(null)
const variants = ref<Variant[]>([])
const electedPrimaryListingId = ref<number | null>(null)
const loading = ref(false)
const acting = ref(false)

useHead({
  title: () => `${property.value?.name || `Property #${propertyId.value}`} | Admin`,
})

const liveVariantCount = computed(() => variants.value.filter((v) => v.is_online && !v.deleted_at).length)
const internalVariantCount = computed(() => variants.value.filter((v) => !v.source_id).length)
const sourceVariantCount = computed(() => variants.value.filter((v) => !!v.source_id).length)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      property: Property
      variants: Variant[]
      elected_primary_listing_id: number | null
    }>(`/api/admin/properties/${propertyId.value}`)
    property.value = res.property
    variants.value = res.variants
    electedPrimaryListingId.value = res.elected_primary_listing_id
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load property', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function promotePrimary(listingId: number | null) {
  acting.value = true
  try {
    await $fetch(`/api/admin/properties/${propertyId.value}/promote-primary`, {
      method: 'POST',
      body: { listing_id: listingId },
    })
    await load()
    showToast({
      title: listingId ? `Pinned listing #${listingId} as primary` : 'Cleared primary pin',
      icon: 'success',
    })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Promote failed', icon: 'error' })
  } finally {
    acting.value = false
  }
}

async function toggleInternalAuthoritative(value: boolean) {
  acting.value = true
  try {
    await $fetch(`/api/admin/properties/${propertyId.value}/internal-authoritative`, {
      method: 'PATCH',
      body: { value },
    })
    if (property.value) property.value.internal_authoritative = value
    showToast({
      title: value ? 'Marked as internal-authoritative' : 'Unmarked',
      icon: 'success',
    })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Toggle failed', icon: 'error' })
  } finally {
    acting.value = false
  }
}

function priceLabel(v: Variant): string {
  if (v.sale_price) return `₱${v.sale_price.toLocaleString()} sale`
  if (v.rent_price) return `₱${v.rent_price.toLocaleString()} rent`
  return '—'
}

function bedBath(v: Variant): string {
  const parts: string[] = []
  if (v.bedrooms != null) parts.push(`${v.bedrooms}BR`)
  if (v.bathrooms != null) parts.push(`${v.bathrooms}BA`)
  if (v.floor_area != null) parts.push(`${v.floor_area}sqm`)
  return parts.join(' · ') || '—'
}

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['admin.access']" max-width="wide">
    <UiPageHeader
      :title="property?.name || `Property #${propertyId}`"
      :description="property?.street_address || 'Variants are listings sharing this property_id. Pin a primary to fix what search results display; otherwise the elected fallback (internal > sale > recency) is used.'"
    >
      <template #actions>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          @click="load"
        >
          Refresh
        </button>
      </template>
    </UiPageHeader>

    <div v-if="loading" class="p-5 text-center text-meta">Loading…</div>

    <template v-else-if="property">
      <!-- Property meta -->
      <UiCard variant="surface" padding="md">
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">City</div>
            <div class="font-medium text-foreground">{{ property.city?.name || '—' }}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Barangay</div>
            <div class="font-medium text-foreground">{{ property.barangay?.name || '—' }}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Type</div>
            <div class="font-medium text-foreground">{{ property.type || '—' }} / {{ property.category || '—' }}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Year built</div>
            <div class="font-medium text-foreground">{{ property.year_built || '—' }}</div>
          </div>
        </div>
      </UiCard>

      <!-- Stats + curation controls -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <UiStatCard label="Variants" :value="variants.length" />
        <UiStatCard label="Live" :value="liveVariantCount" tone="success" />
        <UiStatCard label="Internal / Source" :value="`${internalVariantCount} / ${sourceVariantCount}`" tone="primary" />
        <UiStatCard
          label="Primary pin"
          :value="property.primary_listing_id != null ? `#${property.primary_listing_id}` : `auto (#${electedPrimaryListingId ?? '—'})`"
          :tone="property.primary_listing_id != null ? 'primary' : 'neutral'"
        />
      </div>

      <UiCard variant="surface" padding="md">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="font-medium text-foreground">Internal-authoritative</div>
            <div class="text-xs text-muted-foreground mt-1">
              When ON, this property record is treated as curated by us. Drives a search-ranking
              boost and a trust badge on the public property page. Off by default for source-imported records.
            </div>
          </div>
          <button
            type="button"
            :disabled="acting"
            :class="[
              'rounded-lg px-3 py-2 text-sm font-medium border focus-ring',
              property.internal_authoritative
                ? 'border-success text-success hover:bg-success/10'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            ]"
            @click="toggleInternalAuthoritative(!property.internal_authoritative)"
          >
            {{ property.internal_authoritative ? 'ON — click to disable' : 'OFF — click to enable' }}
          </button>
        </div>
      </UiCard>

      <!-- Variants -->
      <UiCard variant="surface" padding="none">
        <UiEmptyState
          v-if="variants.length === 0"
          title="No listings under this property"
          description="An admin can attach a listing as a variant from the duplicates queue."
        />
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Listing</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Specs</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Price</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Origin</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr
                v-for="v in variants"
                :key="v.id"
                :class="v.deleted_at ? 'opacity-50' : ''"
              >
                <td class="px-3 py-2 max-w-xs">
                  <div class="font-medium text-foreground truncate">#{{ v.id }} — {{ v.title || 'Untitled' }}</div>
                  <div v-if="v.broker" class="text-[11px] text-muted-foreground">
                    {{ v.broker.full_name || v.broker.email || '—' }}
                  </div>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">{{ bedBath(v) }}</td>
                <td class="px-3 py-2 text-xs tabular-nums">{{ priceLabel(v) }}</td>
                <td class="px-3 py-2">
                  <UiBadge v-if="v.source" variant="info">
                    {{ v.source.display_name || v.source.slug }}
                  </UiBadge>
                  <UiBadge v-else variant="neutral">internal</UiBadge>
                </td>
                <td class="px-3 py-2">
                  <div class="flex gap-1 flex-wrap">
                    <UiBadge v-if="v.is_primary_pin" variant="info">primary (pinned)</UiBadge>
                    <UiBadge
                      v-else-if="!property.primary_listing_id && electedPrimaryListingId === v.id"
                      variant="neutral"
                    >
                      primary (elected)
                    </UiBadge>
                    <UiBadge v-if="v.is_online" variant="success">online</UiBadge>
                    <UiBadge v-else variant="warning">offline</UiBadge>
                    <UiBadge v-if="v.deleted_at" variant="destructive">deleted</UiBadge>
                    <UiBadge v-if="v.duplicate_of_id" variant="warning">
                      dup of #{{ v.duplicate_of_id }}
                    </UiBadge>
                  </div>
                </td>
                <td class="px-3 py-2 text-right">
                  <button
                    v-if="!v.is_primary_pin && v.is_online && !v.deleted_at"
                    type="button"
                    class="text-xs text-primary hover:underline"
                    :disabled="acting"
                    @click="promotePrimary(v.id)"
                  >
                    Pin as primary
                  </button>
                  <button
                    v-else-if="v.is_primary_pin"
                    type="button"
                    class="text-xs text-muted-foreground hover:underline"
                    :disabled="acting"
                    @click="promotePrimary(null)"
                  >
                    Clear pin
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>
    </template>

    <UiEmptyState
      v-else
      title="Property not found"
      description="The id in the URL does not match any row in public.properties."
    />
  </AdminPageShell>
</template>
