<script setup lang="ts">
/**
 * UiDrawer — right-side slide-in workspace panel (Operations palette).
 *
 * Built as an enterprise workspace, not a mobile sheet. The panel is:
 *   - opaque (bg-card, NOT transparent / blurred)
 *   - bordered on the leading edge
 *   - full-height with sticky header + sticky footer
 *   - backdropped with a calm slate scrim (not navy)
 *
 * Closing UX:
 *   - Click backdrop (unless persistent)
 *   - Press Escape (unless persistent)
 *   - Click the X button in the header
 *   - Caller-controlled v-model:open false
 *
 * Width:
 *   sm  — 360px (small editors)
 *   md  — 480px (default)
 *   lg  — 640px (forms with multiple sections)
 *   xl  — 880px (data tables / log viewers)
 *   full— full viewport (mobile)
 *
 * Slots:
 *   header   — title + actions row (defaults to a centered title)
 *   default  — body (scrolls if it overflows)
 *   footer   — sticky footer (e.g., Save / Cancel buttons)
 */
import { computed, watch, onUnmounted } from 'vue'

type Width = 'sm' | 'md' | 'lg' | 'xl' | 'full'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    width?: Width
    /** Disable the backdrop click-to-close. */
    persistent?: boolean
    /** Subtitle shown below the title in the header. */
    subtitle?: string
  }>(),
  {
    title: '',
    subtitle: '',
    width: 'md',
    persistent: false,
  },
)

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
}>()

const widthClass: Record<Width, string> = {
  sm: 'max-w-[360px]',
  md: 'max-w-[480px]',
  lg: 'max-w-[640px]',
  xl: 'max-w-[880px]',
  full: 'max-w-full',
}

function close() {
  emit('update:open', false)
}

function onBackdrop() {
  if (!props.persistent) close()
}

// Lock body scroll while open + Escape-to-close.
function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && props.open && !props.persistent) close()
}

watch(
  () => props.open,
  (v) => {
    if (typeof document === 'undefined') return
    if (v) {
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', onKey)
    } else {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKey)
    }
  },
)

onUnmounted(() => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKey)
})

const widthCls = computed(() => widthClass[props.width])
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 bg-foreground/50"
        aria-hidden="true"
        @click="onBackdrop"
      />
    </Transition>
    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      enter-from-class="translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition-transform duration-150 ease-in"
      leave-from-class="translate-x-0"
      leave-to-class="translate-x-full"
    >
      <aside
        v-if="open"
        :class="[
          'fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-border-strong bg-card text-card-foreground shadow-[0_0_0_1px_rgba(15,23,42,0.04),-12px_0_32px_-8px_rgba(15,23,42,0.18)]',
          widthCls,
        ]"
        role="dialog"
        :aria-label="title"
      >
        <header class="flex items-start justify-between gap-3 border-b border-border-strong bg-surface-2 px-5 py-3">
          <div class="min-w-0 flex-1">
            <slot name="header">
              <h2 class="text-section-title truncate">{{ title }}</h2>
              <p v-if="subtitle" class="mt-0.5 text-meta truncate">{{ subtitle }}</p>
            </slot>
          </div>
          <button
            type="button"
            class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
            aria-label="Close"
            @click="close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </header>
        <div class="flex-1 overflow-y-auto bg-card px-5 py-4">
          <slot />
        </div>
        <footer
          v-if="$slots.footer"
          class="border-t border-border-strong bg-surface-2 px-5 py-3"
        >
          <slot name="footer" />
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
