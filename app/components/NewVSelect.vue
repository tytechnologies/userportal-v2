<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'

const props = defineProps({
  modelValue: {
    type: [String, Number],
    default: '',
  },
  options: {
    type: Array,
    required: true,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  error: {
    type: Boolean,
    default: false,
  },
  onChange: {
    type: Function,
    default: () => {},
  },
  otherSelectOpened: {
    type: Boolean,
    default: false,
  },
  openSelectEvent: {
    type: Function,
    default: () => {},
  },
  searchable: {
    type: Boolean,
    default: true,
  },
})

const emit = defineEmits([
  'update:modelValue',
  'option:selected',
  'onChange',
  'openSelectEvent',
])

const isOpen = ref(false)
const searchQuery = ref('')
const inputRef = ref(null)
const currentLabel = ref('')
const dropdownRef = ref(null)
const selectWrapperRef = ref(null)

function openDropdown() {
  if (props.disabled) return
  isOpen.value = true
  emit('openSelectEvent')
  nextTick(() => {
    inputRef.value?.focus()
    positionDropdown()
  })
}

function closeDropdown() {
  isOpen.value = false
  searchQuery.value = currentLabel.value
}

function selectOption(option) {
  currentLabel.value = option.label
  closeDropdown()
  emit('update:modelValue', option.value)
  emit('option:selected', option)
  emit('onChange', option)
}

function positionDropdown() {
  if (!dropdownRef.value || !inputRef.value) return

  const dropdown = dropdownRef.value
  const input = inputRef.value
  const wrapper = selectWrapperRef.value
  const wrapperRect = wrapper.getBoundingClientRect()
  const viewportHeight = window.innerHeight

  // Position dropdown relative to wrapper
  dropdown.style.position = 'fixed'
  dropdown.style.top = `${wrapperRect.bottom + 4}px`
  dropdown.style.left = `${wrapperRect.left}px`
  dropdown.style.width = `${wrapperRect.width}px`

  // Check if dropdown would go below viewport
  const dropdownRect = dropdown.getBoundingClientRect()
  const bottomSpace = viewportHeight - dropdownRect.bottom

  if (bottomSpace < 0) {
    const newMaxHeight = Math.max(100, dropdownRect.height + bottomSpace - 20)
    dropdown.style.maxHeight = `${newMaxHeight}px`
  }
}

const filteredOptions = computed(() => {
  if (!props.searchable || !searchQuery.value.trim()) return props.options
  return props.options.filter((opt) =>
    opt.label.toLowerCase().includes(searchQuery.value.toLowerCase())
  )
})

function onInputClick() {
  if (!isOpen.value) {
    positionDropdown()
    openDropdown()
    emit('openSelectEvent', true)
  }
}

function onOutsideClick(event) {
  const insideWrapper = event.target.closest('.select-wrapper')
  const insideDropdown = event.target.closest('.select-dropdown')
  if (!insideWrapper && !insideDropdown) {
    closeDropdown()
  }
}

watch(
  () => props.otherSelectOpened,
  (newVal) => {
    if (newVal) {
      closeDropdown()
    }
  }
)

// Sync displayed label when modelValue changes (e.g. parent sets selected value)
watch(
  () => props.modelValue,
  (val) => {
    const option = props.options.find((opt) => opt.value === val)
    if (option) {
      currentLabel.value = option.label
      searchQuery.value = option.label
    }
  },
  { immediate: true }
)

onMounted(() => {
  document.addEventListener('click', onOutsideClick)
  window.addEventListener('resize', positionDropdown)
  window.addEventListener('scroll', positionDropdown, true)
})
</script>

<template>
  <div ref="selectWrapperRef" class="relative w-full select-wrapper">
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
    <div
      class="vs__dropdown-toggle w-full h-10 leading-9 bg-muted/50 rounded-lg text-sm border border-border px-3 pt-0.5 pb-0 flex items-center justify-between"
      :class="{
        'bg-transparent border-blue ring-0': isOpen || error,
        'border-red': error,
        'opacity-50 cursor-not-allowed': disabled,
      }"
    >
      <input
        ref="inputRef"
        v-model="searchQuery"
        type="text"
        class="vs__search font-bold text-foreground placeholder-gray-3 px-0 w-full bg-transparent outline-none"
        :placeholder="!modelValue ? 'Select...' : ''"
        :readonly="!isOpen || !searchable"
        @click.stop="onInputClick"
      />
      <svg
        class="vs__open-indicator ml-2 w-4 h-4 shrink-0"
        :class="{ 'transform-none': isOpen }"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M19 9l-7 7-7-7"
        />
      </svg>
    </div>

    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        class="select-dropdown z-[9999] rounded-lg bg-card shadow-lg border border-border vs__dropdown-menu overflow-hidden"
        style="pointer-events: auto"
      >
        <ul class="max-h-60 overflow-auto py-1">
          <li
            v-for="option in filteredOptions"
            :key="option.value"
            role="option"
            class="vs__dropdown-option text-foreground text-sm font-medium hover:bg-primary/10 px-3 py-2 cursor-pointer select-none"
            :class="{ 'bg-primary/15': option.value === modelValue }"
            @mousedown.prevent="selectOption(option)"
          >
            {{ option.label }}
          </li>
          <li
            v-if="filteredOptions.length === 0"
            class="text-muted-foreground/70 text-sm p-3"
          >
            No results found
          </li>
        </ul>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.transform-none {
  transform: none !important;
}
</style>
