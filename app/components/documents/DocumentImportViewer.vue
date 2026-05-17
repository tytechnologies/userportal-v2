<script setup lang="ts">
// Inline viewer for imported drafts. Three modes based on storage_mime:
//
//   PDF                → pdfjs-dist canvas renderer with page nav + zoom
//   image/*            → native <img> with click-to-zoom
//   anything else      → metadata + download button
//
// Why pdfjs-dist instead of <embed src="…#zoom=…">: signed S3 URLs
// frequently get blocked from `<iframe>` / `<embed>` rendering by CORS
// or content-disposition headers, and we want a consistent UI across
// browsers (Safari iframe behavior is especially flaky for PDFs).

import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { DocumentDraft } from '~/composables/useDocumentDrafts'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  draft: DocumentDraft
}>()

const signedUrl = ref<string | null>(null)
const urlError = ref<string | null>(null)
const isLoadingUrl = ref(false)
const mime = computed(() => props.draft.storage_mime ?? '')
const isPdf = computed(() => mime.value === 'application/pdf' || (props.draft.storage_path ?? '').toLowerCase().endsWith('.pdf'))
const isImage = computed(() => mime.value.startsWith('image/'))

// Fetch the signed URL from the dedicated endpoint. RLS server-side
// gates whether the caller can mint one.
async function fetchSignedUrl() {
  isLoadingUrl.value = true
  urlError.value = null
  try {
    const res = await $fetch<{ url: string; mime: string | null }>(
      `/api/document-drafts/${props.draft.id}/url`,
    )
    signedUrl.value = res?.url ?? null
  } catch (err: any) {
    urlError.value = err?.statusMessage || err?.message || 'Failed to load file.'
  } finally {
    isLoadingUrl.value = false
  }
}

watch(() => props.draft?.id, fetchSignedUrl, { immediate: true })

// =====================================================================
// PDF rendering (pdfjs-dist, lazy import)
// =====================================================================

const canvasContainer = ref<HTMLDivElement | null>(null)
const pdfDoc = ref<any>(null)
const pageNum = ref(1)
const totalPages = ref(0)
const zoom = ref(1)
const pdfError = ref<string | null>(null)
const isRenderingPdf = ref(false)

let renderTask: any = null

async function loadPdf() {
  if (!signedUrl.value || !isPdf.value) return
  pdfError.value = null
  try {
    // Dynamic import keeps pdfjs out of the initial chunk for users
    // who never open an imported PDF. The ESM build doesn't ship type
    // declarations; cast through any to keep TS quiet.
    const pdfjs: any = await import(
      // @ts-expect-error: no types for the ESM build
      'pdfjs-dist/build/pdf.mjs'
    )
    // Worker URL — pdfjs needs a separate web-worker file. Vite serves
    // it from /node_modules via the ?url query.
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      const workerMod: any = await import(
        'pdfjs-dist/build/pdf.worker.mjs?url' as any
      )
      pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default
    }

    const loadingTask = pdfjs.getDocument({ url: signedUrl.value, withCredentials: false })
    pdfDoc.value = await loadingTask.promise
    totalPages.value = pdfDoc.value.numPages
    pageNum.value = 1
    await renderPage()
  } catch (err: any) {
    pdfError.value = err?.message || 'Failed to render PDF.'
    console.error('[DocumentImportViewer] pdf load failed:', err)
  }
}

async function renderPage() {
  if (!pdfDoc.value || !canvasContainer.value) return
  isRenderingPdf.value = true
  try {
    // Cancel any in-flight render first — switching pages while a
    // previous render is still ongoing causes pdfjs to throw.
    if (renderTask) {
      try { renderTask.cancel() } catch { /* ok */ }
      renderTask = null
    }

    const page = await pdfDoc.value.getPage(pageNum.value)
    const viewport = page.getViewport({ scale: zoom.value })

    // Reuse a single <canvas> for the active page. Recreating each
    // navigation prevents memory pressure with multi-hundred-page PDFs.
    let canvas = canvasContainer.value.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvasContainer.value.innerHTML = ''
      canvasContainer.value.appendChild(canvas)
    }
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No 2d context.')

    renderTask = page.render({ canvasContext: ctx, viewport })
    await renderTask.promise
    renderTask = null
  } catch (err: any) {
    if (err?.name !== 'RenderingCancelledException') {
      pdfError.value = err?.message || 'Failed to render page.'
      console.error('[DocumentImportViewer] render failed:', err)
    }
  } finally {
    isRenderingPdf.value = false
  }
}

watch(signedUrl, () => {
  if (isPdf.value) loadPdf()
})

watch([pageNum, zoom], () => {
  if (pdfDoc.value) renderPage()
})

function nextPage() {
  if (pageNum.value < totalPages.value) pageNum.value += 1
}
function prevPage() {
  if (pageNum.value > 1) pageNum.value -= 1
}
function zoomIn() { zoom.value = Math.min(3, zoom.value + 0.25) }
function zoomOut() { zoom.value = Math.max(0.5, zoom.value - 0.25) }
function resetZoom() { zoom.value = 1 }

onBeforeUnmount(() => {
  if (renderTask) {
    try { renderTask.cancel() } catch { /* ok */ }
  }
  if (pdfDoc.value) {
    try { pdfDoc.value.destroy() } catch { /* ok */ }
  }
})

function downloadFile() {
  if (!signedUrl.value) {
    showToast({ title: 'No file URL available.', icon: 'warning' })
    return
  }
  const a = document.createElement('a')
  a.href = signedUrl.value
  a.download = props.draft.title || 'document'
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
</script>

<template>
  <ClientOnly>
    <div class="rounded-xl border border-border bg-background shadow-sm">
      <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold text-foreground">
            {{ draft.title || 'Imported file' }}
          </h1>
          <p class="truncate text-xs text-muted-foreground">
            {{ mime || 'application/octet-stream' }}
            ·
            {{ draft.storage_size_bytes ? `${Math.round(draft.storage_size_bytes / 1024)} KB` : '—' }}
          </p>
        </div>

        <!-- PDF toolbar — page nav + zoom. -->
        <div v-if="isPdf && pdfDoc" class="flex items-center gap-2">
          <button
            type="button"
            class="rounded-md bg-muted px-2 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            :disabled="pageNum <= 1"
            @click="prevPage"
          >
            ‹
          </button>
          <span class="text-xs text-muted-foreground">
            Page {{ pageNum }} / {{ totalPages }}
          </span>
          <button
            type="button"
            class="rounded-md bg-muted px-2 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            :disabled="pageNum >= totalPages"
            @click="nextPage"
          >
            ›
          </button>
          <span class="mx-1 h-4 w-px bg-muted" aria-hidden="true" />
          <button type="button" class="rounded-md bg-muted px-2 py-1 text-xs font-semibold text-foreground hover:bg-muted" @click="zoomOut">−</button>
          <button type="button" class="rounded-md bg-muted px-2 py-1 text-xs font-semibold text-foreground hover:bg-muted" @click="resetZoom">
            {{ Math.round(zoom * 100) }}%
          </button>
          <button type="button" class="rounded-md bg-muted px-2 py-1 text-xs font-semibold text-foreground hover:bg-muted" @click="zoomIn">+</button>
        </div>

        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          :disabled="!signedUrl"
          @click="downloadFile"
        >
          Download
        </button>
      </header>

      <!-- Loading state for the signed URL. -->
      <div
        v-if="isLoadingUrl"
        class="px-4 py-10 text-center text-sm text-muted-foreground"
      >
        Loading…
      </div>

      <!-- Signed URL failure (RLS, expired session, S3 hiccup). -->
      <div
        v-else-if="urlError"
        class="px-4 py-10 text-center text-sm text-destructive"
      >
        {{ urlError }}
        <button type="button" class="ml-2 underline" @click="fetchSignedUrl">
          Retry
        </button>
      </div>

      <!-- PDF canvas — pdfjs-dist renders into a child <canvas>. -->
      <div
        v-else-if="isPdf"
        class="overflow-auto bg-muted/50 p-4"
        style="max-height: 80vh"
      >
        <div v-if="pdfError" class="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {{ pdfError }}
        </div>
        <div v-if="isRenderingPdf && !pdfDoc" class="px-4 py-10 text-center text-xs text-muted-foreground">
          Rendering PDF…
        </div>
        <div ref="canvasContainer" class="mx-auto inline-block bg-card shadow" />
      </div>

      <!-- Image — let the browser handle scaling. -->
      <div
        v-else-if="isImage && signedUrl"
        class="overflow-auto bg-muted/50 p-4 text-center"
        style="max-height: 80vh"
      >
        <img
          :src="signedUrl"
          :alt="draft.title || 'Imported image'"
          class="mx-auto max-w-full"
        />
      </div>

      <!-- Unknown mime — show metadata + download. -->
      <div
        v-else
        class="px-4 py-10 text-center text-sm text-muted-foreground"
      >
        Inline preview isn't supported for this file type
        <span class="font-mono">{{ mime || 'unknown' }}</span>.
        Use Download to open it.
      </div>
    </div>
  </ClientOnly>
</template>
