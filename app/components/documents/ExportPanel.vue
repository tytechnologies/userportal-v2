<script setup lang="ts">
/**
 * Export panel — DOCX / PDF download via the server-side renderers.
 *
 * The endpoint stashes the artifact in S3 so each generation is
 * audit-traceable (document_exports table). The signed URL expires
 * in an hour; brokers re-trigger if they need a fresh link.
 */
import { ref } from 'vue'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  draftId: string
}>()

const exporting = ref<'docx' | 'pdf' | null>(null)

async function exportDoc(format: 'docx' | 'pdf') {
  if (exporting.value) return
  exporting.value = format
  try {
    const res = await $fetch<{ url: string }>(`/api/document-drafts/${props.draftId}/export`, {
      method: 'POST',
      body: { format },
    })
    if (typeof window !== 'undefined') {
      // Open in a new tab so the broker's edit context isn't lost.
      window.open(res.url, '_blank', 'noopener,noreferrer')
    }
    showToast({ title: `${format.toUpperCase()} ready`, icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || `${format.toUpperCase()} render failed`,
      icon: 'error',
    })
  } finally {
    exporting.value = null
  }
}
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3">
      <h3 class="text-card-title">Export</h3>
      <p class="mt-0.5 text-meta">
        Server-rendered DOCX (via the docx library) or PDF (via Puppeteer).
        Every export is logged so you can re-download or audit later.
      </p>
    </header>

    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
        :disabled="!!exporting"
        @click="exportDoc('docx')"
      >
        {{ exporting === 'docx' ? 'Rendering…' : 'Download .docx' }}
      </button>
      <button
        type="button"
        class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
        :disabled="!!exporting"
        @click="exportDoc('pdf')"
      >
        {{ exporting === 'pdf' ? 'Rendering…' : 'Download .pdf' }}
      </button>
    </div>
  </section>
</template>
