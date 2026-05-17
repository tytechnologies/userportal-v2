<template>
  <div class="relative">
    <label v-if="label" :for="id" class="mb-2 text-sm font-bold text-foreground">
      {{ label }}
      <span v-if="required" class="text-red">*</span>
    </label>

    <div
      class="relative w-full h-10 bg-muted/50 rounded-lg text-sm border border-border px-3 pt-0.5 pb-0 cursor-pointer"
      :class="{ 'border-blue': isOpen }"
      @click="toggleDropdown"
    >
      <input
        :id="id"
        type="text"
        v-model="searchText"
        :placeholder="placeholder"
        @input="handleSearch"
        class="w-full h-full bg-transparent outline-none font-bold text-foreground placeholder-gray-3"
      />
      <MenuDown class="absolute top-1.5 right-2 w-6 h-6 text-muted-foreground/70" />

      <!-- Error message -->
      <span v-if="errorsActive" class="text-red text-xs"
        >This field is required</span
      >
    </div>

    <!-- Dropdown Menu -->
    <slot />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import MenuDown from 'vue-material-design-icons/MenuDown.vue'

const props = defineProps({
  id: {
    type: String,
    default: '',
  },
  modelValue: {
    type: [String, Number],
    default: null,
  },
  label: {
    type: String,
    default: '',
  },
  required: {
    type: Boolean,
    default: false,
  },
  placeholder: {
    type: String,
    default: 'Select an option',
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  options: {
    type: Array,
    default: () => [],
  },
  labelKey: {
    type: String,
    default: 'name',
  },
  valueKey: {
    type: String,
    default: 'id',
  },
  filterOptions: {
    type: Function,
    default: () => [],
  },
  noDropdown: {
    type: Boolean,
    default: false,
  },
  setNoDropdown: {
    type: Function,
    default: () => {},
  },
  valueSelected: {
    type: Boolean,
    default: false,
  },
  errorsActive: {
    type: Boolean,
    default: false,
  },
  // Add new prop for free text mode
  freeText: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'update:modelValue',
  'filterOptions',
  'setNoDropdown',
])

const searchText = ref('')
const selectedOption = ref(null)

const filteredOptions = computed(() => {
  if (!searchText.value) return props.options

  return props.options.filter((option) =>
    option[props.labelKey]
      .toLowerCase()
      .includes(searchText.value.toLowerCase())
  )
})

const handleSearch = () => {
  if (props.freeText) {
    // In free text mode, update modelValue directly
    emit('update:modelValue', searchText.value)
  } else {
    // In dropdown mode, emit filterOptions
    emit('filterOptions', searchText.value)
  }
}

const selectOption = (option) => {
  selectedOption.value = option
  searchText.value = option[props.labelKey]
  emit('update:modelValue', option[props.valueKey])
}

const toggleDropdown = () => {
  if (!props.disabled && !props.freeText) {
    emit('setNoDropdown', !props.noDropdown)
  }
}

const handleClickOutside = (event) => {
  if (!event.target.closest('.relative')) {
    emit('setNoDropdown', false)
  }
}

// Set initial value if exists
watch(
  () => props.modelValue,
  (newValue) => {
    if (newValue) {
      searchText.value = props.modelValue
    }
  },
  { immediate: true }
)

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>
