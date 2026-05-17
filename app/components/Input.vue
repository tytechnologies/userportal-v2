<template>
  <div class="relative">
    <label
      v-if="!!$slots['default']"
      :for="id"
      class="mb-1.5 inline-flex items-center gap-1 text-xs font-medium text-foreground"
    >
      <slot /> <span v-if="required && type !== 'email'" class="text-destructive">*</span>
      <FormTooltip v-if="!!tooltip" class="ml-1" :value="tooltip" />
    </label>
    <textarea
      v-if="textarea"
      :id="id"
      v-bind="$attrs"
      @input="updateValue"
      :value="props.forCurrency ? formattedValue : modelValue"
      :class="classes"
    />
    <template v-else>
      <input
        :type="type"
        :id="id"
        v-bind="$attrs"
        @input="updateValue"
        :required="type === 'email' ? false : required"
        :value="props.forCurrency ? formattedValue : modelValue"
        autocomplete="chrome-off"
        :class="[
          classes,
          'disabled:bg-surface-2 disabled:opacity-60 disabled:cursor-not-allowed',
          props.error ? 'border-destructive' : '',
        ]"
        @focus="defaultText()"
      />
    </template>
    <div
      v-if="error && !errorMessageInvisible"
      class="text-destructive text-sm mt-1"
    >
      {{ error }}
    </div>
  </div>
</template>

<script setup lang="ts">
import FormTooltip from '~/components/FormTooltip.vue'
import { formatPrice } from '~/helpers/helpers'
import { computed, watch } from 'vue'

const props = defineProps({
  id: String,
  textarea: {
    type: Boolean,
    default: false,
  },
  type: {
    type: String,
    default: 'text',
  },
  modelValue: {
    type: [String, Number],
    default: '',
  },
  required: {
    type: Boolean,
    default: false,
  },
  tooltip: {
    type: String,
    default: '',
  },
  datePlaceholder: {
    type: String,
    default: 'mm/dd/yyyy',
  },
  dateFormat: {
    type: String,
    default: 'm/d/Y',
  },
  error: {
    type: String,
    default: '',
  },
  errorMessageInvisible: {
    type: Boolean,
    default: false,
  },
  onType: {
    type: Function,
    default: () => {},
  },
  forCurrency: {
    type: Boolean,
    default: false,
  },
  change: Function,
})

const formattedValue = computed(() => {
  if (props.forCurrency) {
    return formatPrice(String(props.modelValue))
  }
  return props.modelValue
})

// Operations palette: solid bg-card, defined input border, primary
// focus ring + 25% subtle ring halo. Tighter h-9 to match the .btn-*
// baseline. font-medium (was font-bold) reads denser without shouting.
const classes = computed(() => {
  const sizing = props.textarea ? 'min-h-[6rem] py-2 leading-relaxed' : 'h-9 leading-9'
  const tone = props.error
    ? 'border border-destructive focus:ring-2 focus:ring-destructive/30'
    : 'border border-input focus:border-primary focus:ring-2 focus:ring-ring/25'
  return `${sizing} block w-full rounded-md bg-card px-3 text-sm font-medium text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:outline-none ${tone}`
})

watch(
  () => props.error,
  (newVal) => {
    console.log('error: ', newVal)
  }
)

const emit = defineEmits(['change', 'update:modelValue'])

const updateValue = (event: Event) => {
  const inputValue = (event.target as HTMLInputElement).value

  if (props.forCurrency) {
    // Remove any non-digit characters and convert to number
    const numericValue = Number(inputValue.replace(/\D/g, ''))
    emit('change', numericValue)
  } else {
    emit('change', inputValue)
  }
}

const defaultText = () => {
  if (props.id == 'landline') {
    emit('update:modelValue', '+632')
  }

  if (props.id == 'mobile') {
    emit('update:modelValue', '+63')
  }
}
</script>
