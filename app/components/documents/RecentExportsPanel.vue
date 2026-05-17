<script setup lang="ts">
/**
 * "Recent exports" — top-of-list strip on the documents hub.
 * Surfaces the latest DOCX / PDF artifacts the current user can see
 * (RLS-scoped via the parent draft), so re-downloading the most
 * recent send-to-lawyer / send-to-buyer file is one click.
 *
 * Self-hides when nothing has been exported. Each row deep-links to
 * the parent draft (Export tab) so the broker can see the full
 * version history; the inline Download button signs a fresh URL on
 * demand and opens it in a new tab.
 */
import { onMounted, ref } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import { showToast } from '~/helpers/helpers'

type Export = {
  id: string
  draft_id: string
  format: 'docx' | 'pdf'
  byte_length: number
  generated_at: string
  generated_by: string | null
  draft: { id: string; title: string | null; doc_type_key: string | null } | null
}

const items = ref<Export[]>([])
const loading = ref(true)
const downloadingId = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Export[] }>('/api/document-exports/recent', {
      params: { limit: 8 },
    })
    items.value = res.data ?? []
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
defineExpose({ refresh: load })

async function download(e: Export) {
  if (downloadingId.value) return
  downloadingId.value = e.id
  try {
    const res = await $fetch<{ url: string }>(`/api/document-exports/${e.id}/download`)
    if (res?.url) {
      // open in a new tab — the signed URL will trigger a download in the
      // browser based on the file's Content-Disposition header set by S3.
      window.open(res.url, '_blank', 'noopener,noreferrer')
    } else {
      showToast({ title: 'Download URL unavailable.', icon: 'error' })
    }
  } catch (err: any) {
    showToast({ title: err?.statusMessage ?? err?.message ?? 'Download failed.', icon: 'error' })
  } finally {
    downloadingId.value = null
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <section
    v-if="!loading && items.length > 0"
    class="rounded-lg border border-border bg-card p-4"
  >
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <h2 class="text-card-title">
        Recent exports
        <UiBadge variant="neutral" size="xs" class="ml-1">
          {{ items.length }}
        </UiBadge>
      </h2>
      <p class="text-[11px] text-muted-foreground">
        DOCX / PDF artifacts you (or your team) generated. Re-signs a
        fresh download URL — links don't expire from this list.
      </p>
    </header>

    <ul class="space-y-1.5">
      <li
        v-for="e in items"
        :key="e.id"
        class="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2"
      >
        <UiBadge
          :variant="e.format === 'pdf' ? 'primary' : 'neutral'"
          size="xs"
          class="uppercase"
        >
          {{ e.format }}
        </UiBadge>
        <NuxtLink
          v-if="e.draft"
          :to="`/document-drafts/${e.draft.id}#export`"
          class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground hover:text-primary hover:underline focus-ring rounded"
        >
          {{ e.draft.title || e.draft.doc_type_key || `Draft ${e.draft.id.slice(0, 8)}` }}
        </NuxtLink>
        <span v-else class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          (orphaned export)
        </span>

        <span class="hidden shrink-0 text-[10px] tabular-nums text-muted-foreground sm:inline">
          {{ formatBytes(e.byte_length) }}
        </span>
        <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {{ relativeTime(e.generated_at) }}
        </span>
        <button
          type="button"
          class="shrink-0 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring disabled:opacity-60"
          :disabled="downloadingId === e.id"
          @click="download(e)"
        >
          {{ downloadingId === e.id ? '…' : 'Download' }}
        </button>
      </li>
    </ul>
  </section>
</template>
