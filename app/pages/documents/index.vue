<script setup lang="ts">
// Unified /documents dashboard. Replaces the older /documents (now at
// /documents-legacy) and the dispersed tab pages. Shows every document
// the caller has generated, with type/format/date filters and per-row
// actions.
//
// Data flow: useDocuments().listDocuments() → /api/documents/list (RLS
// enforces created_by = auth.uid()). Signed URLs are pre-baked by the
// server; the table just links to them.

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  useDocuments,
  type GeneratedDocument,
  DOCUMENT_TYPE_LABEL,
} from '~/composables/useDocuments'
import { showToast } from '~/helpers/helpers'

definePageMeta({
  layout: 'default',
})

useHead({ title: 'Documents | Housinginteractive' })

const router = useRouter()
const { listDocuments, deleteDocument, labelFor, iconFor, generatorPathFor } =
  useDocuments()

const documents = ref<GeneratedDocument[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const deletingId = ref<string | null>(null)

const search = ref('')
const typeFilter = ref<'' | string>('')
const formatFilter = ref<'' | 'pdf' | 'docx'>('')
const sort = ref<'recent' | 'oldest' | 'name'>('recent')

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    documents.value = await listDocuments()
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Failed to load documents.'
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

// Filtering + sorting are client-side because the server already returns
// the user's full set; for a typical user (~tens to hundreds of docs)
// this stays under a few KB. If volumes grow past ~1k, push the filter
// into the API.
const filtered = computed<GeneratedDocument[]>(() => {
  let rows = documents.value
  if (typeFilter.value) rows = rows.filter((d) => d.document_type === typeFilter.value)
  if (formatFilter.value) rows = rows.filter((d) => d.file_format === formatFilter.value)
  if (search.value.trim() !== '') {
    const q = search.value.trim().toLowerCase()
    rows = rows.filter((d) => {
      const haystack = [
        d.documentName,
        d.file_name,
        labelFor(d.document_type),
        ...Object.values(d.metadata ?? {}).map((v) => String(v ?? '')),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }

  const sorted = [...rows]
  if (sort.value === 'recent') {
    sorted.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  } else if (sort.value === 'oldest') {
    sorted.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
  } else {
    sorted.sort((a, b) =>
      (a.documentName || a.file_name).localeCompare(b.documentName || b.file_name),
    )
  }
  return sorted
})

const typeOptions = computed(() => {
  const present = new Set(documents.value.map((d) => d.document_type))
  return Object.entries(DOCUMENT_TYPE_LABEL).filter(([k]) => present.has(k))
})

const counts = computed(() => {
  const total = documents.value.length
  const byType = new Map<string, number>()
  for (const d of documents.value) {
    byType.set(d.document_type, (byType.get(d.document_type) ?? 0) + 1)
  }
  return { total, byType }
})

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
}

function metaLine(doc: GeneratedDocument): string {
  const m = doc.metadata ?? {}
  const bits: string[] = []
  for (const key of ['client_name', 'lessee_name', 'lessor_name', 'property_id', 'listing_id']) {
    const v = (m as any)[key]
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      bits.push(`${key.replace(/_/g, ' ')}: ${v}`)
    }
  }
  return bits.join(' · ')
}

function open(doc: GeneratedDocument) {
  if (!doc.documentUrl) {
    showToast({ title: 'Document URL is unavailable.', icon: 'warning' })
    return
  }
  window.open(doc.documentUrl, '_blank', 'noopener')
}

async function regenerate(doc: GeneratedDocument) {
  const path = generatorPathFor(doc.document_type)
  if (!path) {
    showToast({ title: 'No generator wired for this type yet.', icon: 'info' })
    return
  }
  router.push(path)
}

async function remove(doc: GeneratedDocument) {
  const ok = window.confirm(`Delete "${doc.documentName || doc.file_name}"? This cannot be undone.`)
  if (!ok) return
  deletingId.value = doc.id
  try {
    await deleteDocument(doc.id)
    documents.value = documents.value.filter((d) => d.id !== doc.id)
    showToast({ title: 'Document deleted.', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not delete document.', icon: 'error' })
  } finally {
    deletingId.value = null
  }
}
</script>

<template>
  <div class="px-4 py-6 sm:px-6 lg:px-8">
    <header class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="text-page-title">Documents</h1>
        <p class="text-sm text-muted-foreground">
          Every document you've generated. Search, filter, download, or delete.
        </p>
      </div>
      <NuxtLink
        to="/document-tabs"
        class="self-start rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring sm:self-auto"
      >
        + Generate new
      </NuxtLink>
    </header>

    <!-- KPI strip — quick at-a-glance counts. -->
    <div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-xl border border-border bg-background p-3">
        <p class="text-xs uppercase tracking-wide text-muted-foreground">Total</p>
        <p class="mt-0.5 text-xl font-semibold text-foreground">
          {{ counts.total }}
        </p>
      </div>
      <div
        v-for="(label, type) in DOCUMENT_TYPE_LABEL"
        :key="type"
        v-show="counts.byType.get(type as string)"
        class="hidden rounded-xl border border-border bg-background p-3 sm:block"
      >
        <p class="truncate text-xs uppercase tracking-wide text-muted-foreground" :title="label">
          {{ label }}
        </p>
        <p class="mt-0.5 text-xl font-semibold text-foreground">
          {{ counts.byType.get(type as string) ?? 0 }}
        </p>
      </div>
    </div>

    <!-- Filters -->
    <div class="mb-4 flex flex-col gap-3 rounded-xl border border-border bg-background p-3 sm:flex-row sm:flex-wrap sm:items-center">
      <input
        v-model="search"
        type="search"
        placeholder="Search by name, client, listing id…"
        class="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 sm:max-w-md"
      />
      <select
        v-model="typeFilter"
        class="rounded-md border border-border px-2 py-1.5 text-xs"
      >
        <option value="">All types</option>
        <option v-for="[type, label] in typeOptions" :key="type" :value="type">
          {{ label }}
        </option>
      </select>
      <select
        v-model="formatFilter"
        class="rounded-md border border-border px-2 py-1.5 text-xs"
      >
        <option value="">All formats</option>
        <option value="pdf">PDF</option>
        <option value="docx">DOCX</option>
      </select>
      <select
        v-model="sort"
        class="rounded-md border border-border px-2 py-1.5 text-xs"
      >
        <option value="recent">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="name">Name (A→Z)</option>
      </select>
      <span class="ml-auto text-xs text-muted-foreground">
        Showing {{ filtered.length }} of {{ counts.total }}
      </span>
    </div>

    <ul
      v-if="isLoading"
      class="divide-y divide-border rounded-xl border border-border bg-card"
    >
      <li v-for="n in 6" :key="n" class="flex items-center gap-3 px-4 py-3">
        <div class="h-9 w-9 animate-pulse rounded-md bg-muted" />
        <div class="flex-1 space-y-2">
          <div class="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <div class="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      </li>
    </ul>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-center"
    >
      <p class="text-sm text-destructive">{{ errorMessage }}</p>
      <button
        type="button"
        class="mt-3 rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-colors duration-150 ease-out hover:bg-destructive/90 focus-ring"
        @click="load"
      >
        Try again
      </button>
    </div>

    <div
      v-else-if="filtered.length === 0"
      class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center"
    >
      <div class="mb-3 text-3xl">📄</div>
      <h2 class="text-base font-semibold text-foreground">
        {{ counts.total === 0 ? 'No documents yet' : 'No matches' }}
      </h2>
      <p class="mt-1 max-w-sm text-sm text-muted-foreground">
        {{
          counts.total === 0
            ? 'Generate your first viewing list, contract, or letter to see it here.'
            : 'Try a different search or filter.'
        }}
      </p>
      <NuxtLink
        v-if="counts.total === 0"
        to="/document-tabs"
        class="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
      >
        + Generate new
      </NuxtLink>
    </div>

    <ul
      v-else
      class="divide-y divide-border rounded-xl border border-border bg-card"
    >
      <li
        v-for="doc in filtered"
        :key="doc.id"
        class="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
      >
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-lg"
          aria-hidden="true"
        >
          {{ iconFor(doc.document_type) }}
        </div>
        <div class="min-w-0 flex-1">
          <button
            type="button"
            class="block max-w-full truncate text-left text-sm font-semibold text-foreground hover:text-primary hover:underline"
            @click="open(doc)"
          >
            {{ doc.documentName || doc.file_name }}
          </button>
          <p class="truncate text-xs text-muted-foreground">
            <span class="inline-flex items-center gap-1">
              <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {{ doc.file_format }}
              </span>
              {{ labelFor(doc.document_type) }}
            </span>
            <span class="ml-2 text-muted-foreground/70">{{ formatTimestamp(doc.created_at) }}</span>
            <span v-if="metaLine(doc)" class="ml-2 text-muted-foreground/70"> · {{ metaLine(doc) }}</span>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button
            v-if="doc.documentUrl"
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
            @click="open(doc)"
          >
            Open
          </button>
          <button
            type="button"
            class="rounded-md bg-muted px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
            @click="regenerate(doc)"
            title="Open the generator for this document type"
          >
            Regenerate
          </button>
          <button
            type="button"
            class="rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="deletingId === doc.id"
            @click="remove(doc)"
          >
            <span v-if="deletingId === doc.id">Deleting…</span>
            <span v-else>Delete</span>
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>
