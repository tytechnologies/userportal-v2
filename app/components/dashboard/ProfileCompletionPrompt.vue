<script setup lang="ts">
/**
 * Dashboard nudge to fill in missing profile fields. Hides when the
 * user has both a name and an avatar, OR has dismissed it.
 *
 * Why this matters: an empty profile makes the user appear as "?" in
 * the team panel, in inquiries, in deals — signals "demo product"
 * to a paying brokerage. The nudge lives between the heros and the
 * onboarding checklist so it's the first beat after "set up your
 * brokerage" but before "manage your work."
 */
import { computed, ref, onMounted } from 'vue'
import UiCard from '~/components/ui/UiCard.vue'
import { useUserProfile } from '~/composables/useAuth'

const STORAGE_KEY = 'dashboard.profile_prompt_dismissed_v1'

const { profile } = useUserProfile()
const dismissed = ref(false)

onMounted(() => {
  if (typeof window !== 'undefined') {
    dismissed.value = window.localStorage.getItem(STORAGE_KEY) === '1'
  }
})

function dismiss() {
  dismissed.value = true
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, '1')
  }
}

const missingName = computed(() => {
  const n = (profile.value?.full_name ?? '').trim()
  return n.length === 0
})

const missingAvatar = computed(() => {
  // The default avatar from /api/me may be null OR an empty string.
  // Either counts as missing.
  const a = profile.value?.avatar_url
  return !a || a.trim().length === 0
})

const visible = computed(() => {
  if (!profile.value) return false
  if (dismissed.value) return false
  return missingName.value || missingAvatar.value
})

const promptText = computed(() => {
  if (missingName.value && missingAvatar.value) {
    return 'Add your name and a profile photo so teammates and clients can recognize you.'
  }
  if (missingName.value) {
    return 'Add your full name so it shows up alongside your work.'
  }
  return 'Add a profile photo so your team can recognize you at a glance.'
})
</script>

<template>
  <UiCard
    v-if="visible"
    variant="surface"
    padding="md"
    class="border-warning/30 bg-warning/5"
  >
    <div class="flex items-start gap-3">
      <span
        class="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning"
        aria-hidden="true"
      >
        <span class="text-base">!</span>
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-foreground">Finish your profile</p>
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ promptText }}
        </p>
      </div>
      <div class="flex flex-shrink-0 items-center gap-2">
        <NuxtLink
          to="/my-profile"
          class="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Update profile
        </NuxtLink>
        <button
          type="button"
          class="text-xs text-muted-foreground transition-colors hover:text-foreground"
          @click="dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  </UiCard>
</template>
