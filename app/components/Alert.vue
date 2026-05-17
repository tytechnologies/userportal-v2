
<template>
  <div class="fixed z-10 inset-0 overflow-y-auto" role="dialog" aria-modal="true" v-show="value">
    <div class="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
      <transition
        enter-active-class="ease-out duration-300"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="ease-in duration-200"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div class="fixed inset-0 bg-foreground/55 transition-opacity" aria-hidden="true" v-show="value"></div>
      </transition>

      <!-- This element is to trick the browser into centering the modal contents. -->
      <span class="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

      <transition
        enter-active-class="ease-out duration-300"
        enter-from-class="translate-y-4 sm:translate-y-0 sm:scale-95"
        enter-to-class="opacity-100 translate-y-0 sm:scale-100"
        leave-active-class="ease-in duration-200"
        leave-from-class="opacity-100 translate-y-0 sm:scale-100"
        leave-to-class="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
      >
        <div class="hi-modal inline-block align-bottom bg-card rounded-lg text-left overflow-hidden transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full" v-show="value">
          <div class="bg-card px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <div class="sm:flex sm:items-start">
              <span v-if="icon === 'danger'" class="text-red">
                <AlertCircle class="opacity-inherit" :size="32" />
              </span>
              <div class="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                <h3 class="text-lg leading-6 font-medium">{{ title }}</h3>
                <div class="mt-2">
                  <p class="text-sm">{{ content }}</p>
                </div>
              </div>
            </div>
          </div>
          <div class="bg-muted/30 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
            <button type="button" class="w-full inline-flex justify-center rounded-md border-transparent shadow-sm px-4 pt-1.5 pb-1 text-base font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-destructive sm:ml-3 sm:w-auto sm:text-sm"
              :class="computedConfirmButtonClass" @click="ok">
              {{ confirmButtonText }}
            </button>
            <button type="button" class="mt-3 w-full inline-flex justify-center rounded-md border-border shadow-sm px-4 pt-1.5 pb-1 text-base font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
              :class="cancelButtonClass" @click="cancel">
              {{ cancelButtonText }}
            </button>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<script>
import AlertCircle from 'vue-material-design-icons/AlertCircle.vue';

export default {
  props: {
    value: {
      type: Boolean,
      default: false
    },
    icon: {
      type: String,
      default: '',
    },
    title: {
      type: String,
      default: ''
    },
    content: {
      type: String,
      default: ''
    },
    confirmButtonText: {
      type: String,
      default: 'OK'
    },
    confirmButtonClass: {
      type: String,
      default: ''
    },
    cancelButtonText: {
      type: String,
      default: 'Cancel'
    },
    cancelButtonClass: {
      type: String,
      default: 'bg-card hover:bg-muted'
    }
  },
  components: { AlertCircle },
  computed: {
    computedConfirmButtonClass() {
      if (this.confirmButtonClass) {
        return this.confirmButtonClass;
      }

      if (this.icon === 'success') {
        return 'bg-green hover:bg-green-dark';
      }

      if (this.icon === 'danger') {
        return 'bg-destructive';
      }

      return 'bg-primary hover:bg-primary/90';
    }
  },
  methods: {
    close() {
      this.$emit('input', false);
    },
    ok() {
      this.close();
      this.$emit('ok');
    },
    cancel() {
      this.close();
      this.$emit('cancel');
    }
  }
}
</script>
