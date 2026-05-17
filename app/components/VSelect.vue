<template>
  <div class="relative w-full" :class="{ 'v-select--invalid': !!error }">
    <label
      v-if="$slots.default"
      :id="id + '-label'"
      :for="id"
      class="mb-2 text-sm font-bold text-foreground"
    >
      <slot />
      <span v-if="required" class="text-red">*</span>
      <FormTooltip v-if="tooltip" class="ml-1" :value="tooltip" />
    </label>

    <v-select
      v-bind="$attrs"
      v-on="$attrs"
      :value="value"
      :autocomplete="$attrs.autocomplete || 'chrome-off'"
      :taggable="!onlyFromOptions"
      :create-option="(option) => option"
      :calculate-position="calculateDropdownPosition"
      append-to-body
    >
      <template #no-options="{ search, searching, loading }">
        <span class="text-sm italic">
          {{
            $attrs.search
              ? 'Type anything to search'
              : 'Sorry, there are no options available'
          }}
        </span>
      </template>
      <template #open-indicator="{ attributes }">
        <MenuDown
          class="absolute top-1.5 right-2 w-6 h-6 cursor-pointer"
          :class="$attrs.disabled ? 'text-muted-foreground/50' : 'text-gray-3'"
        />
      </template>
    </v-select>
    <HelperText
      v-if="!errorMessageInvisible"
      invalid
      :value="error"
      class="absolute left-3 top-16"
    />
  </div>
</template>

<script setup>
import 'vue-select/dist/vue-select.css'
import FormTooltip from '~/components/FormTooltip'
import HelperText from '~/components/HelperText'
import MenuDown from 'vue-material-design-icons/MenuDown.vue'
import vSelect from 'vue-select'

const props = defineProps({
  id: {
    type: String,
    default: '',
  },
  value: {
    type: [String, Number],
    default: null,
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
  onlyFromOptions: {
    type: Boolean,
    default: true,
  },
})

// Function to calculate dropdown position and flip it if needed
const calculateDropdownPosition = (dropdownList, component, { width }) => {
  const inputRect = component.$refs.toggle.getBoundingClientRect()
  const windowHeight = window.innerHeight
  const dropdownHeight = 300 // Approximate max height of dropdown
  const spaceBelow = windowHeight - inputRect.bottom
  const spaceAbove = inputRect.top
  
  // Determine if dropdown should open upward
  const shouldOpenUpward = spaceBelow < dropdownHeight && spaceAbove > spaceBelow
  
  // Set the dropdown width to match the input
  dropdownList.style.width = width
  
  if (shouldOpenUpward) {
    // Position dropdown above the input
    dropdownList.style.top = 'auto'
    dropdownList.style.bottom = `${windowHeight - inputRect.top}px`
    dropdownList.style.left = `${inputRect.left}px`
    dropdownList.style.maxHeight = `${Math.min(spaceAbove - 10, 300)}px`
  } else {
    // Position dropdown below the input (default)
    dropdownList.style.top = `${inputRect.bottom}px`
    dropdownList.style.bottom = 'auto'
    dropdownList.style.left = `${inputRect.left}px`
    dropdownList.style.maxHeight = `${Math.min(spaceBelow - 10, 300)}px`
  }
  
  return dropdownList
}

// const emit = defineEmits(['update:value'])
// const { value } = toRefs(props)
// const internalValue = ref(value.value)

// const attrs = useAttrs()

// watch(
//   () => props.value,
//   (newValue) => {
//     internalValue.value = newValue
//   }
// )

// watch(internalValue, (newValue) => {
//   emit('update:value', newValue)
// })
</script>

<style lang="postcss">
.vs__dropdown-toggle {
  @apply w-full h-10 leading-9 bg-muted/50 rounded-lg text-sm border border-border px-3 pt-0.5 pb-0;
}

.vs__search,
.vs__search:focus {
  @apply font-bold text-foreground placeholder-gray-3 px-0;
}

.vs--open .vs__dropdown-toggle,
.v-select--invalid .vs__dropdown-toggle {
  @apply bg-transparent border-blue ring-0;
}

.v-select--invalid .vs__dropdown-toggle {
  @apply border-red;
}

.vs--open .vs__open-indicator {
  transform: none;
}

.vs--disabled .vs__search {
  @apply placeholder-black-10;
}

.vs__selected {
  @apply font-bold text-foreground mx-0 px-0;
}

.vs__dropdown-menu {
  @apply shadow-lg border-border;
  position: fixed !important;
  z-index: 9999;
  overflow-y: auto;
}

.vs__dropdown-option {
  @apply text-foreground text-sm font-medium hover:bg-muted;
}

.vs__dropdown-option--highlight {
  @apply text-foreground bg-muted;
}
</style>
