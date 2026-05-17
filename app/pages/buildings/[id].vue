<script setup lang="ts">
// Building detail / edit page. The new content fields (description,
// amenities, latitude, longitude) are populated here so the public
// website's building-page hero stops rendering blank copy.
//
// RLS: read = any authenticated, write/delete gated on
// buildings.manage permission (admin / manager). Non-admins see the
// edit form disabled instead of a 403 — clearer UX than hiding the
// page outright.
//
// Routing note: /buildings.vue (legacy tabs page) handles /buildings
// exactly; this file handles /buildings/:id. Vue Router treats them
// as distinct routes — no conflict.

import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBuildings, type Building } from '~/composables/useBuildings'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const { getBuilding, updateBuilding, deleteBuilding } = useBuildings()

const id = computed(() => Number(route.params.id))
const building = ref<(Building & { listings_count?: number }) | null>(null)
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const notFound = ref(false)

const isSaving = ref(false)
const isDeleting = ref(false)

// Edit buffers — keep input responsive while a save is in flight.
const editName = ref('')
const editAddress = ref('')
const editDescription = ref('')
const editAmenitiesText = ref('') // newline-joined; split on save
const editLat = ref<number | null>(null)
const editLng = ref<number | null>(null)
const editZonal = ref<number | null>(null)
const editIsCurated = ref(false)

// Thumbnail upload state. Stored at buildings/<id>/thumbnail.<ext> in
// S3; the public site signs from the same prefix.
const thumbnailUploading = ref(false)
const thumbnailUrl = ref<string | null>(null)
const thumbnailRefreshKey = ref(0) // bumps to force a re-fetch after upload

async function loadThumbnail(buildingId: number) {
  // Reuse the public batch endpoint for the lookup — it returns null
  // when no image exists (which is the common state until editors
  // populate one).
  try {
    const res = await $fetch<{ thumbnails: Record<string, string | null> }>(
      '/api/public/building-thumbnails',
      { method: 'POST', body: { building_ids: [buildingId] } },
    )
    thumbnailUrl.value = res?.thumbnails?.[String(buildingId)] ?? null
  } catch {
    thumbnailUrl.value = null
  }
}

function pickThumbnail() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/webp'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file || !building.value) return
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      thumbnailUploading.value = true
      try {
        await $fetch(`/api/buildings/${building.value!.id}/thumbnail`, {
          method: 'POST',
          body: { data_url: dataUrl },
        })
        // Force the loadThumbnail call to re-fetch (signed URL hasn't
        // expired but the underlying object changed).
        thumbnailRefreshKey.value++
        await loadThumbnail(building.value!.id)
        showToast({ title: 'Thumbnail uploaded.', icon: 'success' })
      } catch (err: any) {
        showToast({ title: err?.statusMessage ?? 'Upload failed.', icon: 'error' })
      } finally {
        thumbnailUploading.value = false
      }
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

function syncBuffers(b: Building) {
  editName.value = b.name ?? ''
  editAddress.value = b.address ?? ''
  editDescription.value = b.description ?? ''
  editAmenitiesText.value = (b.amenities ?? []).join('\n')
  editLat.value = b.latitude
  editLng.value = b.longitude
  editZonal.value = b.zonal_value
  editIsCurated.value = b.is_curated ?? false
}

async function load() {
  if (!Number.isFinite(id.value)) {
    notFound.value = true
    isLoading.value = false
    return
  }
  isLoading.value = true
  errorMessage.value = null
  notFound.value = false
  try {
    const row = await getBuilding(id.value)
    building.value = row
    syncBuffers(row)
    // Fire-and-forget thumbnail fetch.
    void loadThumbnail(row.id)
  } catch (err: any) {
    if (err?.statusCode === 404) {
      notFound.value = true
    } else {
      errorMessage.value = err?.statusMessage || err?.message || 'Failed to load building'
    }
  } finally {
    isLoading.value = false
  }
}

watch(id, () => load())

async function onSave() {
  if (!building.value) return
  isSaving.value = true
  try {
    // Split the amenities textarea on newlines, trim, drop empties.
    // The user types one amenity per line; the API expects string[].
    const amenities = editAmenitiesText.value
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '')

    const updated = await updateBuilding(building.value.id, {
      name: editName.value.trim() || building.value.name,
      address: editAddress.value.trim() || null,
      description: editDescription.value.trim() || null,
      amenities,
      latitude: editLat.value ?? null,
      longitude: editLng.value ?? null,
      zonal_value: editZonal.value ?? null,
      is_curated: editIsCurated.value,
    })
    building.value = { ...updated, listings_count: building.value.listings_count }
    syncBuffers(updated)
    showToast({ title: 'Building saved', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to save', icon: 'error' })
  } finally {
    isSaving.value = false
  }
}

async function onDelete() {
  if (!building.value) return
  if (!confirm(`Delete building "${building.value.name}"? Listings linked to it will keep their data; only the FK is cleared.`)) return
  isDeleting.value = true
  try {
    await deleteBuilding(building.value.id)
    showToast({ title: 'Building deleted', icon: 'success' })
    await router.push('/buildings')
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to delete', icon: 'error' })
    isDeleting.value = false
  }
}

useHead(() => ({
  title: building.value?.name ? `${building.value.name} | Buildings` : 'Building',
}))

onMounted(load)
</script>

<template>
  <div class="mx-auto max-w-3xl p-4">
    <div v-if="isLoading" class="rounded-xl border border-border bg-background p-8 text-center text-sm text-muted-foreground/70">
      Loading…
    </div>

    <div
      v-else-if="notFound"
      class="rounded-xl border border-border bg-background p-8 text-center"
    >
      <p class="text-sm font-semibold text-foreground">Building not found</p>
      <p class="mt-1 text-xs text-muted-foreground">It may have been deleted.</p>
      <NuxtLink :to="{ name: 'buildings' }" class="mt-4 inline-block text-sm text-primary hover:underline">
        Back to buildings
      </NuxtLink>
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </div>

    <template v-else-if="building">
      <header class="mb-4 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Building</p>
          <h1 class="mt-1 flex items-center gap-2 text-xl font-bold text-foreground">
            <span class="truncate">{{ building.name }}</span>
            <span
              v-if="building.is_curated"
              class="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success"
              title="Curated — visible on the public website."
            >
              Curated
            </span>
            <span
              v-else
              class="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
              title="Auto-generated from a listing title — not exposed publicly until approved."
            >
              Unreviewed
            </span>
          </h1>
          <p class="text-xs text-muted-foreground">
            Slug: {{ building.slug || '—' }}
            <span v-if="building.listings_count !== undefined">
              · {{ building.listings_count }} linked listings
            </span>
          </p>
        </div>
        <button
          class="rounded-md border border-destructive/30 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          :disabled="isDeleting"
          @click="onDelete"
        >
          {{ isDeleting ? 'Deleting…' : 'Delete' }}
        </button>
      </header>

      <!-- Thumbnail upload — surface for the public website's
           building card hero. Same S3 prefix the public read endpoint
           signs from: buildings/<id>/thumbnail.<ext>. -->
      <section class="mb-4 rounded-xl border border-border bg-background p-5 shadow-sm">
        <h2 class="mb-3 text-sm font-semibold text-foreground">Cover photo</h2>
        <div class="flex gap-4">
          <div class="h-28 w-44 shrink-0 overflow-hidden rounded-md border border-border bg-muted-foreground/5">
            <img
              v-if="thumbnailUrl"
              :src="thumbnailUrl"
              :alt="building.name"
              class="h-full w-full object-cover"
            />
            <div v-else class="flex h-full w-full items-center justify-center text-xs text-muted-foreground/70">
              No photo
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs text-muted-foreground">
              JPG, PNG, or WEBP. Used on the public website's building cards
              and detail page hero.
            </p>
            <button
              type="button"
              class="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              :disabled="thumbnailUploading"
              @click="pickThumbnail"
            >
              {{ thumbnailUploading ? 'Uploading…' : (thumbnailUrl ? 'Replace photo' : 'Upload photo') }}
            </button>
          </div>
        </div>
      </section>

      <form class="space-y-4 rounded-xl border border-border bg-background p-5 shadow-sm" @submit.prevent="onSave">
        <!-- Identity -->
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <input
              v-model="editName"
              class="w-full rounded-md border border-border px-3 py-2 text-sm"
              maxlength="200"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Address</label>
            <input
              v-model="editAddress"
              class="w-full rounded-md border border-border px-3 py-2 text-sm"
              maxlength="500"
              placeholder="Street, neighborhood, city"
            />
          </div>
        </div>

        <!-- Marketing description -->
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">
            Description
            <span class="text-muted-foreground/70">— shown on the public building page</span>
          </label>
          <textarea
            v-model="editDescription"
            rows="5"
            class="w-full rounded-md border border-border px-3 py-2 text-sm"
            placeholder="Marketing copy for the building hero. Plain text."
          />
        </div>

        <!-- Amenities -->
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">
            Amenities
            <span class="text-muted-foreground/70">— one per line</span>
          </label>
          <textarea
            v-model="editAmenitiesText"
            rows="4"
            class="w-full rounded-md border border-border px-3 py-2 text-sm font-mono"
            placeholder="Pool&#10;Gym&#10;Parking&#10;24/7 Security"
          />
        </div>

        <!-- Geo + zonal -->
        <div class="grid gap-3 sm:grid-cols-3">
          <div>
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Latitude</label>
            <input
              v-model.number="editLat"
              type="number"
              step="0.0000001"
              class="w-full rounded-md border border-border px-3 py-2 text-sm"
              placeholder="14.5547"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Longitude</label>
            <input
              v-model.number="editLng"
              type="number"
              step="0.0000001"
              class="w-full rounded-md border border-border px-3 py-2 text-sm"
              placeholder="121.0244"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Zonal value</label>
            <input
              v-model.number="editZonal"
              type="number"
              step="0.01"
              min="0"
              class="w-full rounded-md border border-border px-3 py-2 text-sm"
              placeholder="₱"
            />
          </div>
        </div>

        <!-- Curation toggle. Defaults false on auto-rows; an editor
             flips it true to publish the building on the public site. -->
        <div class="rounded-lg border border-border bg-muted-foreground/5/50 p-3">
          <label class="flex items-start gap-3 cursor-pointer">
            <input
              v-model="editIsCurated"
              type="checkbox"
              class="mt-1 h-4 w-4 cursor-pointer"
            />
            <div class="text-sm">
              <p class="font-medium text-foreground">Approve as building</p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                Publishes this row on the public website. Leave unchecked
                if this is a listing title rather than a real building —
                most auto-generated rows from the May-1 backfill should
                stay unreviewed.
              </p>
            </div>
          </label>
        </div>

        <footer class="flex justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted-foreground/5"
            @click="building && syncBuffers(building)"
          >
            Reset
          </button>
          <button
            type="submit"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            :disabled="isSaving"
          >
            {{ isSaving ? 'Saving…' : 'Save' }}
          </button>
        </footer>
      </form>
    </template>
  </div>
</template>
