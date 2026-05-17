<script setup lang="ts">
// Notification preferences page. One row per kind in the catalog; each
// has an Email toggle. Push/SMS columns are reserved (the schema has
// them) but not surfaced until those channels exist.
//
// Default behavior is opt-in (email_enabled=true) when no row exists;
// flipping the toggle UPSERTs the row so the next notify() respects it.

import { computed, onMounted, ref } from 'vue'
import {
  useNotificationPreferences,
  NOTIFICATION_KINDS,
  type NotificationPref,
} from '~/composables/useNotificationPreferences'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Notification settings | Housing Interactive' })

const { listPrefs, upsertPref } = useNotificationPreferences()

const prefs = ref<NotificationPref[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const savingKind = ref<string | null>(null)

// Map view: kind → email_enabled (effective). Missing row defaults true.
const emailEnabled = computed<Record<string, boolean>>(() => {
  const map: Record<string, boolean> = {}
  for (const k of NOTIFICATION_KINDS) map[k.value] = true
  for (const p of prefs.value) map[p.kind] = p.email_enabled
  return map
})

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    prefs.value = await listPrefs()
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Failed to load preferences.'
  } finally {
    isLoading.value = false
  }
}
onMounted(load)

async function toggleEmail(kind: string, next: boolean) {
  savingKind.value = kind
  try {
    const updated = await upsertPref({ kind, email_enabled: next })
    const idx = prefs.value.findIndex((p) => p.kind === kind)
    if (idx >= 0) prefs.value[idx] = updated
    else prefs.value.push(updated)
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Failed to save preference', icon: 'error' })
  } finally {
    savingKind.value = null
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl p-4">
    <header class="mb-6">
      <h1 class="text-xl font-bold text-foreground">Notification settings</h1>
      <p class="text-sm text-muted-foreground">
        In-app notifications always show in the bell. Toggles below control whether
        you also get an email when one fires.
      </p>
    </header>

    <div v-if="isLoading" class="rounded-xl border border-border bg-background p-8 text-center text-sm text-muted-foreground/70">
      Loading…
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </div>

    <ul v-else class="divide-y divide-border rounded-xl border border-border bg-card shadow-sm">
      <li
        v-for="k in NOTIFICATION_KINDS"
        :key="k.value"
        class="flex items-start justify-between gap-4 px-4 py-3"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-foreground">{{ k.label }}</p>
          <p class="text-xs text-muted-foreground">{{ k.description }}</p>
        </div>
        <label class="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
          <span class="text-muted-foreground">Email</span>
          <input
            type="checkbox"
            class="h-4 w-4 cursor-pointer"
            :checked="emailEnabled[k.value]"
            :disabled="savingKind === k.value"
            @change="toggleEmail(k.value, ($event.target as HTMLInputElement).checked)"
          />
          <span v-if="savingKind === k.value" class="text-[10px] text-muted-foreground/70">saving…</span>
        </label>
      </li>
    </ul>
  </div>
</template>
