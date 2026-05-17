<script setup lang="ts">
/**
 * Global error boundary. Renders for ANY unhandled error in the
 * Nuxt app — 404s, 500s, navigation failures, runtime exceptions.
 *
 * Branches by HTTP status so the message matches the actual problem
 * instead of always claiming "Data is missing from the property"
 * (the prior copy, which was misleading on 404s).
 */
import { computed } from 'vue'
import { clearError } from '#app'

const props = defineProps<{
  error: {
    statusCode?: number
    statusMessage?: string
    message?: string
    url?: string
  }
}>()

const status = computed(() => Number(props.error?.statusCode ?? 0))
const isNotFound = computed(() => status.value === 404)
const isServerError = computed(() => status.value >= 500)

const title = computed(() => {
  if (isNotFound.value) return 'Page not found'
  if (isServerError.value) return 'Something went wrong'
  if (status.value >= 400) return props.error?.statusMessage || 'Request failed'
  return 'Something went wrong'
})

const detail = computed(() => {
  if (isNotFound.value) {
    return 'The page you tried to open doesn\'t exist or has been moved. Use the buttons below to get back to a working surface.'
  }
  if (isServerError.value) {
    return 'A server error interrupted that request. We\'re notified — please try again in a moment, or get in touch if it keeps happening.'
  }
  return props.error?.statusMessage || props.error?.message || 'An unexpected error occurred.'
})

async function handleHome() {
  await clearError({ redirect: '/dashboard' })
}

useHead({
  title: computed(() => `${title.value} | Housing Interactive`),
  meta: [{ name: 'robots', content: 'noindex' }],
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
    <div class="w-full max-w-lg text-center">
      <p
        class="font-mono text-sm uppercase tracking-[0.2em] text-muted-foreground"
        aria-hidden="true"
      >
        {{ status || 'Error' }}
      </p>
      <h1 class="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        {{ title }}
      </h1>
      <p class="mx-auto mt-4 max-w-md text-sm text-muted-foreground">
        {{ detail }}
      </p>

      <div class="mt-8 flex flex-col items-center justify-center gap-2 sm:flex-row">
        <button
          type="button"
          class="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          @click="handleHome"
        >
          Go to dashboard
          <span aria-hidden="true">→</span>
        </button>
        <NuxtLink
          to="/help"
          class="inline-flex items-center justify-center rounded-lg border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent/40"
        >
          Get help
        </NuxtLink>
      </div>

      <p
        v-if="error?.url"
        class="mt-6 break-all text-xs text-muted-foreground/70"
      >
        Tried: <span class="font-mono">{{ error.url }}</span>
      </p>
    </div>
  </div>
</template>
