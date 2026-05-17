<script setup lang="ts">
// Reusable notes feed. Same shape as TasksPanel — pass contactId or
// listingId and the panel scopes its feed.
//
// Pinned notes float to the top (server returns them first by
// is_pinned DESC, created_at DESC). The pin toggle is the value-add
// here; everything else is a textarea + list.

import { onMounted, ref, watch } from 'vue'
import { useNotes, type CrmNote } from '~/composables/useNotes'
import { showToast } from '~/helpers/helpers'

const props = defineProps<{
  contactId?: number | null
  listingId?: number | null
  readonly?: boolean
}>()

const { listNotes, createNote, updateNote, deleteNote, togglePin } = useNotes()

const notes = ref<CrmNote[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const draftBody = ref('')
const isSaving = ref(false)

// Per-note edit buffers — keyed by note id. Stored as a flat object so
// vue's reactivity tracks individual entries cleanly.
const editingId = ref<string | null>(null)
const editBuffer = ref('')

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    const res = await listNotes({
      contactId: props.contactId ?? undefined,
      listingId: props.listingId ?? undefined,
      pageSize: 100,
    })
    notes.value = res.data
  } catch (err: any) {
    errorMessage.value = err?.statusMessage || err?.message || 'Failed to load notes'
  } finally {
    isLoading.value = false
  }
}

async function onCreate() {
  const body = draftBody.value.trim()
  if (!body) return
  isSaving.value = true
  try {
    const created = await createNote({
      body,
      contact_id: props.contactId ?? null,
      listing_id: props.listingId ?? null,
    })
    notes.value.unshift(created)
    draftBody.value = ''
    showToast({ title: 'Note added', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to add note', icon: 'error' })
  } finally {
    isSaving.value = false
  }
}

async function onTogglePin(n: CrmNote) {
  try {
    const updated = await togglePin(n.id, n.is_pinned)
    const idx = notes.value.findIndex(x => x.id === n.id)
    if (idx >= 0) notes.value[idx] = updated
    // Re-sort locally so the pin-toggle reflects in the list immediately.
    notes.value = [...notes.value].sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      return b.created_at.localeCompare(a.created_at)
    })
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to toggle pin', icon: 'error' })
  }
}

function startEdit(n: CrmNote) {
  editingId.value = n.id
  editBuffer.value = n.body
}

function cancelEdit() {
  editingId.value = null
  editBuffer.value = ''
}

async function onSaveEdit(n: CrmNote) {
  const body = editBuffer.value.trim()
  if (!body) return
  try {
    const updated = await updateNote(n.id, { body })
    const idx = notes.value.findIndex(x => x.id === n.id)
    if (idx >= 0) notes.value[idx] = updated
    cancelEdit()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to save note', icon: 'error' })
  }
}

async function onDelete(n: CrmNote) {
  if (!confirm('Delete this note?')) return
  try {
    await deleteNote(n.id)
    notes.value = notes.value.filter(x => x.id !== n.id)
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Failed to delete note', icon: 'error' })
  }
}

function relativeTime(iso: string) {
  const d = new Date(iso).getTime()
  const diff = Date.now() - d
  const m = Math.floor(diff / 60_000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

onMounted(load)
watch(
  () => [props.contactId, props.listingId] as const,
  () => load(),
)
</script>

<template>
  <section class="rounded-xl border border-border bg-background shadow-sm">
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-sm font-semibold text-foreground">
        Notes
        <span v-if="!isLoading" class="ml-1 text-xs font-normal text-muted-foreground">
          ({{ notes.length }})
        </span>
      </h2>
    </header>

    <div v-if="!readonly" class="border-b border-border px-4 py-3">
      <form @submit.prevent="onCreate">
        <textarea
          v-model="draftBody"
          rows="2"
          placeholder="Add a note…"
          class="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none"
          :disabled="isSaving"
        />
        <div class="mt-2 flex justify-end">
          <button
            type="submit"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            :disabled="!draftBody.trim() || isSaving"
          >
            Add note
          </button>
        </div>
      </form>
    </div>

    <ul v-if="isLoading" class="divide-y divide-border">
      <li v-for="n in 3" :key="n" class="px-4 py-3">
        <div class="h-3 w-2/3 animate-pulse rounded bg-muted" />
        <div class="mt-2 h-3 w-1/2 animate-pulse rounded bg-muted" />
      </li>
    </ul>

    <div v-else-if="errorMessage" class="px-4 py-6 text-center text-sm text-destructive">
      {{ errorMessage }}
    </div>

    <div
      v-else-if="notes.length === 0"
      class="px-4 py-8 text-center text-sm text-muted-foreground"
    >
      No notes yet.
    </div>

    <ul v-else class="divide-y divide-border">
      <li
        v-for="n in notes"
        :key="n.id"
        class="px-4 py-3"
        :class="n.is_pinned ? 'bg-yellow-50/50' : ''"
      >
        <div v-if="editingId === n.id">
          <textarea
            v-model="editBuffer"
            rows="3"
            class="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
          <div class="mt-2 flex justify-end gap-2 text-xs">
            <button class="text-muted-foreground hover:text-foreground" @click="cancelEdit">Cancel</button>
            <button
              class="rounded bg-primary px-2 py-1 font-medium text-white hover:bg-primary/90"
              @click="onSaveEdit(n)"
            >
              Save
            </button>
          </div>
        </div>

        <div v-else>
          <div class="flex items-start justify-between gap-3">
            <p class="whitespace-pre-wrap break-words text-sm text-foreground">
              {{ n.body }}
            </p>
            <div v-if="!readonly" class="flex shrink-0 gap-1 text-xs">
              <button
                class="rounded p-1 hover:bg-muted"
                :title="n.is_pinned ? 'Unpin' : 'Pin'"
                @click="onTogglePin(n)"
              >
                <span :class="n.is_pinned ? 'text-yellow-500' : 'text-muted-foreground/70'">📌</span>
              </button>
              <button
                class="rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
                title="Edit"
                @click="startEdit(n)"
              >
                ✎
              </button>
              <button
                class="rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-destructive"
                title="Delete"
                @click="onDelete(n)"
              >
                ✕
              </button>
            </div>
          </div>
          <p class="mt-1 text-xs text-muted-foreground/70">{{ relativeTime(n.created_at) }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>
