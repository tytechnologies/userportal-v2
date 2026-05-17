<script setup lang="ts">
/**
 * My recent inquiries — dashboard widget.
 *
 * Calls /api/inquiries with mine=true (RLS scopes to assignee=me).
 * Defaults to status=new so the widget surfaces actionable backlog;
 * resolved inquiries fall off the list. Shows up to 8 newest.
 *
 * Phase 4: chrome refreshed to match the rest of the dashboard.
 */
import { ref, onMounted, computed } from 'vue'

type Inquiry = {
  id: string
  status: string
  sender_name: string | null
  sender_email: string | null
  message: string | null
  listing_id: number | null
  created_at: string
}

const items = ref<Inquiry[]>([])
const total = ref(0)
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Inquiry[]; total: number }>('/api/inquiries', {
      query: {
        mine: true,
        status: 'new',
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

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const isEmpty = computed(() => !loading.value && items.value.length === 0)

onMounted(load)
</script>

<template>
  <section
    class="flex h-full flex-col ui-card"
    aria-label="My new inquiries"
  >
    <header class="flex items-baseline justify-between border-b border-border px-5 py-4">
      <div>
        <h3 class="text-sm font-semibold text-foreground">My new inquiries</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ total.toLocaleString() }} awaiting your response
        </p>
      </div>
      <NuxtLink to="/inquiries" class="text-xs font-semibold text-primary hover:underline">
        View all →
      </NuxtLink>
    </header>

    <div class="flex-1 px-5 py-4">
      <div v-if="loading && items.length === 0" class="space-y-3">
        <div v-for="n in 4" :key="n" class="space-y-1">
          <div class="flex justify-between">
            <Skeleton class="h-3 w-1/3" />
            <Skeleton class="h-2 w-12" />
          </div>
          <Skeleton class="h-2 w-full" />
        </div>
      </div>

      <EmptyState
        v-else-if="isEmpty"
        variant="success"
        size="compact"
        title="No new inquiries"
        description="You're up to date. New leads will land here as they come in."
      />

      <ul v-else class="space-y-3">
        <li v-for="i in items" :key="i.id" class="text-xs">
          <div class="flex items-baseline justify-between gap-2">
            <p class="truncate font-semibold text-foreground">
              {{ i.sender_name || 'Anonymous' }}
            </p>
            <span class="shrink-0 text-[10px] text-muted-foreground">
              {{ relativeTime(i.created_at) }}
            </span>
          </div>
          <p v-if="i.message" class="line-clamp-2 text-muted-foreground">
            {{ i.message }}
          </p>
        </li>
      </ul>
    </div>
  </section>
</template>
