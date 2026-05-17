<script setup lang="ts">
// Admin: list / create document templates. Gated by templates.manage
// permission via the same client-side check as other admin pages —
// RLS double-checks every mutation, so a bypassed UI gate produces a
// 403 from PostgREST.

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import {
  useTemplateDefinitions,
  type TemplateDefinition,
  type TemplateStatus,
} from '~/composables/useTemplateDefinitions'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Document Templates | Admin' })

const router = useRouter()
const { listTemplates, createTemplate, deleteTemplate } = useTemplateDefinitions()

const isChecking = ref(true)
const allowed = ref(false)
const templates = ref<TemplateDefinition[]>([])
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)
const statusFilter = ref<'' | TemplateStatus>('')

const showCreate = ref(false)
const newId = ref('')
const newName = ref('')
const isCreating = ref(false)

onMounted(async () => {
  const ok = await hasPermission('templates.manage')
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'You do not have access to template management.', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await load()
})

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    templates.value = await listTemplates({
      status: statusFilter.value || undefined,
    })
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load templates.'
  } finally {
    isLoading.value = false
  }
}

const filtered = computed(() => templates.value)

async function create() {
  if (!newId.value || !newName.value) {
    showToast({ title: 'Both id and name are required.', icon: 'warning' })
    return
  }
  isCreating.value = true
  try {
    const created = await createTemplate({
      id: newId.value,
      name: newName.value,
      status: 'draft',
    })
    showCreate.value = false
    newId.value = ''
    newName.value = ''
    showToast({ title: 'Template created. Open to design.', icon: 'success' })
    router.push(`/admin/document-templates/${created.id}`)
  } catch (err: any) {
    showToast({ title: err?.statusMessage || err?.message || 'Create failed.', icon: 'error' })
  } finally {
    isCreating.value = false
  }
}

async function remove(t: TemplateDefinition) {
  if (!window.confirm(`Delete template "${t.name}"? Existing drafts using it become orphaned (use Archive instead if drafts depend on it).`)) return
  try {
    await deleteTemplate(t.id)
    templates.value = templates.value.filter((x) => x.id !== t.id)
    showToast({ title: 'Template deleted.', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || err?.message || 'Delete failed.', icon: 'error' })
  }
}

function statusBadgeClass(s: TemplateStatus): string {
  return s === 'published' ? 'bg-success/15 text-success'
    : s === 'archived'    ? 'bg-muted text-muted-foreground'
    :                       'bg-warning/15 text-warning'
}
</script>

<template>
  <div class="px-4 py-6 sm:px-6 lg:px-8">
    <header class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 class="text-page-title">Document templates</h1>
        <p class="text-sm text-muted-foreground">
          Create and manage editable document templates. Published templates appear in the draft picker.
        </p>
      </div>
      <button
        type="button"
        class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        @click="showCreate = !showCreate"
        :disabled="!allowed"
      >
        + New template
      </button>
    </header>

    <div
      v-if="isChecking"
      class="rounded-xl border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <div v-else-if="allowed">
      <!-- Inline create form. -->
      <div
        v-if="showCreate"
        class="mb-4 rounded-xl border border-border bg-card p-4 shadow-sm"
      >
        <h2 class="mb-3 text-sm font-semibold text-foreground">New template</h2>
        <div class="grid gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end">
          <label class="block text-xs">
            <span class="font-semibold text-foreground">Slug id</span>
            <input
              v-model="newId"
              type="text"
              placeholder="lease_agreement_v2"
              class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span class="mt-1 block text-muted-foreground">snake_case, lowercase. Stable identifier.</span>
          </label>
          <label class="block text-xs">
            <span class="font-semibold text-foreground">Name</span>
            <input
              v-model="newName"
              type="text"
              placeholder="Lease Agreement v2"
              class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <button
            type="button"
            class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            :disabled="isCreating"
            @click="create"
          >
            <span v-if="isCreating">Creating…</span>
            <span v-else>Create</span>
          </button>
        </div>
      </div>

      <!-- Filters. -->
      <div class="mb-4 flex items-center gap-2">
        <label class="text-xs font-semibold text-muted-foreground">Status</label>
        <select
          v-model="statusFilter"
          class="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          @change="load"
        >
          <option value="">All</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      <ul
        v-if="isLoading"
        class="divide-y divide-border rounded-xl border border-border bg-card"
      >
        <li v-for="n in 4" :key="n" class="px-4 py-3">
          <div class="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <div class="mt-2 h-3 w-1/2 animate-pulse rounded bg-muted" />
        </li>
      </ul>

      <div
        v-else-if="errorMessage"
        class="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-center text-sm text-destructive"
      >
        {{ errorMessage }}
        <button class="ml-2 underline" @click="load">Try again</button>
      </div>

      <div
        v-else-if="filtered.length === 0"
        class="rounded-xl border border-dashed border-border bg-card p-5 text-center text-sm text-muted-foreground"
      >
        No templates yet. Click "New template" to create one.
      </div>

      <ul
        v-else
        class="divide-y divide-border rounded-xl border border-border bg-card"
      >
        <li
          v-for="t in filtered"
          :key="t.id"
          class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-foreground">{{ t.name }}</p>
            <p class="truncate text-xs text-muted-foreground">
              <span
                class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                :class="statusBadgeClass(t.status)"
              >{{ t.status }}</span>
              <span class="ml-2 font-mono">{{ t.id }}</span>
              <span class="ml-2">· {{ Array.isArray(t.fields) ? t.fields.length : 0 }} field{{ (Array.isArray(t.fields) ? t.fields.length : 0) === 1 ? '' : 's' }}</span>
              <span class="ml-2 text-muted-foreground/70">· {{ new Date(t.updated_at).toLocaleDateString() }}</span>
            </p>
          </div>
          <div class="flex shrink-0 gap-2">
            <NuxtLink
              :to="`/admin/document-templates/${t.id}`"
              class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
            >
              Open
            </NuxtLink>
            <button
              type="button"
              class="rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/15"
              @click="remove(t)"
            >
              Delete
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
