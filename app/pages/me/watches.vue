<script setup lang="ts">
/**
 * "My Watches" — the watchlist management page.
 *
 * Lists all watches the user has, grouped by target type. Each row
 * shows the target's resolved name + alert types + last-evaluated
 * timestamp. Edit and delete actions inline.
 */
import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'

type Watch = {
  id: string
  target_type: 'building' | 'city' | 'barangay' | 'broker' | 'developer' | 'organization'
  target_id: string
  alert_types: string[]
  label: string | null
  resolved_label: string
  last_evaluated_at: string | null
  created_at: string
}

definePageMeta({ layout: 'default' })
useHead({ title: 'My Watches | Housinginteractive' })

const watches = ref<Watch[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ watches: Watch[] }>('/api/me/watches')
    watches.value = res.watches ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load watches',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function remove(w: Watch) {
  if (!confirm(`Stop watching "${w.resolved_label}"?`)) return
  try {
    await $fetch(`/api/me/watches/${w.id}`, { method: 'DELETE' })
    showToast({ title: 'Removed from watchlist', icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to remove',
      icon: 'error',
    })
  }
}

async function toggleAlertType(w: Watch, kind: string) {
  const next = w.alert_types.includes(kind)
    ? w.alert_types.filter((k) => k !== kind)
    : [...w.alert_types, kind]
  if (next.length === 0) {
    showToast({ title: 'A watch needs at least one alert type', icon: 'warning' })
    return
  }
  try {
    await $fetch(`/api/me/watches/${w.id}`, {
      method: 'PATCH',
      body: { alert_types: next },
    })
    w.alert_types = next  // optimistic — endpoint already validated
    showToast({ title: 'Alert types updated', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to update',
      icon: 'error',
    })
    await load()  // re-sync from server on error
  }
}

onMounted(load)

const ALERT_TYPES_PER_TARGET: Record<string, string[]> = {
  building:     ['new_listing_in_watch', 'verified_listing'],
  broker:       ['new_listing_in_watch', 'verified_listing'],
  developer:    ['new_listing_in_watch', 'verified_listing'],
  organization: ['new_listing_in_watch', 'verified_listing'],
  city:         ['new_listing_in_watch', 'verified_listing', 'fast_moving_inventory'],
  barangay:     ['new_listing_in_watch', 'verified_listing', 'hot_area'],
}

const grouped = computed(() => {
  const m: Record<string, Watch[]> = {}
  for (const w of watches.value) {
    ;(m[w.target_type] ||= []).push(w)
  }
  return m
})

function formatTs(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const ago = Date.now() - d.getTime()
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000)  return `${Math.round(ago / 60_000)}m ago`
  if (ago < 86_400_000) return `${Math.round(ago / 3_600_000)}h ago`
  return `${Math.round(ago / 86_400_000)}d ago`
}

function alertLabel(kind: string): string {
  return kind.replace(/_/g, ' ')
}
</script>

<template>
  <div class="px-4 py-6 sm:px-6 lg:px-8">
    <header class="mb-6">
      <h1 class="text-page-title">My watches</h1>
      <p class="text-sm text-muted-foreground">
        Get notified when activity happens in places you watch. Up to 50 watches.
        Notifications appear in your bell — never email-spammed.
      </p>
    </header>

    <div v-if="loading" class="rounded-xl border border-border bg-background p-5 text-center text-sm text-muted-foreground">
      Loading…
    </div>

    <div
      v-else-if="watches.length === 0"
      class="rounded-xl border border-dashed border-border bg-muted/50 p-5 text-center text-sm text-muted-foreground"
    >
      <p class="font-semibold">No watches yet.</p>
      <p class="mt-2 text-xs text-muted-foreground">
        Find a building, city, barangay, or broker and click the
        <span class="font-mono">☆ Watch</span> button on its detail page.
      </p>
    </div>

    <div v-else class="space-y-6">
      <section
        v-for="(rows, type) in grouped"
        :key="type"
        class="rounded-xl border border-border bg-background p-4"
      >
        <h2 class="mb-3 text-sm font-semibold capitalize text-foreground">
          {{ type }} ({{ rows.length }})
        </h2>
        <ul class="space-y-2">
          <li
            v-for="w in rows"
            :key="w.id"
            class="rounded-md border border-border bg-muted/40 p-3"
          >
            <div class="flex flex-wrap items-baseline gap-2">
              <p class="text-sm font-semibold text-foreground">{{ w.resolved_label }}</p>
              <p class="text-[10px] text-muted-foreground">
                last checked {{ formatTs(w.last_evaluated_at) }}
              </p>
              <button
                type="button"
                class="ml-auto text-[11px] font-semibold text-destructive hover:underline"
                @click="remove(w)"
              >
                Remove
              </button>
            </div>
            <div class="mt-2 flex flex-wrap gap-1">
              <button
                v-for="kind in ALERT_TYPES_PER_TARGET[w.target_type]"
                :key="kind"
                type="button"
                class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                :class="
                  w.alert_types.includes(kind)
                    ? 'bg-primary/15 text-primary hover:bg-primary/25'
                    : 'bg-muted text-muted-foreground hover:bg-muted'
                "
                :title="
                  w.alert_types.includes(kind)
                    ? 'Click to disable this alert'
                    : 'Click to enable this alert'
                "
                @click="toggleAlertType(w, kind)"
              >
                {{ alertLabel(kind) }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
