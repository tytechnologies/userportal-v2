<template>
  <div class="relative">
    <label
      v-if="!!$slots['default']"
      :for="id"
      class="mb-2 text-sm font-bold text-foreground"
    >
      <slot /> <span v-if="required" class="text-red">*</span>
      <FormTooltip v-if="!!tooltip" class="ml-1 bottom-0.5" :value="tooltip" />
    </label>
    <textarea
      v-if="textarea"
      :id="id"
      v-bind="$attrs"
      @input="updateValue(($event.target as HTMLTextAreaElement).value)"
      :value="modelValue"
      :class="classes"
    />
    <template v-else>
      <input
        :type="type"
        :id="id"
        v-bind="$attrs"
        @input="updateValue(($event.target as HTMLInputElement).value)"
        :required="required"
        :value="modelValue"
        autocomplete="chrome-off"
        :class="classes"
        class="disabled:bg-muted/500"
        @focus="defaultText()"
      />
    </template>
    <!-- <HelperText
      v-if="!errorMessageInvisible"
      invalid
      v-model="error"
      :class="`absolute left-3 ${textarea ? 'bottom--1' : 'top-16'}`"
    /> -->
    <HelperText
      v-if="!errorMessageInvisible"
      :invalid="true"
      :error="error"
      :class="`absolute left-3 ${textarea ? 'bottom--1' : 'top-16'}`"
    />
  </div>
</template>

<script setup lang="ts">
import FormTooltip from '~/components/FormTooltip.vue'
import HelperText from '~/components/HelperText.vue'

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
})

const classes = computed(() => {
  return `form-input w-full ${
    props.textarea ? 'leading-7 pt-2' : 'h-10 leading-9'
  } block ${
    !!props.error
      ? 'border border-red ring-0 mb-1'
      : 'border bg-muted/50 border-border'
  } focus:bg-transparent rounded-lg text-sm font-bold px-3 pt-1 pb-0 placeholder-gray-3 text-foreground border border-solid focus-within:border-blue`
})

const emit = defineEmits(['update:modelValue'])

const updateValue = (value: string | number) => {
  emit('update:modelValue', value)
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
