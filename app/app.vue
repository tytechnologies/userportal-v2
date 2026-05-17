<script setup lang="ts">
// vue-sonner v1.x bundles its styles with the component — no separate CSS import.
import { Toaster } from 'vue-sonner'
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <Toaster
    position="bottom-right"
    rich-colors
    close-button
    :duration="4000"
  />
  <ConfirmDialog />
  <!-- Phase-2 ⌘K / Ctrl+K palette. Mounted once at app root so it can
       teleport its overlay above any page-level modal. The component
       installs the global hotkey listener on its own onMounted. -->
  <CommandPalette />
</template>
