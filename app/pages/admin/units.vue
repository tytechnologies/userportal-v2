<script setup lang="ts">
/**
 * /admin/units — units inventory.
 *
 * Per-building unit list. Loads units across all buildings the caller
 * can read (RLS gates by listing-owner / units.manage / admin).
 *
 * Operator picks a building from the dropdown to focus the list.
 *
 * Per-row actions:
 *   - Inline edit (status / unit_type / bedrooms / bathrooms / floor_area)
 *
 * Status filter on top so operators can hide demolished units.
 */

import { ref, computed, onMounted, reactive, watch } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Units | Admin' })

type UnitStatus = 'active' | 'inactive' | 'demolished'

type Unit = {
  id: string
  building_id: number
  unit_number: string
  floor: number | null
  tower: string | null
  bedrooms: number | null
  bathrooms: number | null
  floor_area_sqm: number | null
  parking_slots: number | null
  unit_type: string | null
  status: UnitStatus
  notes: string | null
  created_at: string
}

type Building = {
  id: number
  name: string
  city_id: number | null
  status: string | null
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const buildings = ref<Building[]>([])
const buildingsLoading = ref(false)
const selectedBuildingId = ref<number | null>(null)

const units = ref<Unit[]>([])
const loading = ref(false)
const statusFilter = ref<UnitStatus | 'all'>('active')
const search = ref('')

// Inline edit
const editingId = ref<string | null>(null)
const editForm = reactive({
  status: 'active' as UnitStatus,
  unit_type: '' as string,
  bedrooms: 0 as number | null,
  bathrooms: 0 as number | null,
  floor_area_sqm: 0 as number | null,
  notes: '' as string,
})
const saving = ref(false)

async function loadBuildings() {
  buildingsLoading.value = true
  try {
    const res = await $fetch<{ items: Building[] } | Building[]>('/api/buildings')
    const items = Array.isArray(res) ? res : (res.items ?? [])
    buildings.value = items.slice().sort((a, b) => a.name.localeCompare(b.name))
    if (!selectedBuildingId.value && buildings.value.length > 0) {
      selectedBuildingId.value = buildings.value[0]!.id
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load buildings',
      icon: 'error',
    })
  } finally {
    buildingsLoading.value = false
  }
}

async function loadUnits() {
  if (!selectedBuildingId.value) {
    units.value = []
    return
  }
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    const res = await $fetch<{ items: Unit[] }>(
      `/api/buildings/${selectedBuildingId.value}/units`,
      { query: params },
    )
    units.value = res.items ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load units',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

watch([selectedBuildingId, statusFilter], loadUnits)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return units.value
  return units.value.filter(
    (u) =>
      u.unit_number.toLowerCase().includes(q) ||
      (u.unit_type ?? '').toLowerCase().includes(q) ||
      (u.tower ?? '').toLowerCase().includes(q),
  )
})

function startEdit(u: Unit) {
  editingId.value = u.id
  editForm.status = u.status
  editForm.unit_type = u.unit_type ?? ''
  editForm.bedrooms = u.bedrooms
  editForm.bathrooms = u.bathrooms
  editForm.floor_area_sqm = u.floor_area_sqm
  editForm.notes = u.notes ?? ''
}

function cancelEdit() {
  editingId.value = null
}

async function save(unitId: string) {
  saving.value = true
  try {
    await $fetch(`/api/admin/units/${unitId}`, {
      method: 'PATCH',
      body: {
        status: editForm.status,
        unit_type: editForm.unit_type || null,
        bedrooms: editForm.bedrooms,
        bathrooms: editForm.bathrooms,
        floor_area_sqm: editForm.floor_area_sqm,
        notes: editForm.notes.trim() || null,
      },
    })
    showToast({ title: 'Unit updated' })
    editingId.value = null
    await loadUnits()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Save failed',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}

const counts = computed(() => {
  const c: Record<string, number> = {
    all: units.value.length,
    active: 0,
    inactive: 0,
    demolished: 0,
  }
  for (const u of units.value) c[u.status] = (c[u.status] ?? 0) + 1
  return c
})

function statusClass(s: UnitStatus) {
  if (s === 'active') return 'bg-success/15 text-success'
  if (s === 'inactive') return 'bg-warning/15 text-warning'
  return 'bg-muted text-muted-foreground'
}

const selectedBuildingName = computed(
  () => buildings.value.find((b) => b.id === selectedBuildingId.value)?.name ?? '',
)

onMounted(async () => {
  const ok =
    (await hasPermission('units.manage')) || (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await loadBuildings()
  if (selectedBuildingId.value) await loadUnits()
})
</script>

<template>
  <div class="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <header>
        <h1 class="text-page-title">
          Units
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Per-building unit inventory. Edit unit specs in place; deactivate units that no longer exist.
        </p>
      </header>

      <!-- Building picker + filters -->
      <div class="flex flex-wrap items-end gap-3">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Building</span>
          <select
            v-model.number="selectedBuildingId"
            :disabled="buildingsLoading"
            class="mt-1 block w-72 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
          >
            <option v-if="buildingsLoading" :value="null">Loading…</option>
            <option v-else-if="buildings.length === 0" :value="null">
              No buildings available
            </option>
            <option v-for="b in buildings" :key="b.id" :value="b.id">
              {{ b.name }}
            </option>
          </select>
        </label>
        <div class="inline-flex rounded-lg border border-border p-1">
          <button
            v-for="opt in (['active', 'inactive', 'demolished', 'all'] as const)"
            :key="opt"
            type="button"
            :class="[
              'inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md transition',
              statusFilter === opt
                ? 'bg-primary text-white'
                : 'text-foreground hover:text-foreground/80',
            ]"
            @click="statusFilter = opt"
          >
            <span class="capitalize">{{ opt }}</span>
            <span
              :class="[
                'rounded-full px-1.5 text-[10px] font-semibold',
                statusFilter === opt
                  ? 'bg-white/20 text-white'
                  : 'bg-muted text-muted-foreground',
              ]"
            >{{ counts[opt] }}</span>
          </button>
        </div>
        <input
          v-model="search"
          type="search"
          placeholder="Search unit number, type, tower…"
          class="ml-auto w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
        />
      </div>

      <!-- Table -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="!selectedBuildingId"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          Pick a building to view its units.
        </div>
        <div
          v-else-if="filtered.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          <p>No units in <strong>{{ selectedBuildingName }}</strong> match the current filter.</p>
        </div>
        <div v-else>
          <!-- Mobile: stacked card list (< md). Tap "Edit" to expand
               the same edit form used in the desktop table. -->
          <ul class="divide-y divide-border md:hidden">
            <li
              v-for="u in filtered"
              :key="u.id"
              class="p-4"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-foreground">{{ u.unit_number }}</p>
                  <p class="mt-0.5 text-xs text-muted-foreground">
                    <span v-if="u.floor !== null">F{{ u.floor }}</span>
                    <span v-if="u.tower"> · {{ u.tower }}</span>
                    <span v-if="u.unit_type"> · <span class="capitalize">{{ u.unit_type.replace('_', ' ') }}</span></span>
                  </p>
                  <p class="mt-1 text-xs tabular-nums text-foreground">
                    <span v-if="u.bedrooms !== null">{{ Number(u.bedrooms) }}br</span>
                    <span v-if="u.bathrooms !== null"> / {{ Number(u.bathrooms) }}ba</span>
                    <span v-if="u.floor_area_sqm"> · {{ Number(u.floor_area_sqm) }}mÂ²</span>
                  </p>
                </div>
                <div class="flex flex-col items-end gap-1">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(u.status)]">
                    {{ u.status }}
                  </span>
                  <button
                    type="button"
                    class="text-xs text-primary hover:underline"
                    @click="editingId === u.id ? cancelEdit() : startEdit(u)"
                  >
                    {{ editingId === u.id ? 'Cancel' : 'Edit' }}
                  </button>
                </div>
              </div>

              <!-- Inline edit form (mobile). Mirrors the desktop edit row. -->
              <div
                v-if="editingId === u.id"
                class="mt-3 rounded-lg bg-primary/5 p-3"
              >
                <div class="grid grid-cols-2 gap-3">
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">Status</span>
                    <select
                      v-model="editForm.status"
                      class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                    >
                      <option value="active">active</option>
                      <option value="inactive">inactive</option>
                      <option value="demolished">demolished</option>
                    </select>
                  </label>
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">Unit type</span>
                    <select
                      v-model="editForm.unit_type"
                      class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                    >
                      <option value="">—</option>
                      <option value="studio">studio</option>
                      <option value="1br">1br</option>
                      <option value="2br">2br</option>
                      <option value="3br">3br</option>
                      <option value="4br_plus">4br+</option>
                      <option value="penthouse">penthouse</option>
                      <option value="duplex">duplex</option>
                      <option value="townhouse">townhouse</option>
                      <option value="commercial">commercial</option>
                    </select>
                  </label>
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">Bedrooms</span>
                    <input
                      v-model.number="editForm.bedrooms"
                      type="number"
                      step="0.5"
                      min="0"
                      max="20"
                      class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                    />
                  </label>
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">Bathrooms</span>
                    <input
                      v-model.number="editForm.bathrooms"
                      type="number"
                      step="0.5"
                      min="0"
                      max="20"
                      class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                    />
                  </label>
                  <label class="block">
                    <span class="block text-xs font-medium text-muted-foreground">Floor area (mÂ²)</span>
                    <input
                      v-model.number="editForm.floor_area_sqm"
                      type="number"
                      step="0.01"
                      min="0"
                      class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                    />
                  </label>
                  <label class="col-span-2 block">
                    <span class="block text-xs font-medium text-muted-foreground">Notes</span>
                    <input
                      v-model="editForm.notes"
                      type="text"
                      maxlength="2000"
                      class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                    />
                  </label>
                </div>
                <div class="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
                    @click="cancelEdit"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    :disabled="saving"
                    class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-60"
                    @click="save(u.id)"
                  >
                    <span v-if="saving">Saving…</span>
                    <span v-else>Save</span>
                  </button>
                </div>
              </div>
            </li>
          </ul>

          <!-- Desktop table (md+). Same data, tabular layout. -->
          <div class="hidden overflow-x-auto md:block">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Unit #</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Floor / Tower</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Bd / Ba</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Floor area</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <template v-for="u in filtered" :key="u.id">
                <tr class="hover:bg-accent hover:text-accent-foreground">
                  <td class="px-3 py-2 font-medium text-foreground">{{ u.unit_number }}</td>
                  <td class="px-3 py-2 text-xs text-muted-foreground">
                    <span v-if="u.floor !== null">F{{ u.floor }}</span>
                    <span v-if="u.tower"> · {{ u.tower }}</span>
                    <span v-if="u.floor === null && !u.tower" class="text-muted-foreground/70">—</span>
                  </td>
                  <td class="px-3 py-2 text-xs text-foreground">
                    <span v-if="u.unit_type" class="capitalize">{{ u.unit_type.replace('_', ' ') }}</span>
                    <span v-else class="text-muted-foreground/70">—</span>
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums text-foreground">
                    <span v-if="u.bedrooms !== null">{{ Number(u.bedrooms) }}br</span>
                    <span v-else class="text-muted-foreground/70">—</span>
                    <span v-if="u.bathrooms !== null"> / {{ Number(u.bathrooms) }}ba</span>
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums text-foreground">
                    <span v-if="u.floor_area_sqm">{{ Number(u.floor_area_sqm) }}mÂ²</span>
                    <span v-else class="text-muted-foreground/70">—</span>
                  </td>
                  <td class="px-3 py-2">
                    <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(u.status)]">
                      {{ u.status }}
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right">
                    <button
                      type="button"
                      class="text-xs text-primary hover:underline"
                      @click="editingId === u.id ? cancelEdit() : startEdit(u)"
                    >
                      {{ editingId === u.id ? 'Cancel' : 'Edit' }}
                    </button>
                  </td>
                </tr>
                <!-- Inline edit row -->
                <tr v-if="editingId === u.id" class="bg-primary/5">
                  <td colspan="7" class="px-3 py-3">
                    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">Status</span>
                        <select
                          v-model="editForm.status"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        >
                          <option value="active">active</option>
                          <option value="inactive">inactive</option>
                          <option value="demolished">demolished</option>
                        </select>
                      </label>
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">Unit type</span>
                        <select
                          v-model="editForm.unit_type"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        >
                          <option value="">—</option>
                          <option value="studio">studio</option>
                          <option value="1br">1br</option>
                          <option value="2br">2br</option>
                          <option value="3br">3br</option>
                          <option value="4br_plus">4br+</option>
                          <option value="penthouse">penthouse</option>
                          <option value="duplex">duplex</option>
                          <option value="townhouse">townhouse</option>
                          <option value="commercial">commercial</option>
                        </select>
                      </label>
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">Bedrooms</span>
                        <input
                          v-model.number="editForm.bedrooms"
                          type="number"
                          step="0.5"
                          min="0"
                          max="20"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">Bathrooms</span>
                        <input
                          v-model.number="editForm.bathrooms"
                          type="number"
                          step="0.5"
                          min="0"
                          max="20"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                      <label class="block">
                        <span class="block text-xs font-medium text-muted-foreground">Floor area (mÂ²)</span>
                        <input
                          v-model.number="editForm.floor_area_sqm"
                          type="number"
                          step="0.01"
                          min="0"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                      <label class="col-span-2 block lg:col-span-2">
                        <span class="block text-xs font-medium text-muted-foreground">Notes</span>
                        <input
                          v-model="editForm.notes"
                          type="text"
                          maxlength="2000"
                          class="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                        />
                      </label>
                    </div>
                    <div class="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
                        @click="cancelEdit"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        :disabled="saving"
                        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-60"
                        @click="save(u.id)"
                      >
                        <span v-if="saving">Saving…</span>
                        <span v-else>Save</span>
                      </button>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
