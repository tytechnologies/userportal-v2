<script setup lang="ts">
/**
 * Dashboard widget — caller's next few viewings.
 *
 * Reads /api/viewings?mine=true&status=scheduled — defaults to a
 * 14-day forward window. Shows the next 5 entries inline; "View all"
 * jumps to /viewings for the full schedule.
 *
 * Self-hides empty rather than rendering a "nothing scheduled" empty
 * state — the dashboard rhythm is "show actionable items, stay calm
 * on quiet days." Brokers with zero upcoming viewings see one fewer
 * widget; the schedule page itself surfaces the empty state with a
 * "schedule from a deal" CTA when they navigate there explicitly.
 */
import { computed, onMounted, ref } from 'vue'

type Viewing = {
  id: string
  scheduled_at: string
  duration_minutes: number
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show'
  deal: {
    id: string
    listing: { id: number; title: string | null } | null
    buyer_contact: { id: number; full_name: string | null } | null
  } | null
}

const viewings = ref<Viewing[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Viewing[] }>('/api/viewings', {
      query: { mine: true, status: 'scheduled', limit: 50 },
    })
    viewings.value = res.data ?? []
  } catch {
    viewings.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Keep only future-or-today viewings, then take the next 5. The
// endpoint defaults to a yesterday tail to surface late entries on
// other surfaces, but the dashboard widget should be strictly forward
// looking — backward-facing follow-ups belong in the activity feed.
const upcoming = computed<Viewing[]>(() => {
  const now = Date.now()
  return viewings.value
    .filter((v) => new Date(v.scheduled_at).getTime() >= now - 60 * 60 * 1000) // 1h tail
    .slice(0, 5)
})

const isEmpty = computed(() => !loading.value && upcoming.value.length === 0)

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(d)
  start.setHours(0, 0, 0, 0)
  const diffDays = Math.round((start.getTime() - today.getTime()) / 86_400_000)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diffDays === 0) return `Today · ${time}`
  if (diffDays === 1) return `Tomorrow · ${time}`
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + time
}

function lineLabel(v: Viewing): string {
  const listing = v.deal?.listing?.title || (v.deal?.listing?.id ? `Listing #${v.deal.listing.id}` : 'Unknown listing')
  const buyer = v.deal?.buyer_contact?.full_name
  return buyer ? `${listing} · ${buyer}` : listing
}
</script>

<template>
  <!-- Self-hide when empty (dashboard rhythm: show actionable, hide quiet) -->
  <section
    v-if="!isEmpty || loading"
    class="rounded-xl border border-border bg-background p-4"
  >
    <header class="mb-3 flex items-baseline justify-between">
      <div>
        <p class="text-sm font-semibold text-foreground">Upcoming viewings</p>
        <p class="text-[11px] text-muted-foreground">
          Your next scheduled property tours.
        </p>
      </div>
      <NuxtLink
        to="/viewings"
        class="text-xs font-medium text-primary hover:underline focus-ring rounded"
      >
        View all →
      </NuxtLink>
    </header>

    <div v-if="loading" class="space-y-2">
      <div
        v-for="n in 3"
        :key="n"
        class="h-12 animate-pulse rounded-md bg-muted-foreground/10"
      />
    </div>

    <ul v-else class="space-y-1.5">
      <li
        v-for="v in upcoming"
        :key="v.id"
        class="rounded-md border border-border bg-card px-3 py-2"
      >
        <NuxtLink
          v-if="v.deal"
          :to="`/deals/${v.deal.id}`"
          class="block text-xs text-foreground hover:text-primary focus-ring rounded"
        >
          <p class="font-semibold tabular-nums">{{ formatTime(v.scheduled_at) }}</p>
          <p class="mt-0.5 truncate text-muted-foreground">
            {{ lineLabel(v) }}
          </p>
        </NuxtLink>
        <div v-else class="text-xs">
          <p class="font-semibold text-foreground tabular-nums">{{ formatTime(v.scheduled_at) }}</p>
          <p class="mt-0.5 truncate text-muted-foreground">{{ lineLabel(v) }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>
