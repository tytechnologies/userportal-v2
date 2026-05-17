<script setup lang="ts">
/**
 * My open tasks — dashboard widget.
 *
 * Calls /api/tasks with mine=true + status=open (RLS scopes to the
 * caller). Shows up to 8 most-due rows with relative-due time
 * indicators (overdue / due soon / upcoming). Click navigates to
 * the tasks page; per-row click is deferred (no per-task detail
 * route exists yet).
 *
 * Phase 4: chrome refreshed to match the rest of the dashboard.
 */
import { ref, onMounted, computed } from 'vue'

type Task = {
  id: string
  title: string
  status: string
  priority: string | null
  due_at: string | null
  contact_id: number | null
  listing_id: number | null
  created_at: string
}

const items = ref<Task[]>([])
const total = ref(0)
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Task[]; total: number }>('/api/tasks', {
      query: {
        mine: true,
        status: 'open',
        page_size: 8,
      },
    })
    items.value = res.data ?? []
    total.value = res.total ?? items.value.length
  } catch {
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function dueLabel(due: string | null): { text: string; class: string } {
  if (!due) return { text: 'No due date', class: 'text-muted-foreground' }
  const ms = new Date(due).getTime() - Date.now()
  const days = Math.round(ms / 86_400_000)
  if (ms < 0) return { text: `Overdue ${-days}d`, class: 'text-destructive font-semibold' }
  if (days === 0) return { text: 'Due today', class: 'text-warning font-semibold' }
  if (days <= 3) return { text: `Due in ${days}d`, class: 'text-warning' }
  return { text: `Due in ${days}d`, class: 'text-muted-foreground' }
}

const isEmpty = computed(() => !loading.value && items.value.length === 0)

onMounted(load)
</script>

<template>
  <section
    class="flex h-full flex-col ui-card"
    aria-label="My open tasks"
  >
    <header class="flex items-baseline justify-between border-b border-border px-5 py-4">
      <div>
        <h3 class="text-sm font-semibold text-foreground">My open tasks</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ total.toLocaleString() }} open · assigned to you
        </p>
      </div>
      <NuxtLink to="/tasks" class="text-xs font-semibold text-primary hover:underline">
        View all →
      </NuxtLink>
    </header>

    <div class="flex-1 px-5 py-4">
      <div v-if="loading && items.length === 0" class="space-y-2">
        <div v-for="n in 4" :key="n" class="space-y-1">
          <Skeleton class="h-3 w-3/4" />
          <Skeleton class="h-2 w-1/3" />
        </div>
      </div>

      <EmptyState
        v-else-if="isEmpty"
        variant="success"
        size="compact"
        title="No open tasks"
        description="You're caught up. New tasks will appear here as they're assigned."
      />

      <ul v-else class="space-y-2.5">
        <li v-for="t in items" :key="t.id" class="text-xs">
          <div class="flex items-baseline gap-2">
            <span
              v-if="t.priority === 'urgent' || t.priority === 'high'"
              class="inline-flex shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive"
            >{{ t.priority }}</span>
            <p class="flex-1 truncate text-foreground">{{ t.title }}</p>
          </div>
          <p :class="['mt-0.5', dueLabel(t.due_at).class]">
            {{ dueLabel(t.due_at).text }}
          </p>
        </li>
      </ul>
    </div>
  </section>
</template>
