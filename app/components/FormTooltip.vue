<script>
/**
 * FormTooltip — info-icon hover tooltip used in form labels
 * (Operations palette).
 *
 * Solid bordered popover, controlled two-layer shadow (no glow).
 * Shows on mouseover, hides on mouseleave. Click also toggles for
 * touch UX.
 */
import InformationOutline from 'vue-material-design-icons/InformationOutline.vue';

export default {
  props: ['value'],
  components: { InformationOutline },
  data() {
    return {
      show: false
    }
  }
}
</script>

<style lang="postcss">
  .form-tooltip {
    .material-design-icon__svg {
      @apply inline;
    }
  }
</style>

<template>
  <div class="form-tooltip relative inline cursor-pointer text-muted-foreground hover:text-foreground">
    <InformationOutline :size="14" @mouseover="show = true" @mouseleave="show = false" />
    <transition
      enter-active-class="transition ease-out duration-100"
      enter-from-class="transform opacity-0 scale-95"
      enter-to-class="transform opacity-100 scale-100"
      leave-active-class="transition ease-in duration-75"
      leave-from-class="transform opacity-100 scale-100"
      leave-to-class="transform opacity-0 scale-95"
    >
      <div
        v-show="show"
        class="origin-top-left absolute left-0 mt-2 w-64 rounded-md border border-border-strong bg-card text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-8px_rgba(15,23,42,0.16)] focus:outline-none z-10"
        role="menu"
        aria-orientation="vertical"
        aria-labelledby="menu-button"
        tabindex="-1"
      >
        <p class="text-xs leading-relaxed m-3">{{ value }}</p>
      </div>
    </transition>
  </div>
</template>
