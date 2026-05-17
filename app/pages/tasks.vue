<script setup lang="ts">
// Global tasks inbox. Lists every task the caller can see (RLS scopes
// it to own/team/all per the role), with filters + inline edit. The
// per-entity panels on contacts/listings still exist for in-context
// composing; this page is the daily-workflow surface.
//
// Filter contracts:
//   - status: 'open'|'in_progress'|'completed'|'cancelled' or 'all'
//   - assigned: 'me' (assignee_user_id = auth.uid()) or 'all'
//   - due: 'overdue' | 'today' | 'week' | 'all'
//
// All filtering happens server-side via useTasks list params (so
// pagination stays correct).

import { computed, onMounted, ref, watch } from 'vue'
import {
  useTasks,
  type CrmTask,
  type TaskPriority,
  type TaskStatus,
} from '~/composables/useTasks'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'

definePageMeta({ layout: 'default' })

const { listTasks, updateTask, completeTask, deleteTask } = useTasks()

type StatusFilter = TaskStatus | 'all'
type AssignedFilter = 'all' | 'me'
type DueFilter = 'all' | 'overdue' | 'today' | 'week'

const statusFilter = ref<StatusFilter>('open')
const assignedFilter = ref<AssignedFilter>('all')
const dueFilter = ref<DueFilter>('all')

const tasks = ref<CrmTask[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const total = ref(0)
const page = ref(1)
const pageSize = 50

// Selected task drives the right-hand edit drawer.
const selectedId = ref<string | null>(null)
const selected = computed(() => tasks.value.find(t => t.id === selectedId.value) ?? null)

// Edit buffers — keep UI responsive while a save is in flight.
const editTitle = ref('')
const editDescription = ref('')
const editDueAt = ref('')
const editPriority = ref<TaskPriority>('normal')
const isSaving = ref(false)

watch(selected, (t) => {
  if (!t) {
    editTitle.value = ''
    editDescription.value = ''
    editDueAt.value = ''
    editPriority.value = 'normal'
    return
  }
  editTitle.value = t.title
  editDescription.value = t.description ?? ''
  editDueAt.value = t.due_at ? t.due_at.slice(0, 10) : ''
  editPriority.value = t.priority
})

function dueWindowToISO(filter: DueFilter): string | undefined {
  if (filter === 'all' || filter === 'overdue') return undefined
  const d = new Date()
  if (filter === 'today') {
    d.setHours(23, 59, 59, 999)
  } else if (filter === 'week') {
    d.setDate(d.getDate() + 7)
    d.setHours(23, 59, 59, 999)
  }
  return d.toISOString()
}

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const res = await listTasks({
      page: page.value,
      pageSize,
      status: statusFilter.value === 'all' ? undefined : statusFilter.value,
      assigned: assignedFilter.value === 'me' ? 'me' : undefined,
      dueBefore: dueWindowToISO(dueFilter.value),
    })
    let rows = res.data
    // 'overdue' isn't expressible as a single dueBefore (we want past
    // dates AND status != completed). Filter client-side.
    if (dueFilter.value === 'overdue') {
      const now = Date.now()
      rows = rows.filter(t => t.due_at && new Date(t.due_at).getTime() < now && t.status !== 'completed')
    }
    tasks.value = rows
    total.value = res.total
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load tasks'
  } finally {
    isLoading.value = false
  }
}

watch([statusFilter, assignedFilter, dueFilter], () => {
  page.value = 1
  load()
})

async function onComplete(t: CrmTask) {
  try {
    const updated = await completeTask(t.id)
    const idx = tasks.value.findIndex(x => x.id === t.id)
    if (idx >= 0) tasks.value[idx] = updated
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to update', icon: 'error' })
  }
}

async function onReopen(t: CrmTask) {
  try {
    const updated = await updateTask(t.id, { status: 'open' })
    const idx = tasks.value.findIndex(x => x.id === t.id)
    if (idx >= 0) tasks.value[idx] = updated
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to update', icon: 'error' })
  }
}

async function onSaveEdit() {
  if (!selected.value) return
  const t = selected.value
  isSaving.value = true
  try {
    const updated = await updateTask(t.id, {
      title: editTitle.value.trim() || t.title,
      description: editDescription.value.trim() || null,
      due_at: editDueAt.value ? new Date(editDueAt.value).toISOString() : null,
      priority: editPriority.value,
    })
    const idx = tasks.value.findIndex(x => x.id === t.id)
    if (idx >= 0) tasks.value[idx] = updated
    showToast({ title: 'Task saved', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to save', icon: 'error' })
  } finally {
    isSaving.value = false
  }
}

async function onDelete(t: CrmTask) {
  if (!confirm(`Delete task "${t.title}"?`)) return
  try {
    await deleteTask(t.id)
    tasks.value = tasks.value.filter(x => x.id !== t.id)
    if (selectedId.value === t.id) selectedId.value = null
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to delete', icon: 'error' })
  }
}

type BadgeVariant = 'primary' | 'warning' | 'destructive' | 'neutral'
function priorityVariant(p: TaskPriority): BadgeVariant {
  switch (p) {
    case 'urgent': return 'destructive'
    case 'high':   return 'warning'
    case 'low':    return 'neutral'
    default:       return 'primary'
  }
}

function dueLabel(t: CrmTask) {
  if (!t.due_at) return ''
  const d = new Date(t.due_at)
  const overdue = d < new Date() && t.status !== 'completed'
  const txt = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return overdue ? `${txt} · overdue` : txt
}

function dueClass(t: CrmTask) {
  if (!t.due_at) return ''
  const overdue = new Date(t.due_at) < new Date() && t.status !== 'completed'
  return overdue ? 'text-destructive font-medium' : 'text-muted-foreground'
}

function entityLabel(t: CrmTask) {
  if (t.contact_id) return `Contact #${t.contact_id}`
  if (t.listing_id) return `Listing #${t.listing_id}`
  return ''
}

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl" data-tour="tasks-table">
    <UiPageHeader
      title="Tasks"
      description="Everything you can see, filtered to your daily workflow."
    >
      <template #actions>
        <UiBadge variant="neutral" size="sm" :dot="true">
          <span class="tabular-nums">{{ total.toLocaleString() }} total</span>
        </UiBadge>
      </template>
    </UiPageHeader>

    <!-- Filter bar -->
    <UiCard padding="sm">
      <div class="flex flex-wrap items-center gap-3 px-1">
        <label class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Status
          <select
            v-model="statusFilter"
            class="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground focus-ring"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Assigned
          <select
            v-model="assignedFilter"
            class="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground focus-ring"
          >
            <option value="all">Anyone</option>
            <option value="me">Me</option>
          </select>
        </label>
        <label class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Due
          <select
            v-model="dueFilter"
            class="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground focus-ring"
          >
            <option value="all">All</option>
            <option value="overdue">Overdue</option>
            <option value="today">Today</option>
            <option value="week">Next 7 days</option>
          </select>
        </label>
      </div>
    </UiCard>

    <!-- Loading: 6-row skeleton matches the actual list rhythm -->
    <UiCard v-if="isLoading" padding="none">
      <div
        v-for="n in 6"
        :key="n"
        class="flex items-start gap-3 border-b border-border px-4 py-3 last:border-0"
      >
        <UiSkeleton class="mt-0.5 h-4 w-4" />
        <div class="flex-1 space-y-1.5">
          <UiSkeleton class="h-3 w-1/2" />
          <div class="flex gap-2">
            <UiSkeleton class="h-4 w-14 rounded-full" />
            <UiSkeleton class="h-3 w-24" />
          </div>
        </div>
      </div>
    </UiCard>

    <UiCard
      v-else-if="errorMessage"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-sm text-destructive"
    >
      {{ errorMessage }}
    </UiCard>

    <!-- Two-pane: list + edit drawer -->
    <div v-else class="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <UiCard padding="none">
        <EmptyState
          v-if="tasks.length === 0"
          variant="success"
          size="cozy"
          title="Nothing on your list right now"
          description="Tasks live on the entity they relate to — open a deal, contact, or listing and add a task from there. Once assigned, they show up here for tracking."
        >
          <template #cta>
            <NuxtLink
              to="/deals"
              class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
            >
              Open deals
            </NuxtLink>
          </template>
        </EmptyState>
        <ul v-else class="divide-y divide-border">
          <li
            v-for="t in tasks"
            :key="t.id"
            class="group relative flex items-start gap-3 px-4 py-3 transition-colors duration-150 ease-out hover:bg-accent/40"
            :class="selectedId === t.id ? 'bg-accent/60' : ''"
          >
            <span
              v-if="selectedId === t.id"
              class="absolute inset-y-1 left-0 w-0.5 rounded-r bg-primary"
              aria-hidden="true"
            />
            <input
              type="checkbox"
              class="mt-1 h-4 w-4 cursor-pointer accent-[hsl(var(--primary))] focus-ring"
              :checked="t.status === 'completed'"
              @change="t.status === 'completed' ? onReopen(t) : onComplete(t)"
              @click.stop
            />
            <button
              type="button"
              class="min-w-0 flex-1 cursor-pointer text-left focus-ring rounded-md"
              @click="selectedId = t.id"
            >
              <p
                class="truncate text-sm"
                :class="t.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'"
              >
                {{ t.title }}
              </p>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <UiBadge :variant="priorityVariant(t.priority)" size="xs">
                  {{ t.priority }}
                </UiBadge>
                <span v-if="t.due_at" :class="dueClass(t)">
                  Due {{ dueLabel(t) }}
                </span>
                <span v-if="entityLabel(t)" class="text-muted-foreground/70">
                  · {{ entityLabel(t) }}
                </span>
              </div>
            </button>
            <button
              type="button"
              class="rounded-md p-1 text-xs text-muted-foreground transition-colors duration-150 ease-out hover:bg-destructive/10 hover:text-destructive focus-ring"
              title="Delete"
              @click.stop="onDelete(t)"
            >
              ✕
            </button>
          </li>
        </ul>
      </UiCard>

      <!-- Edit drawer -->
      <UiCard padding="none" class="self-start">
        <EmptyState
          v-if="!selected"
          variant="neutral"
          size="cozy"
          title="Select a task"
          description="Click any row on the left to view and edit it here."
        />
        <div v-else class="space-y-3 p-5">
          <div>
            <label class="mb-1 block text-xs font-semibold text-foreground/80">
              Title
            </label>
            <input
              v-model="editTitle"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus-ring"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs font-semibold text-foreground/80">
              Description
            </label>
            <textarea
              v-model="editDescription"
              rows="4"
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus-ring"
              placeholder="Add detail…"
            />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="mb-1 block text-xs font-semibold text-foreground/80">
                Due
              </label>
              <input
                v-model="editDueAt"
                type="date"
                class="w-full rounded-md border border-border bg-card px-2 py-2 text-sm text-foreground focus-ring"
              />
            </div>
            <div>
              <label class="mb-1 block text-xs font-semibold text-foreground/80">
                Priority
              </label>
              <select
                v-model="editPriority"
                class="w-full rounded-md border border-border bg-card px-2 py-2 text-sm text-foreground focus-ring"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              class="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring"
              @click="selectedId = null"
            >
              Close
            </button>
            <button
              type="button"
              class="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="isSaving"
              @click="onSaveEdit"
            >
              {{ isSaving ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>
      </UiCard>
    </div>
  </AdminPageShell>
</template>
