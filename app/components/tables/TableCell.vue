
<template>
  <span :class="classes" v-on="$listeners">{{ value }}</span>
</template>

<script>
export default {
  props: {
    value: {
      type: [String, Number]
    },
    isLink: {
      type: Boolean,
      default: false
    }
  },
  computed: {
    classes() {
      return this.isLink
        ? 'relative bottom-0.5 inline-block mx-3 text-xs text-primary px-2 pt-1 cursor-pointer'
        : 'inline-block mx-3 text-xs text-foreground';
    }
  }
}
</script>
