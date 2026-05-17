<script setup lang="ts">
/**
 * AI Assist drawer — surfaces the existing /api/documents/ai-assist
 * operations on the broker's current draft.
 *
 * Operations exposed:
 *   - Explain        — "what does this clause mean?"
 *   - Summarize      — bullet summary of the whole document
 *   - Detect missing — flag what's typically missing
 *   - Translate (Tagalog) — render in formal Tagalog
 *   - Rewrite with clause — splice an approved clause-library entry
 *
 * The AI never persists changes from this drawer — output is shown
 * as suggestion text the broker copies/pastes. Output is framed
 * with a "review carefully — AI-generated" banner.
 */
import { computed, ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import type { DocumentDraft } from '~/composables/useDocumentDrafts'
import UiBadge from '~/components/ui/UiBadge.vue'

type Operation = 'explain' | 'summarize' | 'detect_missing' | 'translate_tagalog' | 'rewrite_with_clause'

type Clause = {
  id: string
  title: string
  status: 'draft' | 'approved' | 'deprecated'
  body: string
}

const props = defineProps<{
  draft: DocumentDraft
}>()

// The body the broker is operating on. AI drafts have ai_body; for
// template drafts we serialize the data fields so the operations
// have something to reason about.
const sourceText = computed<string>(() => {
  const data = (props.draft.data as Record<string, unknown> | null) ?? {}
  if (typeof data.ai_body === 'string' && data.ai_body) return data.ai_body as string
  // Fallback: stringify scalar fields so summarize/detect_missing can
  // still operate on template drafts.
  const lines: string[] = []
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('_') || k === 'ai_body') continue
    lines.push(`${k}: ${String(v ?? '')}`)
  }
  return lines.join('\n')
})

const operation = ref<Operation>('explain')
const selection = ref<string>('') // for explain — broker pastes the clause/paragraph
const clauseId  = ref<string>('') // for rewrite_with_clause
const clauses   = ref<Clause[]>([])
const clausesLoading = ref(false)

const running = ref(false)
const output  = ref<string | null>(null)
const aiUnavailable = ref<{ admin_path: string } | null>(null)

async function loadClauses() {
  if (clausesLoading.value || clauses.value.length > 0) return
  clausesLoading.value = true
  try {
    const res = await $fetch<{ data: Clause[] }>('/api/clauses', {
      query: { status: 'approved' },
    })
    clauses.value = res.data ?? []
  } catch {
    clauses.value = []
  } finally {
    clausesLoading.value = false
  }
}
watch(operation, (op) => {
  if (op === 'rewrite_with_clause') loadClauses()
})

function payload(): Record<string, unknown> {
  switch (operation.value) {
    case 'explain':
      return { operation: 'explain', text: selection.value || sourceText.value }
    case 'summarize':
      return { operation: 'summarize', text: sourceText.value }
    case 'detect_missing':
      return {
        operation: 'detect_missing',
        text: sourceText.value,
        doc_type_key: props.draft.doc_type_key || 'unknown',
      }
    case 'translate_tagalog':
      return { operation: 'translate_tagalog', text: selection.value || sourceText.value }
    case 'rewrite_with_clause':
      return {
        operation: 'rewrite_with_clause',
        clause_id: clauseId.value,
        text: sourceText.value,
      }
  }
}

async function run() {
  if (running.value) return
  output.value = null
  aiUnavailable.value = null

  // Per-operation precondition checks — better UX than letting the
  // server return 422 for missing fields.
  if (operation.value === 'rewrite_with_clause' && !clauseId.value) {
    showToast({ title: 'Pick a clause first', icon: 'error' })
    return
  }
  if (!sourceText.value.trim() && !selection.value.trim()) {
    showToast({ title: 'No text to operate on. Add a body or paste a selection.', icon: 'error' })
    return
  }

  running.value = true
  try {
    const res = await $fetch<{ output: string }>('/api/documents/ai-assist', {
      method: 'POST',
      body: payload(),
    })
    output.value = res.output
  } catch (err: any) {
    if (err?.statusCode === 503 && err?.data?.code === 'ai_not_configured') {
      aiUnavailable.value = { admin_path: err.data.admin_path || '/admin/ai-settings' }
    } else {
      showToast({
        title: err?.statusMessage || err?.message || 'AI assist failed',
        icon: 'error',
      })
    }
  } finally {
    running.value = false
  }
}

async function copyOutput() {
  if (!output.value) return
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  try {
    await navigator.clipboard.writeText(output.value)
    showToast({ title: 'Copied to clipboard', icon: 'success' })
  } catch {
    showToast({ title: 'Copy failed', icon: 'error' })
  }
}

const opLabel = computed<string>(() => {
  switch (operation.value) {
    case 'explain':              return 'Explain'
    case 'summarize':            return 'Summarize'
    case 'detect_missing':       return 'Detect missing'
    case 'translate_tagalog':    return 'Translate (Tagalog)'
    case 'rewrite_with_clause':  return 'Rewrite with clause'
  }
})
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-card-title">
          AI Assist
          <UiBadge variant="primary" size="xs" class="ml-1">AI</UiBadge>
        </h3>
        <p class="mt-0.5 text-meta">
          Read-only operations on the current draft. Output is suggestion,
          not authoritative legal text — review carefully.
        </p>
      </div>
    </header>

    <!-- AI not configured CTA -->
    <p
      v-if="aiUnavailable"
      class="mb-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground"
    >
      AI is not configured. A platform admin needs to set the endpoint + key.
      <NuxtLink
        :to="aiUnavailable.admin_path"
        class="ml-1 font-semibold text-primary hover:underline focus-ring rounded"
      >
        Open AI settings →
      </NuxtLink>
    </p>

    <!-- Operation picker -->
    <div role="tablist" aria-label="Operation" class="mb-3 flex flex-wrap gap-1.5">
      <button
        v-for="op in (['explain', 'summarize', 'detect_missing', 'translate_tagalog', 'rewrite_with_clause'] as const)"
        :key="op"
        type="button"
        role="tab"
        :aria-selected="operation === op"
        class="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-ring"
        :class="operation === op
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-foreground hover:bg-accent'"
        @click="operation = op; output = null"
      >
        {{ op.replace('_', ' ').replace('translate tagalog', 'Tagalog') }}
      </button>
    </div>

    <!-- Operation-specific inputs -->
    <div class="mb-3 space-y-2">
      <label
        v-if="operation === 'explain' || operation === 'translate_tagalog'"
        class="block"
      >
        <span class="block text-xs font-medium text-muted-foreground">
          Optional selection (leave empty to use the whole document)
        </span>
        <textarea
          v-model="selection"
          rows="3"
          maxlength="20000"
          placeholder="Paste the specific clause or paragraph here…"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
      </label>

      <label
        v-if="operation === 'rewrite_with_clause'"
        class="block"
      >
        <span class="block text-xs font-medium text-muted-foreground">
          Approved clause to splice in
        </span>
        <select
          v-model="clauseId"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-xs"
        >
          <option value="">— pick a clause —</option>
          <option v-for="c in clauses" :key="c.id" :value="c.id">
            {{ c.title }}
          </option>
        </select>
        <p
          v-if="clauses.length === 0 && !clausesLoading"
          class="mt-1 text-[11px] text-muted-foreground"
        >
          No approved clauses yet — admins publish them in
          <NuxtLink to="/admin/clause-library" class="text-primary hover:underline">
            /admin/clause-library
          </NuxtLink>.
        </p>
      </label>
    </div>

    <button
      type="button"
      class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
      :disabled="running"
      @click="run"
    >
      {{ running ? 'Working…' : `Run ${opLabel}` }}
    </button>

    <!-- Output panel — primary-tinted bg + "review carefully" framing -->
    <article
      v-if="output"
      class="mt-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-3"
    >
      <header class="mb-2 flex items-baseline justify-between gap-2">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-primary">
          {{ opLabel }} · review carefully
        </p>
        <button
          type="button"
          class="text-[11px] font-medium text-primary hover:underline focus-ring rounded"
          @click="copyOutput"
        >
          Copy
        </button>
      </header>
      <p class="whitespace-pre-wrap text-xs text-foreground">{{ output }}</p>
    </article>
  </section>
</template>
