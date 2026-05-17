<script setup lang="ts">
/**
 * Top agents by won deal value over the active dashboard date range.
 *
 * Manager+ only. Self-hides for agents (the endpoint 403s; component
 * also pre-checks via useUserRole to avoid the round-trip + flicker).
 *
 * Each row: rank → avatar → name → primary metric (won ₱) → secondary
 * (won deals · open pipeline · inquiries handled). Primary column is
 * tabular-nums + right-aligned for at-a-glance scanning.
 */
import { computed, onMounted, ref, watch } from 'vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'
import { useDashboardFilter } from '~/composables/useDashboardFilter'
import { useUserRole } from '~/composables/useAuth'

type LeaderboardItem = {
  user_id: string
  full_name: string | null
  avatar_url: string | null
  won_count: number
  won_value: number
  open_count: number
  open_value: number
  inquiries_handled: number
}
type Payload = {
  items: LeaderboardItem[]
  period_from: string
  period_to: string
  currency: string
}

const filter = useDashboardFilter()
const role = useUserRole()

const visible = computed(() => role.value === 'admin' || role.value === 'manager')

const data = ref<Payload | null>(null)
const isLoading = ref(true)
const error = ref<string | null>(null)

async function load() {
  if (!visible.value) {
    isLoading.value = false
    return
  }
  isLoading.value = true
  error.value = null
  try {
    data.value = await $fetch<Payload>('/api/dashboard/agent-leaderboard', {
      query: { from: filter.fromIso.value, to: filter.toIso.value, limit: 5 },
    })
  } catch (err: any) {
    error.value = err?.statusMessage || err?.message || 'Could not load leaderboard'
    data.value = null
  } finally {
    isLoading.value = false
  }
}

onMounted(load)
watch(() => filter.watchKey.value, load)
// Refetch when role resolves from null → admin/manager (avoids
// rendering "you don't have access" before the profile loads).
watch(visible, (v, prev) => {
  if (v && !prev) load()
})

function formatMoney(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '₱0'
  if (n >= 1_000_000_000) return `₱${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `₱${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `₱${(n / 1_000).toFixed(0)}K`
  return `₱${n.toLocaleString()}`
}

function initials(name: string | null): string {
  if (!name) return '?'
  return name
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

const items = computed(() => data.value?.items ?? [])
const hasData = computed(() => items.value.length > 0)
</script>

<template>
  <UiCard v-if="visible" variant="surface" padding="none">
    <header class="flex items-baseline justify-between border-b border-border px-5 py-4">
      <div>
        <h3 class="text-card-title">Top performers</h3>
        <p class="mt-0.5 text-meta">By won deal value · {{ filter.label.value.toLowerCase() }}</p>
      </div>
      <NuxtLink to="/organization" class="text-meta hover:text-foreground">
        View team
      </NuxtLink>
    </header>

    <div v-if="isLoading" class="space-y-2 p-5">
      <div v-for="n in 4" :key="n" class="flex items-center gap-3">
        <UiSkeleton class="h-9 w-9 rounded-full" />
        <div class="flex-1 space-y-1.5">
          <UiSkeleton class="h-3 w-1/2" />
          <UiSkeleton class="h-2 w-2/3" />
        </div>
        <UiSkeleton class="h-4 w-16" />
      </div>
    </div>

    <div v-else-if="error" class="p-5 text-meta text-destructive">
      {{ error }}
    </div>

    <div v-else-if="!hasData" class="p-5 text-meta">
      No closed deals in this window. Pick a longer range or check back as the team closes their first deal.
    </div>

    <ol v-else class="divide-y divide-border">
      <li
        v-for="(row, idx) in items"
        :key="row.user_id"
        class="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-accent/30"
      >
        <span
          :class="[
            'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
            idx === 0 ? 'bg-success text-success-foreground' : 'bg-muted text-muted-foreground',
          ]"
          aria-hidden="true"
        >
          {{ idx + 1 }}
        </span>
        <span class="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground">
          <img
            v-if="row.avatar_url"
            :src="row.avatar_url"
            :alt="row.full_name || 'Agent avatar'"
            class="h-full w-full object-cover"
          />
          <span v-else>{{ initials(row.full_name) }}</span>
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-foreground">
            {{ row.full_name || 'Unnamed agent' }}
          </p>
          <p class="text-meta">
            {{ row.won_count }} won
            <span v-if="row.open_count > 0">· {{ row.open_count }} open ({{ formatMoney(row.open_value) }})</span>
            <span v-if="row.inquiries_handled > 0">· {{ row.inquiries_handled }} inquiry{{ row.inquiries_handled === 1 ? '' : 's' }}</span>
          </p>
        </div>
        <div class="flex-shrink-0 text-right">
          <p class="text-sm font-semibold tabular-nums text-foreground">
            {{ formatMoney(row.won_value) }}
          </p>
          <p class="text-[10px] text-muted-foreground">won</p>
        </div>
      </li>
    </ol>
  </UiCard>
</template>
