<template>
  <div>
    <div
      class="mt-2 flex justify-between items-center border-b border-border"
    >
      <h3 class="text-lg mb-2 font-bold text-foreground px-2 pt-[.5vw]">
        Table View Options
      </h3>
      <div
        class="cursor-pointer group flex items-center justify-center bg-muted rounded-full p-2 h-[2vw] w-[2vw] hover:bg-primary/10 mr-2"
        :class="{ 'bg-primary/10': tableViewOptionsSidebarOpen }"
        @click="toggleTableViewOptionsSidebar"
      >
        <font-awesome-icon
          icon="close"
          class="text-gray-350 group-hover:text-primary"
          :class="{ 'text-primary': tableViewOptionsSidebarOpen }"
          size="lg"
        />
      </div>
    </div>
    <div>
      <!-- Search Bar -->
      <div>
        <input
          type="text"
          class="w-full bg-card rounded-lg p-2 text-foreground placeholder:text-muted-foreground/50 placeholder:font-bold border my-4 border-border focus:border-primary/30"
          placeholder="Search"
          v-model="searchTerm"
        />
      </div>
      <!-- Check All Button -->
      <div class="mb-4">
        <button
          @click="checkAllColumns"
          class="w-full bg-primary text-primary-foreground font-semibold py-2 px-4 rounded-lg transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
        >
          Check All
        </button>
      </div>
      <!-- Table View Options -->
      <table class="w-full">
        <thead>
          <tr class="text-muted-foreground/70 flex justify-between items-center p-2">
            <th class="text-left w-[70%]">Column Properties</th>
          </tr>
        </thead>
        <tbody class="overflow-y-auto block sm:max-h-[28vw] h-full">
          <tr
            v-for="(col, index) in hideableColumns"
            :key="index"
            @click="toggleColumn(col)"
            class="text-muted-foreground/70 flex justify-between my-2 cursor-pointer hover:bg-muted items-center p-2 rounded-lg"
            :class="index % 2 === 0 ? 'bg-muted' : 'bg-muted'"
          >
            <td class="text-foreground font-semibold w-[90%]">
              {{ col.column_name }}
            </td>
            <td class="w-[10%]">
              <input type="checkbox" v-model="col.visible" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { useListingColumnsAtom } from '~/store'

const searchTerm = ref('')
const { listingColumnsData, setColumnVisibility, listingColumnsArray } =
  useListingColumnsAtom()

const COLUMN_VISIBILITY_KEY = 'listing_column_visibility_preferences'

// Load column visibility preferences from localStorage
function loadColumnPreferences() {
  if (import.meta.client) {
    const stored = localStorage.getItem(COLUMN_VISIBILITY_KEY)
    if (stored) {
      try {
        const preferences = JSON.parse(stored)
        listingColumnsArray.forEach(col => {
          if (col.column_name in preferences) {
            col.visible = preferences[col.column_name]
          }
        })
      } catch (e) {
        console.error('Error loading column preferences:', e)
      }
    }
  }
}

// Save column visibility preferences to localStorage
function saveColumnPreferences() {
  if (import.meta.client) {
    const preferences: Record<string, boolean> = {}
    listingColumnsArray.forEach(col => {
      preferences[col.column_name] = col.visible
    })
    localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(preferences))
  }
}

const hideableColumns = computed(() => {
  const filtered = listingColumnsArray
    .filter((col) => col.hideable)
    .filter((col) =>
      col.column_name.toLowerCase().includes(searchTerm.value.toLowerCase())
    )
  return filtered
})

onMounted(() => {
  // Load preferences when component mounts
  loadColumnPreferences()
  console.log('hideableColumns: ', hideableColumns.value)
})

const props = defineProps({
  tableViewOptionsSidebarOpen: Boolean,
})
const emit = defineEmits(['toggleTableViewOptionsSidebar'])

function toggleTableViewOptionsSidebar() {
  emit('toggleTableViewOptionsSidebar')
}

function toggleColumn(col: any) {
  setColumnVisibility(col.column_name)
  // switch col visibility in hideableColumns
  hideableColumns.value.forEach((c) => {
    if (c.column_name === col.column_name) {
      c.visible = !c.visible
    }
  })
  // Persist to localStorage after toggle
  saveColumnPreferences()
}

function checkAllColumns() {
  // Set all hideable columns to visible
  listingColumnsArray.forEach((col) => {
    if (col.hideable && !col.visible) {
      // Update store visibility state first
      setColumnVisibility(col.column_name)
      // Then update local visibility
      col.visible = true
    }
  })
  // Persist to localStorage after checking all
  saveColumnPreferences()
}
</script>

<style></style>
