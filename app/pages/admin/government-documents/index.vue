<script setup lang="ts">
// Admin CRUD for the government documents reference library.
//
// Admin-only by route name + RLS. The middleware/auth global handles
// the unauthenticated case; the page itself shows a 403 if the role
// gate fails so we don't leak the admin surface.
//
// CRUD shape:
//   - List with status filter (default: all). Admins see drafts +
//     archived too; the broker browse page only sees published.
//   - Inline create panel: title + category + step + description +
//     optional file (PDF or image data URL).
//   - Per-row: status pill, edit button (opens inline edit form),
//     delete button.
//
// File upload uses base64 in the JSON body (parity with every other
// upload endpoint in this project — see document-template-definitions
// upload-background.post.ts). Capped server-side at 50 MB.

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  useGovernmentDocuments,
  type GovernmentDocument,
  type GovDocCategory,
  type GovDocStatus,
  GOV_DOC_CATEGORY_LABELS,
} from '~/composables/useGovernmentDocuments'
import { useUserRole } from '~/composables/useAuth'
import { useConfirm } from '~/composables/useConfirm'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Document Checklist admin | Housinginteractive' })

const role = useUserRole()
const router = useRouter()
const {
  listGovDocs,
  createGovDoc,
  updateGovDoc,
  deleteGovDoc,
  replaceGovDocFile,
} = useGovernmentDocuments()
const { confirm } = useConfirm()

// Block non-admins on the client too (RLS already gates the writes,
// but a 403-shaped page is friendlier than a silent fail).
const isAdmin = computed(() => role.value === 'admin')

const items = ref<GovernmentDocument[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const statusFilter = ref<'all' | GovDocStatus>('all')

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const opts = statusFilter.value === 'all' ? {} : { status: statusFilter.value }
    const res = await listGovDocs(opts)
    items.value = res.data
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load documents'
  } finally {
    isLoading.value = false
  }
}

// ---- Create form ----
type DraftRow = {
  title: string
  description: string
  category: GovDocCategory
  step_number: number | null
  display_order: number
  status: GovDocStatus
  file_name: string | null
  file_data_url: string | null
}

const blankDraft = (): DraftRow => ({
  title: '',
  description: '',
  category: 'other',
  step_number: null,
  display_order: 0,
  status: 'draft',
  file_name: null,
  file_data_url: null,
})

const newDraft = ref<DraftRow>(blankDraft())
const isSavingNew = ref(false)
const newFileError = ref<string | null>(null)

async function onPickFile(ev: Event, target: DraftRow) {
  newFileError.value = null
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > 50 * 1024 * 1024) {
    newFileError.value = 'File exceeds 50 MB cap.'
    input.value = ''
    return
  }
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
  if (!allowed.includes(file.type)) {
    newFileError.value = `Unsupported file type: ${file.type}.`
    input.value = ''
    return
  }
  // Read the file as a data URL so we can POST it as-is.
  const reader = new FileReader()
  reader.onload = () => {
    target.file_data_url = String(reader.result || '') || null
    target.file_name = file.name
  }
  reader.onerror = () => {
    newFileError.value = 'Failed to read file.'
    input.value = ''
  }
  reader.readAsDataURL(file)
}

async function saveNew() {
  if (isSavingNew.value) return
  if (!newDraft.value.title.trim()) {
    showToast({ title: 'Title is required.', icon: 'error' })
    return
  }
  isSavingNew.value = true
  try {
    await createGovDoc({
      title: newDraft.value.title.trim(),
      description: newDraft.value.description.trim() || null,
      category: newDraft.value.category,
      step_number: newDraft.value.step_number,
      display_order: newDraft.value.display_order,
      status: newDraft.value.status,
      file_data_url: newDraft.value.file_data_url,
      file_name: newDraft.value.file_name,
    })
    showToast({ title: 'Document created.', icon: 'success' })
    newDraft.value = blankDraft()
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to create',
      icon: 'error',
    })
  } finally {
    isSavingNew.value = false
  }
}

// ---- Inline edit ----
const editingId = ref<string | null>(null)
const editDraft = ref<Partial<GovernmentDocument>>({})
const isSavingEdit = ref(false)

function startEdit(row: GovernmentDocument) {
  editingId.value = row.id
  editDraft.value = {
    title: row.title,
    description: row.description,
    category: row.category,
    step_number: row.step_number,
    display_order: row.display_order,
    status: row.status,
  }
}

function cancelEdit() {
  editingId.value = null
  editDraft.value = {}
}

async function saveEdit(id: string) {
  if (isSavingEdit.value) return
  isSavingEdit.value = true
  try {
    await updateGovDoc(id, editDraft.value as any)
    showToast({ title: 'Saved.', icon: 'success' })
    editingId.value = null
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to save',
      icon: 'error',
    })
  } finally {
    isSavingEdit.value = false
  }
}

// File replacement on an existing row. Opt-in per-row hidden file
// input (clicked via the "Replace file" button) so the edit form
// doesn't bloat for the metadata-only common case.
const replacingId = ref<string | null>(null)

async function onReplaceFile(ev: Event, row: GovernmentDocument) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > 50 * 1024 * 1024) {
    showToast({ title: 'File exceeds 50 MB cap.', icon: 'error' })
    input.value = ''
    return
  }
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
  if (!allowed.includes(file.type)) {
    showToast({ title: `Unsupported file type: ${file.type}.`, icon: 'error' })
    input.value = ''
    return
  }
  replacingId.value = row.id
  try {
    const data_url: string = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    })
    await replaceGovDocFile(row.id, {
      file_data_url: data_url,
      file_name: file.name,
    })
    showToast({ title: 'File replaced.', icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to replace file',
      icon: 'error',
    })
  } finally {
    replacingId.value = null
    input.value = ''
  }
}

async function onDelete(row: GovernmentDocument) {
  const ok = await confirm({
    title: 'Delete this document?',
    description: `"${row.title}" will be removed permanently, including the file in S3.`,
    confirmText: 'Delete',
    variant: 'destructive',
  })
  if (!ok) return
  try {
    await deleteGovDoc(row.id)
    showToast({ title: 'Deleted.', icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to delete',
      icon: 'error',
    })
  }
}

const STATUS_CHIP: Record<GovDocStatus, string> = {
  draft:     'bg-muted text-foreground',
  published: 'bg-success/15 text-success',
  archived:  'bg-slate-100 text-slate-600',
}

// Re-use the same display order as the public page for consistency.
const CATEGORY_OPTIONS: GovDocCategory[] = [
  'capital_gains',
  'transfer_tax',
  'registration',
  'tax_declaration',
  'other',
]

onMounted(load)
</script>

<template>
  <div class="mx-auto max-w-5xl p-4">
    <header class="mb-4">
      <NuxtLink to="/admin" class="text-xs font-semibold text-muted-foreground hover:text-primary">
        ← Admin
      </NuxtLink>
      <h1 class="mt-2 text-xl font-bold text-foreground">Government documents</h1>
      <p class="text-sm text-muted-foreground">
        Manage the broker-facing reference library at
        <NuxtLink to="/documents/government-references" class="text-primary underline">
          /documents/government-references
        </NuxtLink>.
      </p>
    </header>

    <div
      v-if="!isAdmin"
      class="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning"
    >
      You don't have admin access to this page. RLS still gates the writes server-side.
    </div>

    <template v-else>
      <!-- Create panel -->
      <section class="mb-4 rounded-xl border border-border bg-background p-4 shadow-sm">
        <h2 class="mb-3 text-sm font-semibold text-foreground">Add a document</h2>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Title
            <input
              v-model="newDraft.title"
              type="text"
              maxlength="300"
              placeholder="e.g. BIR Form 1606 — Capital Gains Tax"
              class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
            />
          </label>

          <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Category
            <select
              v-model="newDraft.category"
              class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
            >
              <option v-for="c in CATEGORY_OPTIONS" :key="c" :value="c">
                {{ GOV_DOC_CATEGORY_LABELS[c] }}
              </option>
            </select>
          </label>

          <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Step number (optional)
            <input
              v-model.number="newDraft.step_number"
              type="number"
              min="1"
              max="99"
              placeholder="1"
              class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
            />
          </label>

          <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Display order
            <input
              v-model.number="newDraft.display_order"
              type="number"
              min="0"
              max="9999"
              class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
            />
          </label>

          <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground sm:col-span-2">
            Description (optional)
            <textarea
              v-model="newDraft.description"
              rows="2"
              maxlength="20000"
              placeholder="What this document is, when to use it, who issues it…"
              class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
            />
          </label>

          <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            File (PDF / PNG / JPG / WEBP, ≤ 50 MB)
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              class="text-xs"
              @change="onPickFile($event, newDraft)"
            />
            <span v-if="newDraft.file_name" class="text-[11px] text-muted-foreground/70">
              {{ newDraft.file_name }} loaded.
            </span>
            <span v-if="newFileError" class="text-[11px] text-destructive">
              {{ newFileError }}
            </span>
          </label>

          <label class="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Status on save
            <select
              v-model="newDraft.status"
              class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
            >
              <option value="draft">Draft (admin only)</option>
              <option value="published">Published (visible to brokers)</option>
            </select>
          </label>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            @click="newDraft = blankDraft(); newFileError = null"
          >
            Reset
          </button>
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
            :disabled="isSavingNew || !newDraft.title.trim()"
            @click="saveNew"
          >
            {{ isSavingNew ? 'Saving…' : 'Add document' }}
          </button>
        </div>
      </section>

      <!-- Filter row -->
      <div class="mb-3 flex items-center gap-2 text-xs">
        <span class="text-muted-foreground">Status:</span>
        <button
          v-for="opt in [
            { v: 'all', label: 'All' },
            { v: 'draft', label: 'Drafts' },
            { v: 'published', label: 'Published' },
            { v: 'archived', label: 'Archived' },
          ]"
          :key="opt.v"
          type="button"
          class="rounded-md px-3 py-1 transition-colors"
          :class="statusFilter === opt.v ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
          @click="statusFilter = opt.v as any; load()"
        >
          {{ opt.label }}
        </button>
        <span class="ml-auto text-muted-foreground/70">{{ items.length }} total</span>
      </div>

      <!-- List -->
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
        v-else-if="items.length === 0"
        class="rounded-xl border border-border bg-background p-6 text-center text-sm text-muted-foreground/70"
      >
        No documents at this status.
      </div>

      <ul v-else class="divide-y divide-border rounded-xl border border-border bg-card shadow-sm">
        <li v-for="row in items" :key="row.id" class="px-4 py-3">
          <!-- Read view -->
          <div v-if="editingId !== row.id" class="flex items-start gap-3">
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
              :class="STATUS_CHIP[row.status]"
            >
              {{ row.status }}
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-foreground">{{ row.title }}</p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                {{ GOV_DOC_CATEGORY_LABELS[row.category] }}
                <span v-if="row.step_number !== null"> · Step {{ row.step_number }}</span>
                <span v-if="row.file_name"> · {{ row.file_name }}</span>
                <span v-else-if="row.external_url"> · external link</span>
                <span v-else class="text-warning"> · No file</span>
              </p>
              <p
                v-if="row.description"
                class="mt-1 line-clamp-2 text-xs text-muted-foreground"
              >
                {{ row.description }}
              </p>
            </div>
            <div class="flex shrink-0 gap-1">
              <a
                v-if="row.display_url"
                :href="row.display_url"
                target="_blank"
                rel="noopener noreferrer"
                class="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Open
              </a>
              <!-- Hidden file input + label-styled button. Clicking the
                   button opens the OS file picker; on selection,
                   onReplaceFile uploads + swaps the row's S3 object. -->
              <label
                class="cursor-pointer rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                :class="{ 'opacity-50': replacingId === row.id }"
              >
                {{ replacingId === row.id
                  ? 'Uploading…'
                  : (row.s3_key ? 'Replace file' : 'Add file') }}
                <input
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  class="hidden"
                  :disabled="replacingId === row.id"
                  @change="onReplaceFile($event, row)"
                />
              </label>
              <button
                type="button"
                class="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                @click="startEdit(row)"
              >
                Edit
              </button>
              <button
                type="button"
                class="rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                @click="onDelete(row)"
              >
                Delete
              </button>
            </div>
          </div>

          <!-- Edit view -->
          <div v-else class="grid gap-2">
            <div class="grid gap-2 sm:grid-cols-2">
              <input
                v-model="editDraft.title"
                type="text"
                placeholder="Title"
                class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
              />
              <select
                v-model="editDraft.category"
                class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
              >
                <option v-for="c in CATEGORY_OPTIONS" :key="c" :value="c">
                  {{ GOV_DOC_CATEGORY_LABELS[c] }}
                </option>
              </select>
              <input
                v-model.number="editDraft.step_number"
                type="number"
                placeholder="Step"
                min="1"
                max="99"
                class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
              />
              <input
                v-model.number="editDraft.display_order"
                type="number"
                placeholder="Display order"
                min="0"
                max="9999"
                class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
              />
              <textarea
                v-model="editDraft.description"
                rows="2"
                placeholder="Description"
                class="sm:col-span-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
              />
              <select
                v-model="editDraft.status"
                class="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                @click="cancelEdit"
              >
                Cancel
              </button>
              <button
                type="button"
                class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
                :disabled="isSavingEdit"
                @click="saveEdit(row.id)"
              >
                {{ isSavingEdit ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
