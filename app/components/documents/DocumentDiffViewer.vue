<script setup lang="ts">
/**
 * Side-by-side diff between two document versions, with an optional
 * AI-summarized "what changed" panel powered by /api/documents/ai-assist
 * compare_revisions.
 *
 * Two views:
 *   1. Side-by-side text — both bodies, same scroll container, raw.
 *      No syntax highlighting; plain monospace so the broker reads
 *      paragraph by paragraph.
 *   2. AI summary — bullet list of meaningful changes (added/removed
 *      parties, changed dates/amounts/obligations). Skipped automatic
 *      formatting/whitespace diffs. Only computed on demand because
 *      it costs a model call.
 *
 * Either side can be:
 *   - a stored version (loaded from /api/.../versions/[v])
 *   - the live draft (passed in as props)
 *
 * The component is presentational — the parent loads the version
 * snapshots and passes the `bodyA`/`bodyB` strings in.
 */
import { computed, ref } from 'vue'
import { showToast } from '~/helpers/helpers'
import { diffWords, type DiffSegment } from '~/utils/wordDiff'

const props = defineProps<{
  /** Header label for the left side (e.g. "v3 · pre-notary"). */
  labelA: string
  /** Header label for the right side. */
  labelB: string
  /** Body text for the left side. Empty string when there's nothing
   *  to diff (e.g. the version was a template-only snapshot). */
  bodyA: string
  bodyB: string
}>()

const aiSummary = ref<string | null>(null)
const aiLoading = ref(false)
const aiUnavailable = ref<{ admin_path: string } | null>(null)

async function summarize() {
  if (aiLoading.value) return
  if (!props.bodyA.trim() || !props.bodyB.trim()) {
    showToast({
      title: 'Both versions need text content for AI to compare.',
      icon: 'error',
    })
    return
  }
  aiLoading.value = true
  aiUnavailable.value = null
  try {
    const res = await $fetch<{ output: string }>('/api/documents/ai-assist', {
      method: 'POST',
      body: {
        operation: 'compare_revisions',
        text:       props.bodyA,
        other_text: props.bodyB,
      },
    })
    aiSummary.value = res.output
  } catch (err: any) {
    if (err?.statusCode === 503 && err?.data?.code === 'ai_not_configured') {
      aiUnavailable.value = { admin_path: err.data.admin_path || '/admin/ai-settings' }
    } else {
      showToast({
        title: err?.statusMessage || err?.message || 'AI compare failed',
        icon: 'error',
      })
    }
  } finally {
    aiLoading.value = false
  }
}

const bothEmpty = computed(() => !props.bodyA.trim() && !props.bodyB.trim())

// Word-level diff. Computed lazily on demand because the LCS is
// O(M*N) memory; brokers may have a 5k-word doc on each side and
// we don't want to compute that on every keystroke.
const showInlineDiff = ref(true)
const segments = computed<DiffSegment[]>(() => {
  if (!showInlineDiff.value) return []
  return diffWords(props.bodyA, props.bodyB)
})
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h3 class="text-card-title">Compare versions</h3>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring"
          @click="showInlineDiff = !showInlineDiff"
        >
          {{ showInlineDiff ? 'Show side-by-side' : 'Show inline diff' }}
        </button>
        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
          :disabled="aiLoading || bothEmpty"
          @click="summarize"
        >
          {{ aiLoading ? 'Summarizing…' : 'Summarize changes (AI)' }}
        </button>
      </div>
    </header>

    <!-- AI-not-configured CTA -->
    <p
      v-if="aiUnavailable"
      class="mb-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground"
    >
      AI summarization needs to be configured. Side-by-side text diff
      below still works.
      <NuxtLink
        :to="aiUnavailable.admin_path"
        class="ml-1 font-semibold text-primary hover:underline focus-ring rounded"
      >
        Open AI settings →
      </NuxtLink>
    </p>

    <!-- AI summary panel — only renders after a successful call. The
         "ai_generated" framing is critical: this is suggestion, not
         legal authority. -->
    <article
      v-if="aiSummary"
      class="mb-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2"
    >
      <p class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
        AI summary · review carefully
      </p>
      <p class="whitespace-pre-wrap text-xs text-foreground/90">{{ aiSummary }}</p>
    </article>

    <!-- Inline word-level diff. Computed via LCS in app/utils/wordDiff.ts.
         Added words show on a green tint, removed on a red tint with a
         strike-through. Toggle with the header button when the
         side-by-side rendering is more useful (e.g. when one side is
         much longer than the other). -->
    <article
      v-if="showInlineDiff"
      class="rounded-md border border-border bg-surface-2 p-3 font-mono text-[12px] leading-relaxed"
    >
      <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {{ labelA }} → {{ labelB }}
      </p>
      <div class="max-h-[60vh] overflow-auto whitespace-pre-wrap">
        <template v-for="(seg, idx) in segments" :key="idx">
          <span v-if="seg.kind === 'eq'" class="text-foreground">{{ seg.text }}</span>
          <span v-else-if="seg.kind === 'add'" class="rounded bg-success/15 px-0.5 text-success">{{ seg.text }}</span>
          <span v-else class="rounded bg-destructive/15 px-0.5 text-destructive line-through">{{ seg.text }}</span>
        </template>
        <span
          v-if="segments.length === 0"
          class="text-muted-foreground"
        >
          (no content to compare)
        </span>
      </div>
    </article>

    <!-- Side-by-side fallback. Useful when one side is much longer or
         when the broker wants to scan structure rather than wording. -->
    <div v-else class="grid gap-3 lg:grid-cols-2">
      <div class="min-w-0">
        <p class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {{ labelA }}
        </p>
        <pre class="max-h-[60vh] overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">{{ bodyA || '— empty —' }}</pre>
      </div>
      <div class="min-w-0">
        <p class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {{ labelB }}
        </p>
        <pre class="max-h-[60vh] overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">{{ bodyB || '— empty —' }}</pre>
      </div>
    </div>
  </section>
</template>
