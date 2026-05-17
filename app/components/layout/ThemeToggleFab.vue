<script setup lang="ts">
/**
 * Floating theme toggle (FAB).
 *
 * The sidebar already exposes a toggle, but the sidebar collapses on
 * narrow viewports and inside dense workflows. This always-visible
 * pill at the bottom-right makes day/night one click from anywhere.
 *
 * Persistence + system-preference fallback come from useTheme().
 *
 * Hidden on mobile narrower than `xs` to avoid covering the bottom
 * tab bar on small screens (they can still toggle via the sidebar
 * once it opens).
 */
import { useTheme } from '~/composables/useTheme'
import WeatherSunny from 'vue-material-design-icons/WeatherSunny.vue'
import WeatherNight from 'vue-material-design-icons/WeatherNight.vue'

const { theme, toggleTheme } = useTheme()
</script>

<template>
  <button
    type="button"
    aria-label="Toggle day / night theme"
    :title="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
    class="fixed bottom-4 right-4 z-40 hidden h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-lg transition-colors hover:bg-accent hover:text-accent-foreground sm:flex"
    @click="toggleTheme"
  >
    <WeatherSunny v-if="theme === 'dark'" :size="20" />
    <WeatherNight v-else :size="20" />
  </button>
</template>
