<script setup lang="ts">
/**
 * Editor for AI-generated freeform drafts.
 *
 * Used when a draft has no template_id (so DocumentEditor's
 * field-overlay-on-PDF flow doesn't apply) and no storage_path (so
 * DocumentImportViewer doesn't apply either) — but does carry an
 * AI-generated body in data.ai_body.
 *
 * Surface:
 *   - read-only prompt + doc type chip at the top so the broker
 *     remembers what they asked for
 *   - large editable textarea seeded with data.ai_body
 *   - save button (disabled while clean, primary while dirty)
 *
 * Persists via PATCH /api/document-drafts/:id with the full data
 * blob preserved (ai_prompt + ai_doc_type stay; only ai_body
 * changes). The broker can also Print or copy-out from the browser
 * — there's no in-app PDF render for freeform bodies in v1; the
 * "Upload signed" affordance below is how a finalized document gets
 * into the system of record.
 */
import { computed, ref, watch } from 'vue'
import { useDocumentDrafts, type DocumentDraft } from '~/composables/useDocumentDrafts'
import { showToast } from '~/helpers/helpers'
import { aiMarkdownToHtml } from '~/utils/aiMarkdown'

const props = defineProps<{
  draft: DocumentDraft
}>()

const emit = defineEmits<{
  (e: 'saved', draft: DocumentDraft): void
}>()

const { saveDraft } = useDocumentDrafts()

// The editable body. Initialized from data.ai_body and re-seeded if
// the parent passes a different draft.
const body = ref<string>('')
const saving = ref(false)

function reseed() {
  const d = props.draft.data as Record<string, unknown> | null
  body.value = typeof d?.ai_body === 'string' ? (d.ai_body as string) : ''
}
watch(() => props.draft.id, reseed, { immediate: true })

// Read-only context fields surfaced above the editor.
const aiPrompt = computed<string>(() => {
  const d = props.draft.data as Record<string, unknown> | null
  return typeof d?.ai_prompt === 'string' ? (d.ai_prompt as string) : ''
})
const aiDocType = computed<string>(() => {
  const d = props.draft.data as Record<string, unknown> | null
  return typeof d?.ai_doc_type === 'string' ? (d.ai_doc_type as string) : ''
})

const isDirty = computed(() => {
  const d = props.draft.data as Record<string, unknown> | null
  const original = typeof d?.ai_body === 'string' ? (d.ai_body as string) : ''
  return body.value !== original
})

// Editor view modes:
//   'edit'  → markdown source only (full-width textarea)
//   'split' → markdown source + live rendered preview side-by-side
//   'preview' → rendered preview only (final-look check)
type ViewMode = 'edit' | 'split' | 'preview'
const viewMode = ref<ViewMode>('split')

// Render the body through the shared aiMarkdown parser. The HTML is
// safe by construction — the parser HTML-escapes every span before
// emitting tags. Same parser feeds the DOCX + PDF exporters so the
// preview matches what the broker downloads.
const renderedHtml = computed(() => aiMarkdownToHtml(body.value))

async function onSave() {
  if (!isDirty.value || saving.value) return
  saving.value = true
  try {
    // Spread the existing data so unrelated fields (ai_prompt,
    // ai_doc_type, finalized-PDF pointer) are preserved. Only
    // ai_body changes here.
    const nextData = {
      ...(props.draft.data as Record<string, unknown> | null ?? {}),
      ai_body: body.value,
    }
    const updated = await saveDraft(props.draft.id, { data: nextData })
    showToast({ title: 'Draft saved', icon: 'success' })
    emit('saved', updated)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Save failed',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}

function onPrint() {
  if (typeof window === 'undefined') return
  // Print-window mirrors the document.scribd / formal-contract look:
  // serif body, centered uppercase title, justified paragraphs,
  // numbered headings. Same markdown parser the export pipeline uses
  // so what the broker sees here matches the DOCX + PDF artifacts.
  const html = aiMarkdownToHtml(body.value)
  const title = (props.draft.title || 'Document').replace(/[<>&]/g, '')
  const w = window.open('', '_blank', 'width=900,height=1100')
  if (!w) return
  w.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  /* Match the PDF export: 1in top/right/bottom + 1.5in left for
     binding gutter (PH legal printing convention). */
  @page { size: Letter; margin: 1in 1in 1in 1.5in; }
  body {
    font-family: 'Times New Roman', Georgia, serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #000;
    margin: 0;
    padding: 0;
    text-align: justify;
  }
  h1 {
    text-align: center; font-size: 16pt; letter-spacing: 0.06em;
    margin: 0 0 0.5em 0; font-weight: bold;
    text-transform: uppercase; line-height: 1.3;
  }
  h2 {
    text-align: center; font-size: 13pt; letter-spacing: 0.04em;
    margin: 1.6em 0 0.5em 0; font-weight: bold;
    text-transform: uppercase; line-height: 1.3;
  }
  h3 {
    font-size: 12pt; margin: 1.1em 0 0.3em 0;
    font-weight: bold; line-height: 1.3;
  }
  p { margin: 0 0 0.6em 0; orphans: 2; widows: 2; text-indent: 0.5in; }
  p:first-of-type, h1 + p, h2 + p, h3 + p { text-indent: 0; }
  ol, ul { margin: 0.5em 0 1em 0.5in; padding: 0; text-align: left; }
  li { margin: 0.3em 0; padding-left: 0.25in; }
  blockquote { margin: 0.7em 0.5in; font-style: italic; color: #444; }
  hr { border: 0; border-top: 1px solid #999; margin: 1.5em 0; }
  strong { font-weight: bold; }
  em { font-style: italic; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>${html}</body>
</html>`)
  w.document.close()
  w.focus()
  setTimeout(() => w.print(), 250)
}
</script>

<template>
  <div class="space-y-4">
    <!-- Context strip — what the broker asked for, frozen at gen time -->
    <section
      v-if="aiPrompt || aiDocType"
      class="rounded-md border border-border bg-surface-2 p-3"
    >
      <header class="mb-1.5 flex items-baseline justify-between gap-2">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          AI generation context
        </p>
        <span
          v-if="aiDocType"
          class="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary"
        >
          {{ aiDocType }}
        </span>
      </header>
      <p
        v-if="aiPrompt"
        class="whitespace-pre-wrap text-xs text-foreground/80"
      >
        {{ aiPrompt }}
      </p>
    </section>

    <!-- View-mode toggle. Edit-only for raw markdown work, Split for
         the broker who wants to see the rendered output as they type,
         and Preview for the final-look check before download. -->
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-muted-foreground">
        Document body
        <span v-if="isDirty" class="ml-1 text-warning" aria-label="Unsaved changes">
          · unsaved
        </span>
      </span>
      <div
        class="inline-flex rounded-md border border-border bg-card p-0.5 text-[11px]"
        role="tablist"
        aria-label="Editor view"
      >
        <button
          v-for="m in (['edit', 'split', 'preview'] as ViewMode[])"
          :key="m"
          type="button"
          class="rounded px-2.5 py-1 font-semibold capitalize transition-colors"
          :class="viewMode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
          @click="viewMode = m"
        >
          {{ m }}
        </button>
      </div>
    </div>

    <!-- Edit-only or split: textarea visible. -->
    <div
      v-if="viewMode !== 'preview'"
      class="grid gap-3"
      :class="viewMode === 'split' ? 'lg:grid-cols-2' : ''"
    >
      <textarea
        v-model="body"
        rows="28"
        spellcheck="false"
        class="block w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        placeholder="Markdown source — start with `# TITLE`, `## I. Section`, etc. The renderer formats headings, bold, lists, signature blocks automatically."
      />

      <!-- Live preview pane (split view only). Same CSS as the
           print/export so what the broker reads here matches the
           DOCX + PDF artifacts. -->
      <div
        v-if="viewMode === 'split'"
        class="document-preview overflow-y-auto rounded-md border border-border bg-card px-6 py-5"
        v-html="renderedHtml"
      />
    </div>

    <!-- Preview-only: full-width rendered document, hides textarea. -->
    <div
      v-else
      class="document-preview rounded-md border border-border bg-card px-8 py-6"
      v-html="renderedHtml"
    />

    <div class="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <button
        type="button"
        class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="!isDirty || saving"
        @click="onSave"
      >
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
      <button
        type="button"
        class="rounded-md border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-ring"
        @click="onPrint"
      >
        Print
      </button>
      <p class="ml-auto text-[11px] text-muted-foreground">
        AI-generated text is a starting point — review carefully before sharing or finalizing.
      </p>
    </div>
  </div>
</template>

<style scoped>
/* Document-preview typography. Matches the PDF/print stylesheet so
   what the broker sees in the editor preview is the same shape that
   lands in the DOCX + PDF artifacts:
     - Times New Roman 12pt, 1.5 line spacing, justified
     - centered UPPERCASE H1/H2 (16pt / 13pt bold)
     - 0.5in first-line indent (legal typography convention)
     - list, blockquote, hr styling consistent across surfaces
   v-html target — :deep selectors so scoped styles reach into the
   parser-emitted markup. */
.document-preview {
  font-family: 'Times New Roman', Georgia, serif;
  font-size: 14px; /* on-screen 14px ≈ 12pt @ 96dpi */
  line-height: 1.5;
  color: #000;
  text-align: justify;
}
.document-preview :deep(h1) {
  text-align: center;
  font-size: 1.35em; /* ~16pt */
  letter-spacing: 0.06em;
  margin: 0 0 0.6em 0;
  font-weight: bold;
  text-transform: uppercase;
  line-height: 1.3;
}
.document-preview :deep(h2) {
  text-align: center;
  font-size: 1.1em; /* ~13pt */
  letter-spacing: 0.04em;
  margin: 1.6em 0 0.6em 0;
  font-weight: bold;
  text-transform: uppercase;
  line-height: 1.3;
}
.document-preview :deep(h3) {
  font-size: 1em;
  margin: 1.1em 0 0.3em 0;
  font-weight: bold;
  line-height: 1.3;
}
.document-preview :deep(p) {
  margin: 0 0 0.6em 0;
  text-indent: 0.5in;
}
.document-preview :deep(h1 + p),
.document-preview :deep(h2 + p),
.document-preview :deep(h3 + p),
.document-preview :deep(p:first-of-type) {
  text-indent: 0;
}
.document-preview :deep(ol),
.document-preview :deep(ul) {
  margin: 0.5em 0 1em 0.5in;
  padding: 0;
  text-align: left;
}
.document-preview :deep(li) {
  margin: 0.3em 0;
  padding-left: 0.25in;
}
.document-preview :deep(blockquote) {
  margin: 0.7em 0.5in;
  font-style: italic;
  color: #444;
}
.document-preview :deep(hr) {
  border: 0;
  border-top: 1px solid #999;
  margin: 1.5em 0;
}
.document-preview :deep(strong) { font-weight: bold; }
.document-preview :deep(em)     { font-style: italic; }
</style>
