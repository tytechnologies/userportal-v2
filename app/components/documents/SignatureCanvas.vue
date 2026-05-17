<script setup lang="ts">
// Pure-canvas signature pad. Captures pointer/touch input, draws
// smooth strokes, and exposes:
//   - clear()                  — wipe the canvas
//   - isEmpty                  — has anything been drawn
//   - toDataUrl()              — current strokes as PNG data URL
//
// The parent (SignatureModal) decides what to do with the data URL —
// upload via uploadSignature, persist into formData, etc.
//
// Design choices:
//   - Pointer Events for unified mouse/touch/stylus.
//   - Quadratic bezier between midpoints of consecutive samples — not
//     just lineTo — for smoothness without sampling at sub-pixel rates.
//   - Canvas is sized via CSS (responsive width) and DPR-scaled at
//     mount so strokes stay crisp on retina displays.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  width?: number
  height?: number
  strokeColor?: string
  strokeWidth?: number
}>()

defineExpose({
  clear: () => clear(),
  toDataUrl: () => toDataUrl(),
  isEmpty: () => isEmpty.value,
})

const canvasEl = ref<HTMLCanvasElement | null>(null)
const isEmpty = ref(true)

const widthPx = computed(() => props.width ?? 600)
const heightPx = computed(() => props.height ?? 200)

let ctx: CanvasRenderingContext2D | null = null
let dpr = 1

// Stroke buffering. We keep the last 1–2 sample points and draw via
// midpoint quadratic curves to smooth out jaggies — the natural
// approach for hand-drawn signatures.
let drawing = false
let lastX = 0
let lastY = 0
let lastMidX = 0
let lastMidY = 0

function setupCanvas() {
  const canvas = canvasEl.value
  if (!canvas) return
  dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  canvas.width = widthPx.value * dpr
  canvas.height = heightPx.value * dpr
  ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = props.strokeColor ?? '#111827'
  ctx.lineWidth = props.strokeWidth ?? 2.2
}

function clientToLocal(e: PointerEvent) {
  const canvas = canvasEl.value!
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) / rect.width) * widthPx.value,
    y: ((e.clientY - rect.top) / rect.height) * heightPx.value,
  }
}

function onPointerDown(e: PointerEvent) {
  e.preventDefault()
  if (!ctx) return
  drawing = true
  isEmpty.value = false
  ;(e.target as Element).setPointerCapture(e.pointerId)

  const { x, y } = clientToLocal(e)
  lastX = x
  lastY = y
  lastMidX = x
  lastMidY = y
}

function onPointerMove(e: PointerEvent) {
  if (!drawing || !ctx) return
  const { x, y } = clientToLocal(e)
  const midX = (lastX + x) / 2
  const midY = (lastY + y) / 2
  ctx.beginPath()
  ctx.moveTo(lastMidX, lastMidY)
  ctx.quadraticCurveTo(lastX, lastY, midX, midY)
  ctx.stroke()
  lastX = x
  lastY = y
  lastMidX = midX
  lastMidY = midY
}

function onPointerUp() {
  drawing = false
}

function clear() {
  const canvas = canvasEl.value
  if (!canvas || !ctx) return
  ctx.clearRect(0, 0, widthPx.value, heightPx.value)
  isEmpty.value = true
}

function toDataUrl(): string {
  const canvas = canvasEl.value
  if (!canvas) return ''
  return canvas.toDataURL('image/png')
}

onMounted(() => {
  setupCanvas()
})

watch([widthPx, heightPx], () => {
  // Preserve content across resize? Not worth it for a signature pad —
  // resize means reset. Caller can persist the current dataURL first.
  clear()
  setupCanvas()
})

onBeforeUnmount(() => {
  // Nothing async — but explicit about lifecycle.
})
</script>

<template>
  <ClientOnly>
    <div class="space-y-2">
      <canvas
        ref="canvasEl"
        class="touch-none rounded-md border border-border bg-background"
        :style="{
          width: widthPx + 'px',
          height: heightPx + 'px',
          maxWidth: '100%',
          cursor: 'crosshair',
        }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerUp"
      />
      <p class="text-xs text-muted-foreground">
        Sign with mouse, touch, or stylus.
      </p>
    </div>
  </ClientOnly>
</template>
