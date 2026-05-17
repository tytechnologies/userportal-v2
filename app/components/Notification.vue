<template>
  <li
    class="pt-1.5 pb-0.5 border-b cursor-pointer"
    :class="!notification.is_read && `font-bold`"
    @click="markRead"
  >
    <div class="text-xs">
      <a @click.stop="showPropertyLogs" class="property-url"
        >Property #{{ notification.property_id }}</a
      >
      {{ notification.message }}
    </div>
    <div class="text-xs text-muted-foreground">{{ notification.date }}</div>
  </li>
</template>

<script>
export default {
  props: {
    notification: Object,
  },

  methods: {
    markRead() {
      this.$emit('markAsRead', this.notification.id)
    },

    showPropertyLogs() {
      this.$emit('showPropertyLogs', this.notification.property_id)
    },
  },
}
</script>

<style lang="postcss">
.property-url:hover {
  @apply text-primary;
}
</style>
