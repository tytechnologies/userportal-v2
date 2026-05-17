<template>
  <div
    class="relative inline-block w-full min-w-[14vw] mt-1 mb-2 mr-2 t ext-left sm:mb-0 md:mb-0 lg:mb-0"
    v-on-clickaway="close"
  >
    <button
      type="button"
      aria-expanded="true"
      aria-haspopup="true"
      @click="show = !show"
      class="flex w-full h-8 px-4 pt-1.5 pb-1 text-sm justify-between font-bold text-foreground focus:outline-none whitespace-nowrap rounded-lg border border-border"
      :class="value !== null ? 'bg-blue text-white' : 'bg-card'"
    >
      <span v-if="selectedText" class="mr-4 text-[.8vw]">{{
        selectedText
      }}</span>
      <span v-else class="mr-4">{{ label }}</span>
      <span class="relative bottom-1">
        <SortVariant class="w-6 h-6" />
      </span>
    </button>
    <transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="transform scale-95 opacity-0"
      enter-to-class="transform scale-100 opacity-100"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="transform scale-100 opacity-100"
      leave-to-class="transform scale-95 opacity-0"
    >
      <div
        class="absolute right-0 z-20  w-48 mt-2 origin-top-right bg-card rounded-md shadow-lg focus:outline-none"
        role="menu"
        aria-orientation="vertical"
        aria-labelledby="menu-button"
        tabindex="-1"
        v-show="show"
      >
        <ul class="py-1" role="none">
          <li
            v-for="option in formattedOptions"
            :key="option.value"
            class="pt-1.5 pb-0.5 hover:bg-muted"
          >
            <button
              type="button"
              class="w-full h-6 px-3 text-sm font-medium text-left"
              @click="handleOptionClick(option)"
            >
              {{ option.label }}
            </button>
          </li>
        </ul>
      </div>
    </transition>
  </div>
</template>

<script>
import SortVariant from 'vue-material-design-icons/SortVariant.vue'

export default {
  props: {
    value: {
      type: [Number, String],
      default: null,
    },
    options: {
      type: Array,
      default: null,
    },
    label: {
      type: String,
      default: 'All',
    },
    withAction: {
      type: Boolean,
      default: false,
    },
  },
  components: { SortVariant },
  emits: ['action'],
  data() {
    return {
      show: false,
      selectedText: null,
    }
  },
  computed: {
    formattedOptions() {
      console.log('this.options: ', this.options)
      return this.options.map((option) => {
        return typeof option.label === 'string'
          ? { value: option.value, label: option.label }
          : option
      })
    },
  },
  methods: {
    close() {
      this.show = false
    },
    handleAllClick() {
      this.$emit('input', null)
      this.close()

      if (this.withAction) {
        this.$emit('action', 'all')
      }
    },
    handleOptionClick(option) {
      console.log('option: ', option)
      this.selectedText = option.label

      if (this.withAction) {
        this.$emit('action', option.value)
      }
      this.close()
    },
  },
}
</script>
