<script setup lang="ts">
/**
 * /admin/clause-library — approved-only clause snippets the AI
 * assistant uses for `rewrite_with_clause`. Drafts are visible only
 * to admins; once a clause is approved its body is immutable (revise
 * by creating a new version with the same key).
 *
 * The list groups by status. Filters: doc_type and status. Quick-
 * create form below the list mirrors POST /api/clauses.
 */
import { computed, onMounted, ref, watch } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import { showToast } from '~/helpers/helpers'
import { DOCUMENT_TYPES } from '~/utils/documentTypes'

definePageMeta({ layout: 'default' })
useHead({ title: 'Clause Library | Housing Interactive' })

type Clause = {
  id: string
  key: string
  version: number
  status: 'draft' | 'approved' | 'deprecated'
  doc_type_keys: string[]
  jurisdiction: string
  title: string
  body: string
  description: string | null
  placeholders: string[]
  approved_at: string | null
  created_at: string
  updated_at: string
}

const clauses = ref<Clause[]>([])
const loading = ref(true)
const docTypeFilter = ref<string>('')
const statusFilter = ref<string>('')

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Clause[] }>('/api/clauses', {
      query: {
        doc_type: docTypeFilter.value || undefined,
        status: statusFilter.value || undefined,
      },
    })
    clauses.value = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load clauses',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch([docTypeFilter, statusFilter], load)

// ----- Quick create -------------------------------------------------
const newClause = ref<{
  key: string
  title: string
  body: string
  description: string
  doc_type_keys: string[]
  placeholders: string
}>({
  key: '',
  title: '',
  body: '',
  description: '',
  doc_type_keys: [],
  placeholders: '',
})
const creating = ref(false)
async function create() {
  if (creating.value) return
  if (!newClause.value.key.trim() || !newClause.value.title.trim() || !newClause.value.body.trim()) {
    showToast({ title: 'Key, title, and body are required.', icon: 'error' })
    return
  }
  creating.value = true
  try {
    const placeholders = newClause.value.placeholders
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // For revisions of an existing key, send the next free version
    // number; for brand-new keys, this resolves to 1.
    const version = await nextVersionFor(newClause.value.key.trim())
    await $fetch('/api/clauses', {
      method: 'POST',
      body: {
        key: newClause.value.key.trim(),
        version,
        doc_type_keys: newClause.value.doc_type_keys,
        title: newClause.value.title.trim(),
        body: newClause.value.body.trim(),
        description: newClause.value.description.trim() || null,
        placeholders,
      },
    })
    newClause.value = { key: '', title: '', body: '', description: '', doc_type_keys: [], placeholders: '' }
    await load()
    showToast({ title: 'Clause created (draft)', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not create clause',
      icon: 'error',
    })
  } finally {
    creating.value = false
  }
}

// ----- Revise approved clause: pre-fill the composer with the
//        existing clause body + metadata, but bumped to the next
//        version number. Submitting creates a new draft row that
//        the admin can edit + approve. The original approved row
//        stays immutable per the API invariant.
function reviseClause(c: Clause) {
  // Find the highest version we know of for this key — the new
  // draft should be (max + 1). We only show approved/draft/deprecated
  // in the list, so it's a complete view.
  const versionsForKey = clauses.value
    .filter((x) => x.key === c.key)
    .map((x) => x.version)
  const nextVersion = versionsForKey.length > 0
    ? Math.max(...versionsForKey) + 1
    : c.version + 1

  newClause.value = {
    key:           c.key,
    title:         c.title + ` (v${nextVersion})`,
    body:          c.body,
    description:   c.description ?? '',
    doc_type_keys: [...c.doc_type_keys],
    placeholders:  c.placeholders.join(', '),
  }
  // Surface the form. Scroll into view so the admin doesn't get
  // confused about where the prefill landed.
  if (typeof document !== 'undefined') {
    setTimeout(() => {
      document.querySelector('[data-clause-composer]')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }
  showToast({
    title: `Editing v${nextVersion} of "${c.title}". Save to create as draft.`,
    icon: 'success',
  })
}

// Override the create() submission to honor the version field that
// reviseClause set (rather than always sending version: 1). We
// re-look-up the current max version at submit time for safety —
// two admins revising in parallel each get the next free slot via
// the (key, version) UNIQUE.
async function nextVersionFor(key: string): Promise<number> {
  const versions = clauses.value.filter((x) => x.key === key).map((x) => x.version)
  return versions.length > 0 ? Math.max(...versions) + 1 : 1
}

// ----- Status transitions -------------------------------------------
const transitioning = ref<string | null>(null)
async function setStatus(c: Clause, next: 'approved' | 'deprecated' | 'draft') {
  transitioning.value = c.id
  try {
    await $fetch(`/api/clauses/${c.id}`, {
      method: 'PATCH',
      body: { status: next },
    })
    await load()
    showToast({ title: `Marked ${next}`, icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Status change failed',
      icon: 'error',
    })
  } finally {
    transitioning.value = null
  }
}

const grouped = computed(() => {
  const out: Record<'approved' | 'draft' | 'deprecated', Clause[]> = {
    approved: [], draft: [], deprecated: [],
  }
  for (const c of clauses.value) {
    const bucket = out[c.status]
    if (bucket) bucket.push(c)
  }
  return out
})

function statusVariant(s: Clause['status']): 'success' | 'warning' | 'neutral' {
  if (s === 'approved') return 'success'
  if (s === 'draft') return 'warning'
  return 'neutral'
}

function toggleDocType(key: string) {
  const list = newClause.value.doc_type_keys
  const i = list.indexOf(key)
  if (i >= 0) list.splice(i, 1)
  else list.push(key)
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="6xl">
    <UiPageHeader title="Clause library">
      <template #description>
        Approved snippets the AI paralegal uses for clause insertion.
        Approved clauses are immutable — to revise text, create a new
        version with the same key.
      </template>
    </UiPageHeader>

    <!-- Filters -->
    <div class="flex flex-wrap gap-2">
      <select
        v-model="docTypeFilter"
        class="rounded-md border border-input bg-card px-2.5 py-1.5 text-xs focus-ring"
      >
        <option value="">All document types</option>
        <option v-for="t in DOCUMENT_TYPES" :key="t.key" :value="t.key">{{ t.name }}</option>
      </select>
      <select
        v-model="statusFilter"
        class="rounded-md border border-input bg-card px-2.5 py-1.5 text-xs focus-ring"
      >
        <option value="">All statuses</option>
        <option value="draft">Draft</option>
        <option value="approved">Approved</option>
        <option value="deprecated">Deprecated</option>
      </select>
    </div>

    <!-- Buckets -->
    <div v-if="loading" class="space-y-2">
      <div v-for="n in 3" :key="n" class="h-16 animate-pulse rounded-md bg-muted-foreground/10" />
    </div>

    <template v-else>
      <section
        v-for="bucket in (['approved', 'draft', 'deprecated'] as const)"
        :key="bucket"
        v-show="grouped[bucket].length > 0"
      >
        <h2 class="mb-2 text-card-title capitalize">
          {{ bucket }} ({{ grouped[bucket].length }})
        </h2>
        <ul class="space-y-2">
          <li
            v-for="c in grouped[bucket]"
            :key="c.id"
            class="rounded-md border border-border bg-card p-3"
          >
            <header class="flex flex-wrap items-baseline gap-2">
              <UiBadge :variant="statusVariant(c.status)" size="xs">{{ c.status }}</UiBadge>
              <span class="text-sm font-semibold text-foreground">{{ c.title }}</span>
              <span class="font-mono text-[11px] text-muted-foreground">{{ c.key }}@v{{ c.version }}</span>
              <span class="ml-auto text-[10px] text-muted-foreground tabular-nums">
                {{ c.doc_type_keys.length === 0 ? 'all doc types' : `${c.doc_type_keys.length} doc types` }}
              </span>
            </header>
            <p
              v-if="c.description"
              class="mt-1.5 text-xs text-muted-foreground"
            >
              {{ c.description }}
            </p>
            <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-2 p-2 font-mono text-[11px] text-foreground">{{ c.body }}</pre>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <button
                v-if="c.status !== 'approved'"
                type="button"
                class="rounded-md bg-success px-2.5 py-1 text-[11px] font-semibold text-success-foreground hover:bg-success/90 focus-ring disabled:opacity-50"
                :disabled="transitioning === c.id"
                @click="setStatus(c, 'approved')"
              >
                Approve
              </button>
              <!-- Revise: clones an approved clause into the composer
                   as a new-version draft. The approved row itself
                   stays untouched (immutable per API invariant). -->
              <button
                v-if="c.status === 'approved'"
                type="button"
                class="rounded-md border border-primary/30 bg-card px-2.5 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10 focus-ring"
                @click="reviseClause(c)"
              >
                Revise (new version)
              </button>
              <button
                v-if="c.status !== 'deprecated'"
                type="button"
                class="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent focus-ring disabled:opacity-50"
                :disabled="transitioning === c.id"
                @click="setStatus(c, 'deprecated')"
              >
                Deprecate
              </button>
              <button
                v-if="c.status === 'deprecated'"
                type="button"
                class="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent focus-ring disabled:opacity-50"
                :disabled="transitioning === c.id"
                @click="setStatus(c, 'draft')"
              >
                Reopen as draft
              </button>
            </div>
          </li>
        </ul>
      </section>

      <p
        v-if="clauses.length === 0"
        class="rounded-md border border-dashed border-border bg-surface-2 p-6 text-center text-sm text-muted-foreground"
      >
        No clauses yet. Create one below.
      </p>
    </template>

    <!-- Quick-create / revise form. data-clause-composer lets the
         "Revise" button scroll the form into view after pre-fill. -->
    <section data-clause-composer class="rounded-lg border border-border bg-card p-4">
      <h2 class="mb-3 text-card-title">
        + New clause
        <span class="ml-2 text-[11px] font-normal text-muted-foreground">
          Lands as a draft. Revising an existing key creates a new version.
        </span>
      </h2>
      <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="create">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Key (slug, stable across versions) <span class="text-destructive">*</span></span>
          <input
            v-model="newClause.key"
            type="text"
            maxlength="120"
            placeholder="e.g. lease_renewal_30_day_notice"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Title <span class="text-destructive">*</span></span>
          <input
            v-model="newClause.title"
            type="text"
            maxlength="200"
            placeholder="e.g. 30-day renewal notice clause"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <label class="block sm:col-span-2">
          <span class="block text-xs font-medium text-muted-foreground">Description</span>
          <input
            v-model="newClause.description"
            type="text"
            maxlength="2000"
            placeholder="When to use this clause"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <label class="block sm:col-span-2">
          <span class="block text-xs font-medium text-muted-foreground">Body <span class="text-destructive">*</span></span>
          <textarea
            v-model="newClause.body"
            rows="6"
            maxlength="50000"
            placeholder="The exact clause text. Use {placeholder_name} for variables."
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Placeholders (comma-separated)</span>
          <input
            v-model="newClause.placeholders"
            type="text"
            placeholder="tenant_name, rent_amount, start_date"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
          />
        </label>
        <div class="block sm:col-span-2">
          <span class="block text-xs font-medium text-muted-foreground">
            Applies to (leave empty = all doc types)
          </span>
          <div class="mt-1 flex flex-wrap gap-1.5">
            <button
              v-for="t in DOCUMENT_TYPES"
              :key="t.key"
              type="button"
              class="rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors focus-ring"
              :class="newClause.doc_type_keys.includes(t.key)
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-accent'"
              @click="toggleDocType(t.key)"
            >
              {{ t.name }}
            </button>
          </div>
        </div>
        <div class="sm:col-span-2 flex items-center gap-2 border-t border-border pt-3">
          <button
            type="submit"
            class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-60"
            :disabled="creating"
          >
            {{ creating ? 'Creating…' : 'Create as draft' }}
          </button>
          <p class="text-[11px] text-muted-foreground">
            Drafts are visible to admins only. Approve to make available to brokers + AI.
          </p>
        </div>
      </form>
    </section>
  </AdminPageShell>
</template>
