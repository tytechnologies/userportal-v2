<script setup lang="ts">
/**
 * Back-compat shim for the legacy hand-rolled modal (Operations palette).
 * Internally uses radix-vue's Dialog primitives so consumers automatically get:
 *   - focus trap
 *   - escape-to-close
 *   - body scroll lock
 *   - role="dialog" + aria-modal
 *   - click-outside-to-close
 *
 * Public API (unchanged from the old Modal.vue):
 *   <Modal ref="modal" title="..." width="sm:max-w-3xl"> ...slot... </Modal>
 *   modal.value?.toggleModal()
 *
 * New code should adopt UiModal directly — it's the canonical centered
 * overlay primitive with proper sticky-header / sticky-footer + slot
 * structure. This shim exists to preserve back-compat with a few dozen
 * callers that haven't been migrated yet.
 *
 * Visual treatment matches UiModal: opaque card surface, defined
 * border-strong, calm slate scrim, controlled two-layer shadow.
 */
import { ref } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogClose,
} from 'radix-vue'
import Close from 'vue-material-design-icons/Close.vue'

const props = withDefaults(
  defineProps<{
    title?: string
    /**
     * Tailwind max-width utility applied to the dialog box. Restricted
     * historically to a few presets; kept for back-compat.
     */
    width?: string
  }>(),
  {
    title: '',
    width: 'sm:max-w-3xl',
  },
)

const isOpen = ref(false)

const toggleModal = () => {
  isOpen.value = !isOpen.value
}

defineExpose({ toggleModal })
</script>

<template>
  <DialogRoot v-model:open="isOpen">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-[9998] bg-foreground/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogContent
        :class="[
          'fixed left-1/2 top-1/2 z-[9999] grid w-full -translate-x-1/2 -translate-y-1/2 gap-0 overflow-hidden rounded-lg border border-border-strong bg-card text-card-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04),0_24px_48px_-12px_rgba(15,23,42,0.32)] outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          width,
        ]"
      >
        <header class="flex items-center gap-3 border-b border-border-strong bg-surface-2 px-5 py-3">
          <DialogTitle class="text-section-title truncate">{{ title }}</DialogTitle>
          <DialogClose
            class="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
            aria-label="Close"
          >
            <Close :size="16" />
          </DialogClose>
        </header>
        <div class="bg-card">
          <slot />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
