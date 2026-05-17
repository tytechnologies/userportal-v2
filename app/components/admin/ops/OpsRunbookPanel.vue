<script setup lang="ts">
/**
 * OpsRunbookPanel — collapsible panel that renders an operator runbook
 * (markdown file from docs/) inline.
 *
 * Why we don't pull in marked/markdown-it: this is the only consumer
 * and the runbooks use a small subset (h1-h3, paragraphs, ul, fenced
 * code, tables, hr). A 50-line custom renderer ships zero kb extra.
 *
 * Usage:
 *   <OpsRunbookPanel slug="eis-submitter-runbook" title="EIS submitter" />
 */
import { ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

const props = withDefaults(
  defineProps<{
    slug: string
    title: string
    /** Render expanded by default. */
    open?: boolean
  }>(),
  { open: false },
)

const expanded = ref(props.open)
const loading = ref(false)
const error = ref<string | null>(null)
const html = ref<string>('')

async function load() {
  if (html.value || loading.value) return
  loading.value = true
  error.value = null
  try {
    const res = await $fetch<{ markdown: string }>(`/api/admin/docs/${props.slug}`)
    html.value = renderMarkdown(res.markdown)
  } catch (err: any) {
    error.value = err?.statusMessage || err?.message || 'Could not load runbook'
    showToast({ title: error.value ?? '', icon: 'error' })
  } finally {
    loading.value = false
  }
}

watch(expanded, (v) => {
  if (v) load()
})

if (props.open) load()

// ---------- minimal markdown renderer ----------
//
// Handles: h1-h4, paragraphs, ul (- and *), fenced ```, inline `code`,
// links [text](url), bold **x**, italic *x*, hr (---), tables (pipe).
// Anything else falls through as-is. HTML-escapes content first.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderInline(s: string): string {
  let out = escapeHtml(s)
  // Inline code (highest priority — protect contents from later rules)
  out = out.replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">$1</code>')
  // Links
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-primary hover:underline" target="_blank" rel="noopener">$1</a>')
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold">$1</strong>')
  // Italic (single * not adjacent to a word char on either side)
  out = out.replace(/(^|[^\w*])\*([^\s*][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
  return out
}

function renderTable(lines: string[]): string {
  // First line = header, second = alignment, rest = body. Caller
  // (renderMarkdown) only invokes when lines.length >= 2 — bang the
  // header read since the runtime guarantee escapes static analysis.
  const header = lines[0]!.split('|').slice(1, -1).map((c) => c.trim())
  const body = lines.slice(2).map((row) =>
    row.split('|').slice(1, -1).map((c) => c.trim()),
  )
  const head =
    '<thead class="bg-muted/40"><tr>' +
    header
      .map(
        (h) =>
          `<th class="px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">${renderInline(h)}</th>`,
      )
      .join('') +
    '</tr></thead>'
  const rows = body
    .map(
      (r) =>
        '<tr>' +
        r
          .map(
            (c) =>
              `<td class="px-2 py-1.5 text-sm text-foreground align-top">${renderInline(c)}</td>`,
          )
          .join('') +
        '</tr>',
    )
    .join('')
  return `<div class="overflow-x-auto"><table class="min-w-full divide-y divide-border">${head}<tbody class="divide-y divide-border">${rows}</tbody></table></div>`
}

function renderMarkdown(src: string): string {
  const lines = src.split('\n')
  const parts: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        buf.push(lines[i]!)
        i++
      }
      i++ // closing fence
      const langClass = lang ? ` data-lang="${escapeHtml(lang)}"` : ''
      parts.push(
        `<pre class="my-3 overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-[11px] text-foreground"${langClass}><code>${escapeHtml(buf.join('\n'))}</code></pre>`,
      )
      continue
    }

    // Table — current line + lookahead must look like | a | b |
    if (line.startsWith('|') && lines[i + 1]?.match(/^\|\s*-+/)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i]!.startsWith('|')) {
        tableLines.push(lines[i]!)
        i++
      }
      parts.push(renderTable(tableLines))
      continue
    }

    // Heading
    const h = line.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      const level = h[1]!.length
      const sizeClass =
        level === 1
          ? 'mt-4 mb-3 text-xl font-semibold text-foreground'
          : level === 2
            ? 'mt-4 mb-2 text-base font-semibold text-foreground'
            : level === 3
              ? 'mt-3 mb-1 text-sm font-semibold text-foreground'
              : 'mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground'
      parts.push(`<h${level} class="${sizeClass}">${renderInline(h[2]!)}</h${level}>`)
      i++
      continue
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      parts.push('<hr class="my-4 border-border" />')
      i++
      continue
    }

    // Bullet list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*]\s+/, ''))
        i++
      }
      parts.push(
        '<ul class="my-2 ml-5 list-disc space-y-1 text-sm text-foreground">' +
          items.map((it) => `<li>${renderInline(it)}</li>`).join('') +
          '</ul>',
      )
      continue
    }

    // Numbered list (very simple — no nesting)
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ''))
        i++
      }
      parts.push(
        '<ol class="my-2 ml-5 list-decimal space-y-1 text-sm text-foreground">' +
          items.map((it) => `<li>${renderInline(it)}</li>`).join('') +
          '</ol>',
      )
      continue
    }

    // Blank line — paragraph break
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph (consume until blank/structural line)
    const paraLines: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.startsWith('#') &&
      !lines[i]!.startsWith('```') &&
      !lines[i]!.startsWith('|') &&
      !/^[-*]\s+/.test(lines[i]!) &&
      !/^\d+\.\s+/.test(lines[i]!) &&
      !/^---+\s*$/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!)
      i++
    }
    parts.push(`<p class="my-2 text-sm text-foreground">${renderInline(paraLines.join(' '))}</p>`)
  }
  return parts.join('\n')
}
</script>

<template>
  <section class="rounded-lg border border-border bg-card text-card-foreground">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-accent hover:text-accent-foreground"
      @click="expanded = !expanded"
    >
      <div>
        <h2 class="text-base font-semibold text-foreground">
          {{ title }} <span class="ml-1 text-xs font-normal text-muted-foreground">runbook</span>
        </h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          docs/{{ slug }}.md — operator setup, verification, and failure modes
        </p>
      </div>
      <span class="text-xs text-muted-foreground">{{ expanded ? 'â–¾' : 'â–¸' }}</span>
    </button>
    <div v-if="expanded" class="border-t border-border px-5 py-4">
      <div v-if="loading" class="text-sm text-muted-foreground">Loading runbook…</div>
      <div v-else-if="error" class="text-sm text-destructive">{{ error }}</div>
      <div v-else class="markdown-body" v-html="html" />
    </div>
  </section>
</template>
