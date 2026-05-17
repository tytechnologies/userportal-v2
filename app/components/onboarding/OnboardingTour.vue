<script setup lang="ts">
/**
 * First-sign-in product tour overlay.
 *
 * Mounted once at the layout root. Activates when
 * useOnboardingTourStore().isActive flips true. Renders:
 *   - A 4-panel backdrop that masks everything EXCEPT the target's
 *     bounding rect (the "spotlight").
 *   - A tooltip popover with the step's title + body + Skip + Back +
 *     Next controls.
 *
 * When `step.target` is null, the spotlight is suppressed and the
 * tooltip renders centered as a regular modal — useful for the
 * welcome and done steps.
 *
 * Failure modes:
 *   - Target selector misses → falls back to centered modal with the
 *     same copy. Never crashes the tour.
 *   - Route navigation throws → caught; step still renders.
 *   - localStorage disabled → completion still persists via the RPC
 *     and re-checks on next sign-in.
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useOnboardingTourStore } from '~/store/onboardingTour'

const tour = useOnboardingTourStore()
const router = useRouter()
const route = useRoute()

// --- target rect tracking ------------------------------------------
//
// We poll the target's bounding rect (a) when the step changes, and
// (b) on every scroll / resize event while the tour is active. Polling
// instead of MutationObserver keeps the implementation small — the
// tour is short-lived per user so the cost is negligible.

const targetRect = ref<DOMRect | null>(null)
const targetMissing = ref(false)
let frameHandle: number | null = null

function readTargetRect() {
  const step = tour.currentStep
  if (!step?.target) {
    targetRect.value = null
    targetMissing.value = false
    return
  }
  const el = typeof document === 'undefined'
    ? null
    : (document.querySelector(step.target) as HTMLElement | null)
  if (!el) {
    targetRect.value = null
    targetMissing.value = true
    return
  }
  targetMissing.value = false
  const r = el.getBoundingClientRect()
  // Pad the spotlight a few px so it doesn't graze the target.
  targetRect.value = new DOMRect(
    r.left - 6,
    r.top - 6,
    r.width + 12,
    r.height + 12,
  )
}

function startTracking() {
  if (typeof window === 'undefined') return
  stopTracking()
  const loop = () => {
    readTargetRect()
    frameHandle = window.requestAnimationFrame(loop)
  }
  frameHandle = window.requestAnimationFrame(loop)
}

function stopTracking() {
  if (typeof window === 'undefined') return
  if (frameHandle != null) {
    window.cancelAnimationFrame(frameHandle)
    frameHandle = null
  }
}

// --- step transitions ----------------------------------------------

async function applyStepRoute() {
  const step = tour.currentStep
  if (!step?.route) return
  if (route.fullPath === step.route || route.path === step.route) return
  try {
    await router.push(step.route)
  } catch (err) {
    console.warn('[onboarding] route push failed:', err)
  }
}

watch(
  () => [tour.isActive, tour.currentIndex],
  async ([active]) => {
    if (active) {
      await applyStepRoute()
      // Let the route's render settle before measuring.
      requestAnimationFrame(() => {
        readTargetRect()
        startTracking()
      })
    } else {
      stopTracking()
    }
  },
  { immediate: true },
)

onBeforeUnmount(stopTracking)

// --- keyboard ------------------------------------------------------

function onKeydown(e: KeyboardEvent) {
  if (!tour.isActive) return
  if (e.key === 'Escape') {
    e.preventDefault()
    tour.skip()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    if (tour.isLastStep) tour.complete()
    else tour.next()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    tour.back()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}

// --- tooltip placement --------------------------------------------

const tooltipStyle = computed(() => {
  const step = tour.currentStep
  if (!step) return {}
  // No target OR target missing → centered modal.
  if (!step.target || !targetRect.value) {
    return {
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
    }
  }
  const r = targetRect.value
  const pos = step.position ?? 'bottom'
  const gap = 12
  switch (pos) {
    case 'top':
      return {
        left: `${r.left + r.width / 2}px`,
        top: `${r.top - gap}px`,
        transform: 'translate(-50%, -100%)',
      }
    case 'right':
      return {
        left: `${r.right + gap}px`,
        top: `${r.top + r.height / 2}px`,
        transform: 'translateY(-50%)',
      }
    case 'left':
      return {
        left: `${r.left - gap}px`,
        top: `${r.top + r.height / 2}px`,
        transform: 'translate(-100%, -50%)',
      }
    case 'bottom':
    default:
      return {
        left: `${r.left + r.width / 2}px`,
        top: `${r.bottom + gap}px`,
        transform: 'translateX(-50%)',
      }
  }
})

const spotlightStyle = computed(() => {
  const r = targetRect.value
  if (!r) return null
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  }
})

const isCentered = computed(
  () => !tour.currentStep?.target || !targetRect.value,
)

const progressDots = computed(() =>
  Array.from({ length: tour.totalSteps }, (_, i) => i),
)

function onPrimary() {
  if (tour.isLastStep) {
    tour.complete()
  } else {
    tour.next()
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="tour.isActive"
      class="fixed inset-0 z-[100] pointer-events-none"
      role="dialog"
      aria-modal="true"
      :aria-label="tour.currentStep?.title || 'Onboarding tour'"
    >
      <!-- Spotlight: 4-panel mask leaves the target rect transparent.
           Skipped when there's no target (centered modal mode). -->
      <template v-if="!isCentered && spotlightStyle">
        <!-- Top panel: from viewport top to spotlight top -->
        <div
          class="absolute inset-x-0 top-0 bg-ink-900/60 backdrop-blur-[1px] pointer-events-auto"
          :style="{ height: spotlightStyle.top }"
          @click="tour.skip()"
        />
        <!-- Bottom panel -->
        <div
          class="absolute inset-x-0 bottom-0 bg-ink-900/60 backdrop-blur-[1px] pointer-events-auto"
          :style="{
            top: `calc(${spotlightStyle.top} + ${spotlightStyle.height})`,
          }"
          @click="tour.skip()"
        />
        <!-- Left panel: between top + bottom panels, left edge to spotlight left -->
        <div
          class="absolute bg-ink-900/60 backdrop-blur-[1px] pointer-events-auto"
          :style="{
            left: 0,
            top: spotlightStyle.top,
            width: spotlightStyle.left,
            height: spotlightStyle.height,
          }"
          @click="tour.skip()"
        />
        <!-- Right panel -->
        <div
          class="absolute bg-ink-900/60 backdrop-blur-[1px] pointer-events-auto"
          :style="{
            left: `calc(${spotlightStyle.left} + ${spotlightStyle.width})`,
            right: 0,
            top: spotlightStyle.top,
            height: spotlightStyle.height,
          }"
          @click="tour.skip()"
        />
        <!-- Spotlight ring -->
        <div
          class="absolute rounded-md ring-2 ring-primary ring-offset-2 ring-offset-transparent pointer-events-none animate-pulse"
          :style="spotlightStyle"
        />
      </template>

      <!-- Centered-modal backdrop -->
      <div
        v-else
        class="absolute inset-0 bg-ink-900/60 backdrop-blur-[1px] pointer-events-auto"
        @click="tour.skip()"
      />

      <!-- Tooltip / popover -->
      <div
        class="absolute pointer-events-auto bg-card text-card-foreground rounded-lg shadow-lg ring-1 ring-border w-[320px] max-w-[90vw] p-4"
        :style="tooltipStyle"
        @click.stop
      >
        <div class="flex items-start justify-between gap-2 mb-2">
          <h3 class="text-base font-semibold leading-tight">
            {{ tour.currentStep?.title }}
          </h3>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground text-sm font-medium px-2 py-1 -m-1"
            aria-label="Skip onboarding tour"
            @click="tour.skip()"
          >
            Skip
          </button>
        </div>
        <p class="text-sm text-muted-foreground leading-relaxed mb-4">
          {{ tour.currentStep?.body }}
        </p>
        <div class="flex items-center justify-between gap-3">
          <div
            class="flex gap-1.5"
            aria-label="Progress"
          >
            <span
              v-for="i in progressDots"
              :key="i"
              class="block w-2 h-2 rounded-full"
              :class="i === tour.currentIndex ? 'bg-primary' : 'bg-muted'"
              aria-hidden="true"
            />
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="!tour.isFirstStep"
              type="button"
              class="text-sm font-medium text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md"
              @click="tour.back()"
            >
              Back
            </button>
            <button
              type="button"
              class="text-sm font-semibold bg-primary text-primary-foreground hover:opacity-90 px-3 py-1.5 rounded-md transition-opacity"
              @click="onPrimary"
            >
              {{ tour.currentStep?.primaryCta || (tour.isLastStep ? 'Finish' : 'Next') }}
            </button>
          </div>
        </div>
        <p
          v-if="targetMissing"
          class="mt-3 text-xs text-warning-700"
        >
          (Target element not found — using centered mode.)
        </p>
      </div>
    </div>
  </Teleport>
</template>
