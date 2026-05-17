<script setup lang="ts">
// Reusable government-documents browser. Renders the published library
// grouped by step. Used by:
//   - /documents/government-references (standalone full page)
//   - /document-tabs?tab=government-references (embedded as a tab)
//
// Open access for every authenticated user — RLS on the underlying
// table publishes-only-by-default. Drafts only visible to admins via
// gov_docs.write.

import { computed, onMounted, ref } from 'vue'
import {
  useGovernmentDocuments,
  type GovernmentDocument,
  type GovDocCategory,
  GOV_DOC_CATEGORY_LABELS,
} from '~/composables/useGovernmentDocuments'

defineProps<{
  /** Hide the search input — useful when the embedding page already
   *  provides one (e.g. tab parent's own filter row). Defaults to false. */
  hideSearch?: boolean
}>()

const { listGovDocs } = useGovernmentDocuments()

const items = ref<GovernmentDocument[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const search = ref('')

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const res = await listGovDocs({})
    items.value = res.data
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load documents'
  } finally {
    isLoading.value = false
  }
}

const visibleItems = computed(() => {
  if (!search.value.trim()) return items.value
  const q = search.value.trim().toLowerCase()
  return items.value.filter((it) =>
    (it.title ?? '').toLowerCase().includes(q)
    || (it.description ?? '').toLowerCase().includes(q),
  )
})

const grouped = computed<Array<{ category: GovDocCategory; label: string; rows: GovernmentDocument[] }>>(() => {
  // Display order matches the broker workflow sequence; "other" last.
  const order: GovDocCategory[] = [
    'capital_gains',
    'transfer_tax',
    'registration',
    'tax_declaration',
    'other',
  ]
  return order
    .map((cat) => ({
      category: cat,
      label: GOV_DOC_CATEGORY_LABELS[cat],
      rows: visibleItems.value.filter((it) => it.category === cat),
    }))
    .filter((group) => group.rows.length > 0)
})

function formatBadge(it: GovernmentDocument): string {
  if (it.step_number !== null && it.step_number !== undefined) {
    return `Step ${it.step_number}`
  }
  return it.file_format ? it.file_format.toUpperCase() : 'DOC'
}

onMounted(load)
</script>

<template>
  <div>
    <div
      v-if="!hideSearch"
      class="mb-4 rounded-xl border border-border bg-background p-3 shadow-sm"
    >
      <input
        v-model="search"
        type="text"
        placeholder="Search by title or description…"
        class="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
      />
    </div>

    <div
      v-if="isLoading"
      class="rounded-xl border border-border bg-background p-8 text-center text-sm text-muted-foreground/70"
    >
      Loading…
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
    >
      {{ errorMessage }}
    </div>

    <div
      v-else-if="grouped.length === 0"
      class="rounded-xl border border-border bg-background p-12 text-center text-sm text-muted-foreground/70"
    >
      <p>No documents available yet.</p>
      <p class="mt-1 text-xs">
        An admin can publish reference documents to populate this library.
      </p>
    </div>

    <section
      v-for="group in grouped"
      :key="group.category"
      class="mb-4 overflow-hidden rounded-xl border border-border bg-background shadow-sm"
    >
      <header class="border-b border-border bg-muted/50 px-4 py-2.5">
        <h2 class="text-sm font-semibold text-foreground">{{ group.label }}</h2>
      </header>
      <ul class="divide-y divide-border">
        <li
          v-for="row in group.rows"
          :key="row.id"
          class="px-4 py-3 hover:bg-accent hover:text-accent-foreground"
        >
          <div class="flex items-start gap-3">
            <span class="rounded-md bg-primary/10 px-2 py-1 text-xs font-bold text-primary">
              {{ formatBadge(row) }}
            </span>
            <div class="min-w-0 flex-1">
              <!-- display_url unifies signed_url (S3) and external_url
                   (legacy /img/documents/* paths) — use it directly so
                   either source renders identically. -->
              <a
                v-if="row.display_url"
                :href="row.display_url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sm font-medium text-foreground hover:text-primary"
              >
                {{ row.title }}
              </a>
              <span v-else class="text-sm font-medium text-muted-foreground/70">
                {{ row.title }} (no file)
              </span>
              <p
                v-if="row.description"
                class="mt-1 whitespace-pre-wrap text-xs text-muted-foreground"
              >
                {{ row.description }}
              </p>
              <ul
                v-if="Array.isArray(row.checklist_items) && row.checklist_items.length > 0"
                class="mt-2 space-y-0.5 text-xs text-muted-foreground"
              >
                <li
                  v-for="(c, ci) in row.checklist_items"
                  :key="ci"
                  class="flex items-start gap-1.5"
                >
                  <span aria-hidden="true">•</span>
                  <span>{{ typeof c === 'string' ? c : (c as any)?.label ?? JSON.stringify(c) }}</span>
                </li>
              </ul>
            </div>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
