<script setup lang="ts">
// Minimal layout for unauthenticated pages (login, register, forgot-password).
// No nav, no sidebar, no chrome — pages render full-bleed with their own
// hero/marketing layout if they choose.
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <slot />
  </div>
</template>
