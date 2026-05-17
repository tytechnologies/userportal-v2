<script setup lang="ts">
/**
 * Deal-scoped documents panel.
 *
 * Lists documents attached to a deal (LOIs, contracts, IDs, proof
 * of payment, financing docs). RLS on `documents` filters to deal
 * participants — non-participants get an empty list.
 *
 * Upload uses the existing /api/government-documents/[id]/file or a
 * future deal-specific upload endpoint. For v1 this panel is read-
 * only — operators upload via the existing documents flow with the
 * deal_id metadata set; the future upload UI lands here.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type DealDoc = {
  id: string
  file_name: string
  document_type: string | null
  file_format: string | null
  created_at: string
  signed_url: string
  creator: { id: string; full_name: string | null } | null
}

const props = defineProps<{
  dealId: string
}>()

const docs = ref<DealDoc[]>([])
const loading = ref(true)

async function load() {
  if (!props.dealId) return
  loading.value = true
  try {
    const res = await $fetch<{ data: DealDoc[] }>(
      `/api/deals/${props.dealId}/documents`,
    )
    docs.value = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load documents',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

watch(() => props.dealId, load)
onMounted(load)

defineExpose({ refresh: load })

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function formatType(d: DealDoc): string {
  if (d.document_type) return d.document_type
  if (d.file_format) return d.file_format.toUpperCase()
  return 'document'
}

const isEmpty = computed(() => !loading.value && docs.value.length === 0)
</script>

<template>
  <section class="rounded-xl border border-border bg-background p-4">
    <div class="mb-3 flex items-baseline justify-between">
      <h3 class="text-sm font-semibold text-foreground">Documents</h3>
      <button
        type="button"
        class="text-xs text-muted-foreground hover:underline"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <div
      v-if="loading"
      class="rounded-md border border-border bg-muted/50 p-4 text-xs text-muted-foreground"
    >
      Loading…
    </div>
    <div
      v-else-if="isEmpty"
      class="rounded-md border border-dashed border-border bg-muted/50 p-4 text-xs text-muted-foreground"
    >
      No uploaded files attached to this deal yet. To generate a
      draft from a template, use the Document drafts section above.
      Direct uploads land here once the upload UI ships.
    </div>

    <ul v-else class="space-y-2">
      <li
        v-for="d in docs"
        :key="d.id"
        class="flex flex-wrap items-baseline gap-2 rounded-md border border-border bg-muted/40 p-2"
      >
        <span class="text-base" aria-hidden="true">📄</span>
        <p class="text-sm font-semibold text-foreground truncate">
          {{ d.file_name || 'Untitled' }}
        </p>
        <span class="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          {{ formatType(d) }}
        </span>
        <span class="text-xs text-muted-foreground">
          {{ formatTs(d.created_at) }}
        </span>
        <span
          v-if="d.creator?.full_name"
          class="text-xs text-muted-foreground"
        >
          · {{ d.creator.full_name }}
        </span>
        <a
          v-if="d.signed_url"
          :href="d.signed_url"
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
        >
          Download
        </a>
      </li>
    </ul>
  </section>
</template>
