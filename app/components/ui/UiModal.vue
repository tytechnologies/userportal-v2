<script setup lang="ts">
/**
 * UiModal — centered overlay panel (Operations palette).
 *
 * The enterprise-grade complement to UiDrawer. Use UiModal for:
 *   - confirmation dialogs ("Delete this listing?")
 *   - short forms (Create deal, Log inquiry)
 *   - alert / decision dialogs
 *
 * Use UiDrawer for:
 *   - long forms with multiple sections
 *   - row-detail editors over a list
 *   - log viewers / activity panels
 *
 * Operational design language (Linear / Stripe / Causal):
 *   - opaque card surface (NEVER transparent / blurred)
 *   - defined border-strong on the chrome
 *   - sticky header with eyebrow + title + close
 *   - sticky footer for action buttons
 *   - calm slate scrim (foreground/50, not black/60)
 *   - controlled two-layer shadow (no shadow-2xl glow)
 *
 * Width:
 *   sm  — 400px (confirm dialogs)
 *   md  — 520px (default — short forms)
 *   lg  — 720px (multi-field forms)
 *   xl  — 960px (data tables / wide pickers)
 *
 * Closing UX:
 *   - Click backdrop (unless persistent)
 *   - Press Escape (unless persistent)
 *   - Click the X button in the header
 *   - Caller-controlled v-model:open false
 *
 * Slots:
 *   header   — title + actions row (defaults to title + subtitle)
 *   default  — body (scrolls if it overflows)
 *   footer   — sticky footer (e.g., Cancel / Confirm buttons)
 */
import { computed, watch, onUnmounted } from 'vue'

type Width = 'sm' | 'md' | 'lg' | 'xl'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    /** Eyebrow / domain label above the title. */
    eyebrow?: string
    /** Subtitle shown below the title in the header. */
    subtitle?: string
    width?: Width
    /** Disable the backdrop click-to-close + Escape-to-close. */
    persistent?: boolean
    /** Tone the title bar (red border-bottom for destructive flows). */
    tone?: 'neutral' | 'destructive'
  }>(),
  {
    title: '',
    eyebrow: '',
    subtitle: '',
    width: 'md',
    persistent: false,
    tone: 'neutral',
  },
)

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
}>()

// Each variant gets a max-w cap PLUS a viewport-width clamp so the
// modal never exceeds the screen on mobile. `w-[calc(100vw-2rem)]`
// = full viewport minus 16px gutter on each side. The max-w then
// caps growth on tablet/desktop.
const widthClass: Record<Width, string> = {
  sm: 'w-[calc(100vw-2rem)] max-w-[400px]',
  md: 'w-[calc(100vw-2rem)] max-w-[520px]',
  lg: 'w-[calc(100vw-2rem)] max-w-[720px]',
  xl: 'w-[calc(100vw-2rem)] max-w-[960px]',
}

function close() {
  emit('update:open', false)
}

function onBackdrop() {
  if (!props.persistent) close()
}

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
const headerBorderCls = computed(() =>
  props.tone === 'destructive' ? 'border-destructive/40' : 'border-border-strong',
)
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
        class="fixed inset-0 z-[100] bg-foreground/50"
        aria-hidden="true"
        @click="onBackdrop"
      />
    </Transition>
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 translate-y-2 scale-[0.98]"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 translate-y-2 scale-[0.98]"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[101] flex items-start justify-center overflow-y-auto px-4 py-[10vh]"
        @click.self="onBackdrop"
      >
        <div
          :class="[
            'flex max-h-[80vh] w-full flex-col overflow-hidden rounded-lg border border-border-strong bg-card text-card-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04),0_24px_48px_-12px_rgba(15,23,42,0.32)]',
            widthCls,
          ]"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <header
            :class="[
              'flex items-start justify-between gap-3 border-b bg-surface-2 px-5 py-3',
              headerBorderCls,
            ]"
          >
            <div class="min-w-0 flex-1">
              <slot name="header">
                <p v-if="eyebrow" class="text-eyebrow">{{ eyebrow }}</p>
                <h2 :class="[eyebrow ? 'mt-0.5' : '', 'text-section-title truncate']">
                  {{ title }}
                </h2>
                <p v-if="subtitle" class="mt-0.5 text-meta truncate">{{ subtitle }}</p>
              </slot>
            </div>
            <button
              type="button"
              class="-mr-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
              aria-label="Close"
              @click="close"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto bg-card px-5 py-4">
            <slot />
          </div>
          <footer
            v-if="$slots.footer"
            class="border-t border-border-strong bg-surface-2 px-5 py-3"
          >
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
