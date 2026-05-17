<template>
  <!-- <div class="relative">
    <label v-if="!! $slots['default']" :for="id" class="mb-2 text-sm font-bold text-foreground">
      <slot></slot> <span v-if="required" class="text-red">*</span>
      <FormTooltip v-if="!! tooltip" class="ml-1 bottom-0.5" :value="tooltip" />
    </label>
    <HelperText v-if="! errorMessageInvisible" invalid v-model="error"
      :class="`absolute left-3 ${textarea ? 'bottom--1' : 'top-16'}`" />
  </div> -->
</template>
<!-- 
<script>
  import FormTooltip from "~/components/FormTooltip";
  import HelperText from "~/components/HelperText";

  export default {
    inheritAttrs: false,
    props: {
      id: {
        type: String
      },
      textarea: {
        type: Boolean,
        default: false
      },
      type: {
        type: String,
        default: 'text'
      },
      value: {
        type: [String, Number],
        default: ''
      },
      required: {
        type: Boolean,
        default: false
      },
      tooltip: {
        type: String,
        default: ''
      },
      datePlaceholder: {
        type: String,
        default: 'mm/dd/yyyy'
      },
      dateFormat: {
        type: String,
        default: 'm/d/Y'
      },
      error: {
        type: String,
        default: ''
      },
      errorMessageInvisible: {
        type: Boolean,
        default: false
      },
      options: {
        type: Object,
        default: {}
      }
    },
    components: { FormTooltip, HelperText },
    computed: {
      classes() {
        return `form-input w-full ${this.textarea ? 'leading-7 ' : 'h-10 leading-9'} block ${!!this.error ? 'bg-transparent border-red ring-0' : 'bg-muted/50 border-border'} focus:bg-transparent rounded-lg text-sm font-bold px-3 pt-1 pb-0 placeholder-gray-3 text-foreground `;
      }
    }
  }
</script> -->