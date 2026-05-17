<script setup lang="ts">
// Reusable tasks panel. Drop on any entity-detail page; pass either
// contactId or listingId (or both) and the panel scopes its feed to
// that entity. RLS gates which rows the API actually returns.
//
// The composer is intentionally inline (vs a modal): faster for the
// "quick note" pattern that tasks-on-detail-pages exists for.

import { computed, onMounted, ref, watch } from 'vue'
import { useTasks, type CrmTask, type TaskPriority } from '~/composables/useTasks'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  contactId?: number | null
  listingId?: number | null
  /** Hide the composer entirely — read-only embed for dashboards etc. */
  readonly?: boolean
}>()

const { listTasks, createTask, updateTask, deleteTask, completeTask } = useTasks()

const tasks = ref<CrmTask[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const showCompleted = ref(false)

const draftTitle = ref('')
const draftDueAt = ref('')
const draftPriority = ref<TaskPriority>('normal')
const isSaving = ref(false)

const visibleTasks = computed(() =>
  showCompleted.value
    ? tasks.value
    : tasks.value.filter(t => t.status !== 'completed' && t.status !== 'cancelled'),
)

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const res = await listTasks({
      contactId: props.contactId ?? undefined,
      listingId: props.listingId ?? undefined,
      pageSize: 100,
    })
    tasks.value = res.data
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load tasks'
  } finally {
    isLoading.value = false
  }
}

async function onCreate() {
  const title = draftTitle.value.trim()
  if (!title) return
  isSaving.value = true
  try {
    const created = await createTask({
      title,
      priority: draftPriority.value,
      due_at: draftDueAt.value ? new Date(draftDueAt.value).toISOString() : null,
      contact_id: props.contactId ?? null,
      listing_id: props.listingId ?? null,
    })
    // Prepend so the new row is visible without a re-sort flicker; full
    // reload would also work but feels janky.
    tasks.value.unshift(created)
    draftTitle.value = ''
    draftDueAt.value = ''
    draftPriority.value = 'normal'
    showToast({ title: 'Task created', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to create task', icon: 'error' })
  } finally {
    isSaving.value = false
  }
}

async function onComplete(t: CrmTask) {
  try {
    const updated = await completeTask(t.id)
    const idx = tasks.value.findIndex(x => x.id === t.id)
    if (idx >= 0) tasks.value[idx] = updated
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to update task', icon: 'error' })
  }
}

async function onReopen(t: CrmTask) {
  try {
    const updated = await updateTask(t.id, { status: 'open' })
    const idx = tasks.value.findIndex(x => x.id === t.id)
    if (idx >= 0) tasks.value[idx] = updated
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to update task', icon: 'error' })
  }
}

async function onDelete(t: CrmTask) {
  if (!confirm(`Delete task "${t.title}"?`)) return
  try {
    await deleteTask(t.id)
    tasks.value = tasks.value.filter(x => x.id !== t.id)
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to delete task', icon: 'error' })
  }
}

function priorityBadge(p: TaskPriority) {
  switch (p) {
    case 'urgent': return 'bg-destructive/15 text-destructive'
    case 'high':   return 'bg-warning/10 text-warning'
    case 'low':    return 'bg-muted text-muted-foreground'
    default:       return 'bg-primary/10 text-primary'
  }
}

function dueLabel(t: CrmTask) {
  if (!t.due_at) return ''
  const d = new Date(t.due_at)
  const now = new Date()
  const overdue = d < now && t.status !== 'completed'
  const txt = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return overdue ? `${txt} · overdue` : txt
}

function dueClass(t: CrmTask) {
  if (!t.due_at) return ''
  const overdue = new Date(t.due_at) < new Date() && t.status !== 'completed'
  return overdue ? 'text-destructive' : 'text-muted-foreground'
}

onMounted(load)
// Reload when the entity context changes (e.g. admin clicking through
// contact detail pages without unmount).
watch(
  () => [props.contactId, props.listingId] as const,
  () => load(),
)
</script>

<template>
  <section class="rounded-xl border border-border bg-background shadow-sm">
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-sm font-semibold text-foreground">
        Tasks
        <span v-if="!isLoading" class="ml-1 text-xs font-normal text-muted-foreground">
          ({{ visibleTasks.length }})
        </span>
      </h2>
      <label class="flex items-center gap-2 text-xs text-muted-foreground">
        <input v-model="showCompleted" type="checkbox" class="h-3 w-3" />
        Show completed
      </label>
    </header>

    <!-- Inline composer -->
    <div v-if="!readonly" class="border-b border-border px-4 py-3">
      <form class="flex flex-wrap gap-2" @submit.prevent="onCreate">
        <input
          v-model="draftTitle"
          type="text"
          placeholder="New task…"
          class="min-w-[12rem] flex-1 rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
          :disabled="isSaving"
        />
        <input
          v-model="draftDueAt"
          type="date"
          class="rounded-md border border-border px-2 py-1.5 text-sm"
          :disabled="isSaving"
        />
        <select
          v-model="draftPriority"
          class="rounded-md border border-border px-2 py-1.5 text-sm"
          :disabled="isSaving"
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
        <button
          type="submit"
          class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          :disabled="!draftTitle.trim() || isSaving"
        >
          Add
        </button>
      </form>
    </div>

    <!-- List -->
    <ul v-if="isLoading" class="divide-y divide-border">
      <li v-for="n in 3" :key="n" class="px-4 py-3">
        <div class="h-3 w-2/3 animate-pulse rounded bg-muted" />
      </li>
    </ul>

    <div v-else-if="errorMessage" class="px-4 py-6 text-center text-sm text-destructive">
      {{ errorMessage }}
    </div>

    <div
      v-else-if="visibleTasks.length === 0"
      class="px-4 py-8 text-center text-sm text-muted-foreground"
    >
      No tasks yet.
    </div>

    <ul v-else class="divide-y divide-border">
      <li
        v-for="t in visibleTasks"
        :key="t.id"
        class="flex items-start gap-3 px-4 py-3"
      >
        <input
          type="checkbox"
          class="mt-1 h-4 w-4 cursor-pointer"
          :checked="t.status === 'completed'"
          :disabled="readonly"
          @change="t.status === 'completed' ? onReopen(t) : onComplete(t)"
        />
        <div class="min-w-0 flex-1">
          <p
            class="text-sm"
            :class="t.status === 'completed' ? 'text-muted-foreground/70 line-through' : 'text-foreground'"
          >
            {{ t.title }}
          </p>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span
              class="rounded-full px-2 py-0.5 font-medium"
              :class="priorityBadge(t.priority)"
            >
              {{ t.priority }}
            </span>
            <span v-if="t.due_at" :class="dueClass(t)">
              Due {{ dueLabel(t) }}
            </span>
          </div>
        </div>
        <button
          v-if="!readonly"
          class="text-xs text-muted-foreground/70 hover:text-destructive"
          title="Delete"
          @click="onDelete(t)"
        >
          ✕
        </button>
      </li>
    </ul>
  </section>
</template>
