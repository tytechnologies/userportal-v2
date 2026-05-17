<template>
  <div class="relative">
    <label v-if="!! $slots['default']" :for="id" class="text-sm font-bold text-foreground mb-2">
      <slot></slot> <span v-if="required" class="text-red">*</span>
      <FormTooltip v-if="!! tooltip" class="ml-1 bottom-0.5" :value="tooltip" />
    </label>
    <textarea v-if="textarea" :id="id" v-bind="$attrs" @input="$emit('input', $event.target.value)" :value="value"
      :class="classes"></textarea>
    <template v-else>
      <!-- <t-datepicker v-if="type === 'date'" :variant="!! error ? 'danger' : null" :id="id" v-bind="$attrs" @input="$emit('input', $event)"
                    :required="required" :value="value" :placeholder="datePlaceholder" :user-format="dateFormat" :clearable="false" :class="classes" /> -->
      <input :type="type" :id="id" v-bind="$attrs" @input="$emit('input', $event.target.value)" :required="required"
        :value="value" autocomplete="chrome-off" :class="classes" class="disabled:bg-muted/500">
    </template>
    <HelperText v-if="! errorMessageInvisible" invalid v-model="error"
      :class="`absolute left-3 ${textarea ? 'bottom--1' : 'top-16'}`" />
  </div>
</template>

<script>
  import FormTooltip from "~/components/FormTooltip";
  import HelperText from "~/components/HelperText";

  export default {
    inheritAttrs: false,
    props: {
      id: {
        type: String
      },
      type: {
        type: Number,
        default: 'number'
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
      error: {
        type: String,
        default: ''
      },
      errorMessageInvisible: {
        type: Boolean,
        default: false
      }
    },
    components: { FormTooltip, HelperText },
    computed: {
      classes() {
        return `form-input w-full ${this.textarea ? 'leading-7 pt-2' : 'h-10 leading-9'} block ${!!this.error ? 'border border-red ring-0 mb-1' : 'border bg-muted/50 border-border'} focus:bg-transparent rounded-lg text-sm font-bold px-3 pt-1 pb-0 placeholder-gray-3 text-foreground border border-solid focus-within:border-blue`;
      }, 

      displayValue: {
            get: function() {
                if (this.isInputActive) {
                    // Cursor is inside the input field. unformat display value for user
                    return this.value.toString()
                } else {
                    // User is not modifying now. Format display value for user interface
                    return "$ " + this.value.toFixed(2).replace(/(\d)(?=(\d{3})+(?:\.\d+)?$)/g, "$1,")
                }
            },
            set: function(modifiedValue) {
                // Recalculate value after ignoring "$" and "," in user input
                let newValue = parseFloat(modifiedValue.replace(/[^\d\.]/g, ""))
                // Ensure that it is not NaN
                if (isNaN(newValue)) {
                    newValue = 0
                }
                // Note: we cannot set this.value as it is a "prop". It needs to be passed to parent component
                // $emit the event so that parent component gets it
                this.$emit('input', newValue)
            }
        }      
    }
  }
</script>