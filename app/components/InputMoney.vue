<template>
  <div class="relative">
    <label v-if="!! $slots['default']" :for="id" class="mb-2 text-sm font-bold text-foreground">
      <slot></slot> <span v-if="required" class="text-red">*</span>
      <FormTooltip v-if="!! tooltip" class="bottom-0.5 ml-1" :value="tooltip" />
    </label>
      <input :type="type" :id="id" v-bind="$attrs" :required="required"
         v-model="maskedValue" @input="inputUpdated" autocomplete="chrome-off" :class="classes" class="disabled:bg-muted/500">
    <!-- <HelperText v-if="! errorMessageInvisible" invalid v-model="error"
      :class="`absolute left-3 ${textarea ? 'bottom--1' : 'top-16'}`" /> -->
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import FormTooltip from "~/components/FormTooltip";
import HelperText from "~/components/HelperText";

const props = defineProps({
  id: String,
  textarea: {
    type: Boolean,
    default: false
  },
  type: {
    type: String,
    default: 'text'
  },
  modelValue: {
    type: [String, Number],
    default: 0
  },
  required: {
    type: Boolean,
    default: false
  },
  tooltip: {
    type: String,
    default: ''
  },
  error: {
    type: String,
    default: ''
  },
  errorMessageInvisible: {
    type: Boolean,
    default: false
  },
  updated: {
    type: Function,
    default: () => {}
  }
});

const emit = defineEmits(['updated']);

const formatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0
});

const inputValue = ref(0);
const maskedValue = ref(formatter.format(props.modelValue || 0));

const classes = computed(() => {
  return `form-input w-full ${props.textarea ? 'leading-7 pt-2' : 'h-10 leading-9'} block ${!!props.error ? 'border border-red ring-0 mb-1' : 'border bg-muted/50 border-border'} focus:bg-transparent rounded-lg text-sm font-bold px-3 pt-1 pb-0 placeholder-gray-3 text-foreground border border-solid focus-within:border-blue`;
});

watch(() => props.modelValue, (newValue) => {
  maskedValue.value = formatter.format(newValue || 0);
  inputValue.value = newValue || 0;
});

function maskMoney() {
  // get the numeric value
  inputValue.value = maskedValue.value.toString().length > 0 
    ? parseFloat(maskedValue.value.toString().replace(/,/g, '')) 
    : 0;
  
  // mask back the value
  maskedValue.value = formatter.format(inputValue.value);
}

function inputUpdated() {
  maskMoney();
  emit('updated', inputValue.value);
}
</script>