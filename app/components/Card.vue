<template>
  <div
    class="p-6 rounded-lg shadow-lg bg-card overflow-auto"
    :class="`h-${height}`"
  >
    <h5 class="text-foreground text-xl leading-tight font-medium mb-2">
      {{ cardTitle }}
      <slot v-if="show" name="button"></slot>
    </h5>
    <slot name="body_content"></slot>
  </div>
</template>

<script>
export default {
  props: {
    height: {
      type: Number,
      default: 96,
    },
    cardTitle: {
      type: String,
    },
    body: {
      type: String,
    },
    show: {
      type: Boolean,
      default: false,
    },
  },
}
</script>