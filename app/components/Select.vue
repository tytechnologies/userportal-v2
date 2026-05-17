<template>
  <div class="relative">
    <label
      v-if="!!$slots['default']"
      :id="id + '-label'"
      :for="id"
      class="mb-2 text-sm font-bold text-foreground"
    >
      <slot></slot>
      <span v-if="required" class="text-red">*</span>
      <FormTooltip v-if="!!tooltip" class="ml-1" :value="tooltip" />
    </label>
    <div class="relative" v-on-clickaway="close">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded="true"
        :aria-labelledby="id + '-label'"
        class="relative ng-1 w-full h-10 leading-9 block rounded-lg text-sm font-bold px-3 pt-0.5 pb-0 text-foreground border"
        :class="classes"
        @click="show = !show"
      >
        <span v-if="!!value" class="block text-left truncate">{{
          selectedText
        }}</span>
        <span v-else class="block text-left truncate text-gray-3">
          <slot></slot>
        </span>
        <span
          class="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none"
        >
          <MenuDown class="w-6 h-6 absolute right-2 top-1.5 text-gray-3" />
        </span>
      </button>
      <transition
        leave-active-class="transition duration-100 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <ul
          class="absolute z-10 w-full py-1 mt-1 overflow-auto text-base bg-card rounded-md shadow-lg max-h-56 focus:outline-none sm:text-sm"
          tabindex="-1"
          role="listbox"
          aria-labelledby="listbox-label"
          v-show="show"
        >
          <li
            v-for="option in formattedOptions"
            :key="option.value"
            class="relative cursor-default select-none hover:bg-muted"
            id="listbox-option-0"
            role="option"
          >
            <button
              type="button"
              class="w-full h-6 px-3 py-2 text-sm font-medium text-left"
            >
              {{ option.text }}
            </button>
          </li>
        </ul>
      </transition>
    </div>
    <!-- <HelperText
      v-if="!errorMessageInvisible"
      invalid
      value="error"
      class="absolute left-3 top-16"
    /> -->
  </div>
</template>

<script>
import FormTooltip from '~/components/FormTooltip'
import HelperText from '~/components/HelperText'
import MenuDown from 'vue-material-design-icons/MenuDown.vue'

export default {
  props: {
    id: {
      type: String,
    },
    value: {
      default: null,
    },
    options: {
      type: Array,
      default: [],
    },
    required: {
      type: Boolean,
      default: false,
    },
    tooltip: {
      type: String,
      default: '',
    },
    error: {
      type: String,
      default: '',
    },
    errorMessageInvisible: {
      type: Boolean,
      default: false,
    },
  },
  components: { FormTooltip, HelperText, MenuDown },
  data() {
    return {
      show: false,
    }
  },
  computed: {
    classes() {
      if (this.error) {
        return 'bg-transparent border-red ring-0'
      }
      if (this.show) {
        return 'bg-transparent border-blue ring-0'
      }
      return 'bg-muted/50 border-border focus-visible:bg-transparent focus-visible:border-blue focus-visible:outline-none'
    },
    formattedOptions() {
      return this.options.map((option) => {
        return typeof option === 'string'
          ? { value: option, text: option }
          : option
      })
    },
    selectedText() {
      for (let i = 0; i < this.formattedOptions.length; i++) {
        if (this.formattedOptions[i].value === this.value) {
          return this.formattedOptions[i].text
        }
      }
      return null
    },
  },
  methods: {
    close() {
      this.show = false
    },
  },
}
</script>
