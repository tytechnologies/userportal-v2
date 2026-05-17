<script setup lang="ts">
import { ref } from 'vue'
import Bookmark from 'vue-material-design-icons/Bookmark.vue'
import Close from 'vue-material-design-icons/Close.vue'
import Plus from 'vue-material-design-icons/Plus.vue'

const props = defineProps<{
  /** Bucket name; views are persisted per-user under this scope. */
  scope: string
}>()

const { views, save, load, remove, isCurrent } = useSavedViews(props.scope)

const isAdding = ref(false)
const draftName = ref('')

const startAdd = () => {
  draftName.value = ''
  isAdding.value = true
}
const confirmAdd = () => {
  const name = draftName.value.trim()
  if (name) save(name)
  isAdding.value = false
}
const cancelAdd = () => {
  isAdding.value = false
  draftName.value = ''
}
</script>

<template>
  <div class="flex items-center gap-2 flex-wrap">
    <Bookmark :size="16" class="text-muted-foreground" />
    <span class="text-sm font-medium text-muted-foreground mr-1">Saved views:</span>

    <button
      v-for="view in views"
      :key="view.id"
      type="button"
      :class="[
        'group inline-flex items-center gap-1 rounded-full pl-3 pr-1 h-7 text-xs font-medium transition-colors',
        isCurrent(view)
          ? 'bg-primary/10 text-primary'
          : 'bg-muted text-foreground hover:bg-accent',
      ]"
      @click="load(view)"
    >
      <span>{{ view.name }}</span>
      <span
        class="inline-flex h-5 w-5 items-center justify-center rounded-full opacity-50 hover:opacity-100 hover:bg-accent"
        role="button"
        tabindex="-1"
        :aria-label="`Delete view ${view.name}`"
        @click.stop="remove(view.id)"
      >
        <Close :size="12" />
      </span>
    </button>

    <span v-if="views.length === 0" class="text-xs text-muted-foreground italic">
      None yet
    </span>

    <!-- Add view: button → inline name input -->
    <template v-if="!isAdding">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-full px-3 h-7 text-xs font-medium border border-dashed border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
        @click="startAdd"
      >
        <Plus :size="12" />
        Save current view
      </button>
    </template>
    <template v-else>
      <form
        class="inline-flex items-center gap-1 rounded-full pl-2 pr-1 h-7 bg-card border border-border"
        @submit.prevent="confirmAdd"
      >
        <input
          v-model="draftName"
          type="text"
          autofocus
          maxlength="50"
          placeholder="Name this view"
          class="bg-transparent text-xs outline-none w-44 placeholder:text-muted-foreground"
          @keydown.escape="cancelAdd"
        >
        <button
          type="submit"
          class="inline-flex h-5 px-2 items-center justify-center rounded-full text-xs bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Save
        </button>
        <button
          type="button"
          class="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
          aria-label="Cancel"
          @click="cancelAdd"
        >
          <Close :size="12" />
        </button>
      </form>
    </template>
  </div>
</template>
