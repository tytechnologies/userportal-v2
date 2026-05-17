<script setup lang="ts">
/**
 * Single global confirmation dialog. Driven by useConfirm()'s singleton
 * state; mount once (in app.vue). All `await confirm(...)` calls anywhere
 * in the app render through this.
 */
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'radix-vue'

const { state, respond } = useConfirm()
</script>

<template>
  <DialogRoot
    :open="state.isOpen"
    @update:open="(open) => { if (!open) respond(false) }"
  >
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-[9998] bg-foreground/55 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogContent
        :class="[
          'fixed left-1/2 top-1/2 z-[9999] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-card p-6 shadow-lg outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        ]"
      >
        <DialogTitle class="text-lg font-semibold text-foreground">
          {{ state.options.title }}
        </DialogTitle>
        <DialogDescription
          v-if="state.options.description"
          class="mt-2 text-sm text-muted-foreground"
        >
          {{ state.options.description }}
        </DialogDescription>

        <div class="mt-6 flex justify-end gap-2">
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 h-9 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="respond(false)"
          >
            {{ state.options.cancelText }}
          </button>
          <button
            type="button"
            :class="[
              'inline-flex items-center justify-center rounded-md px-4 h-9 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              state.options.variant === 'destructive'
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            ]"
            @click="respond(true)"
          >
            {{ state.options.confirmText }}
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
