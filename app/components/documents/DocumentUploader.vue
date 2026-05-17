<script setup lang="ts">
// File-import companion to DocumentEditor. Reads a local file, base64-
// encodes it in 64KB chunks (avoids the per-byte String.fromCharCode
// overflow on multi-MB files), and POSTs to /api/document-drafts/import.
// Server uploads to S3 and inserts a document_drafts row.
//
// Cross-entity link: parents pass a contactId so the imported file
// surfaces on that contact's draft list.

import { ref } from 'vue'
import { showToast } from '~/helpers/helpers'
import type { DocumentDraft } from '~/composables/useDocumentDrafts'
import { useContacts, type Contact } from '~/composables/useContacts'
import ContactPicker from '~/components/contacts/ContactPicker.vue'

const props = defineProps<{
  /** Optional pre-selected contact to attach the upload to. */
  contactId?: number | null
}>()

const emit = defineEmits<{
  (e: 'imported', draft: DocumentDraft): void
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const isUploading = ref(false)
const progress = ref(0)
const selectedContact = ref<Contact | null>(null)
const localContactId = ref<number | null>(props.contactId ?? null)

const { getContactById } = useContacts()

// Hydrate the picker's "selected" view if a contactId was passed in.
// Failure here only means the chip won't pre-fill — the picker still
// works for the user. Log so flaky network shows up in dev tools.
if (localContactId.value) {
  getContactById(localContactId.value)
    .then((c) => (selectedContact.value = c))
    .catch((err) => console.warn('[DocumentUploader] contact prefill failed', err))
}

function onContactSelect(contact: Contact) {
  selectedContact.value = contact
  localContactId.value = contact.id
}
function onContactClear() {
  selectedContact.value = null
  localContactId.value = null
}

// 64 KB chunks — keeps `String.fromCharCode.apply` within engine arg
// limits and avoids per-byte string concat. For a 10 MB PDF this is
// ~155 chunks, runs in well under a second.
async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x10000 // 64 KB
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize) as unknown as number[],
    )
  }
  return btoa(binary)
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await upload(file)
  // Allow re-uploading the same filename (browsers won't refire change
  // for an identical file otherwise).
  input.value = ''
}

async function upload(file: File) {
  if (file.size === 0) {
    showToast({ title: 'File is empty.', icon: 'warning' })
    return
  }
  // Hard cap at 90 MB raw — matches the server-side schema cap.
  if (file.size > 90 * 1024 * 1024) {
    showToast({ title: 'File is too large (max 90 MB).', icon: 'error' })
    return
  }

  isUploading.value = true
  progress.value = 5
  try {
    const file_base64 = await fileToBase64(file)
    progress.value = 60
    const draft = await $fetch<DocumentDraft>('/api/document-drafts/import', {
      method: 'POST',
      body: {
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_base64,
        contact_id: localContactId.value ?? null,
      },
    })
    progress.value = 100
    emit('imported', draft)
    showToast({ title: 'Document imported.', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Upload failed.',
      icon: 'error',
    })
  } finally {
    isUploading.value = false
    progress.value = 0
  }
}

function pick() {
  fileInput.value?.click()
}
</script>

<template>
  <div class="rounded-xl border border-dashed border-border bg-card p-6">
    <h3 class="mb-1 text-sm font-semibold text-foreground">Import a document</h3>
    <p class="mb-4 text-xs text-muted-foreground">
      PDF, image, or DOCX. Up to 90 MB. Stored privately and viewable by
      the people who can see this contact.
    </p>

    <!-- Optional contact picker. Hidden when a contactId was passed in
         from the parent (e.g. importing from a contact's detail page). -->
    <div v-if="!props.contactId" class="mb-4">
      <ContactPicker
        label="Link to contact (optional)"
        placeholder="Search contacts…"
        :selected="selectedContact"
        @select="onContactSelect"
        @clear="onContactClear"
      />
    </div>

    <input
      ref="fileInput"
      type="file"
      accept="application/pdf,image/*,.docx,.doc"
      class="hidden"
      @change="onFileChange"
    />

    <div class="flex items-center gap-3">
      <button
        type="button"
        class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="isUploading"
        @click="pick"
      >
        <span v-if="isUploading">Uploading… {{ progress }}%</span>
        <span v-else>Choose file</span>
      </button>
      <span v-if="isUploading" class="text-xs text-muted-foreground">
        Hold tight — large files take a few seconds.
      </span>
    </div>
  </div>
</template>
