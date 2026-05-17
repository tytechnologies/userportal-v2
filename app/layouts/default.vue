<script setup lang="ts">
import { ref, watch } from 'vue'
import { useOnboardingTourStore } from '~/store/onboardingTour'

// Auth-redirecting is handled by app/middleware/auth.global.ts. Auth pages
// (login/register/forgot-password) opt into layouts/auth.vue via
// definePageMeta and don't reach this layout.
const user = useSupabaseUser()
const loading = ref(true)

// First-sign-in product tour. The store reads profiles.onboarding_
// completed_at and self-activates if NULL. Idempotent per session
// (`checked` flag) so re-renders / route changes don't re-fire the
// auto-start check.
const onboardingTour = useOnboardingTourStore()

watch(user, (u) => {
  loading.value = false
  if (u?.id && import.meta.client) {
    onboardingTour.maybeAutoStart(u.id).catch((err) =>
      console.warn('[onboarding] auto-start failed:', err),
    )
  }
}, { immediate: true })
</script>

<template>
  <div v-if="loading" class="flex h-screen items-center justify-center bg-background">
    <Skeleton class="h-4 w-32" />
  </div>
  <div v-else class="flex min-h-screen bg-background text-foreground">
    <AppSidebar data-tour="sidebar-nav" />
    <div class="flex-1 flex flex-col min-w-0">
      <Navbar />
      <main class="flex-1 overflow-x-hidden">
        <slot />
      </main>
    </div>
    <ThemeToggleFab />
    <OnboardingTour />
  </div>
</template>
