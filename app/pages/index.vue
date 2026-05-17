<script setup lang="ts">
// Bare root route. Authenticated users land here when they hit `/`;
// without this redirect, no route matches `/` and Nuxt's default
// welcome page renders, blocking entry to the actual app.
//
// Unauthenticated users never reach this page — auth.global.ts
// middleware redirects them to /login first.
//
// Server-side guard so the redirect happens before any HTML is shipped;
// no client-render flash of the empty template.
if (import.meta.server) {
  await navigateTo('/dashboard', { replace: true, redirectCode: 302 })
} else {
  navigateTo('/dashboard', { replace: true })
}
</script>

<template>
  <!-- Empty body — the redirect runs in setup. -->
</template>
