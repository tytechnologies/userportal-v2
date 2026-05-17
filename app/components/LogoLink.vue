<template>
  <NuxtLink
    to="/"
    class="flex items-center flex-shrink-0 sm:mr-8"
  >
    <BrandLogo v-if="show" class="h-[4.5rem] w-auto" />
  </NuxtLink>
</template>

<script setup>
// Wraps BrandLogo in a NuxtLink to /. The `show` prop is preserved
// for backwards compat with legacy callers; new code can drop it and
// use BrandLogo directly.
import BrandLogo from '~/components/BrandLogo.vue'

defineProps({
  show: {
    type: Boolean,
    default: true,
  },
})
</script>
