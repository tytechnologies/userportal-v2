<script setup lang="ts">
// Public read-only viewer for a shared draft.
//
// No auth required — possession of the token IS the access credential.
// The token-bound endpoint validates revocation + expiration and
// returns sanitized draft contents (no owner_user_id, no contact_id).
//
// Modes:
//   - Form draft: render the template at natural size, overlay the
//     filled values as text (NOT inputs — read-only).
//   - Imported file: render via DocumentImportViewer with the
//     pre-signed storage URL the server returned.

import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  documentTemplates,
  findTemplate,
  humanizeFieldKey,
  type DocumentTemplate,
  type DocumentTemplateField,
} from '~/utils/documentTemplates'

definePageMeta({ layout: 'auth' })

type SharedDraft = {
  id: string
  template_id: string | null
  title: string | null
  data: Record<string, any>
  status: 'draft' | 'in_review' | 'signed' | 'archived'
  storage_mime: string | null
  storage_size_bytes: number | null
  storage_url: string | null
  updated_at: string
  expires_at: string
}

const route = useRoute()
const token = computed(() => String(route.params.token ?? ''))

const draft = ref<SharedDraft | null>(null)
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const errorCode = ref<number | null>(null)

useHead(() => ({
  title: draft.value?.title ? `${draft.value.title} | Shared` : 'Shared draft',
  // Don't index public share URLs — they're transient by design.
  meta: [{ name: 'robots', content: 'noindex,nofollow' }],
}))

async function load() {
  isLoading.value = true
  errorMessage.value = null
  errorCode.value = null
  try {
    draft.value = await $fetch<SharedDraft>(`/api/shared-drafts/${token.value}`)
  } catch (err: any) {
    errorCode.value = err?.statusCode ?? 500
    errorMessage.value = err?.statusMessage || err?.message || 'Could not load shared draft.'
  } finally {
    isLoading.value = false
  }
}
onMounted(load)

const template = computed<DocumentTemplate | null>(() => {
  if (!draft.value?.template_id) return null
  return findTemplate(draft.value.template_id)
})

function fieldStyle(f: DocumentTemplateField) {
  const w = f.width ?? 200
  const h = f.height ?? (f.type === 'textarea' ? 80 : 28)
  return {
    position: 'absolute' as const,
    top: `${f.y}px`,
    left: `${f.x}px`,
    width: `${w}px`,
    height: `${h}px`,
  }
}

function fieldValue(f: DocumentTemplateField): string {
  const v = (draft.value?.data as any)?.[f.key]
  return v === null || v === undefined ? '' : String(v)
}

function signatureUrl(f: DocumentTemplateField): string | null {
  const sigs: any = (draft.value?.data as any)?._signatures
  return sigs?.[f.key]?.url ?? null
}

function onPrint() {
  if (typeof window !== 'undefined') window.print()
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}
</script>

<template>
  <div class="min-h-screen bg-muted/50 px-4 py-6 sm:px-6 lg:px-8">
    <header class="mx-auto mb-4 flex max-w-5xl items-center justify-between">
      <div>
        <h1 class="text-base font-semibold text-foreground">
          {{ draft?.title || 'Shared document' }}
        </h1>
        <p class="text-xs text-muted-foreground">
          Read-only · expires {{ formatDate(draft?.expires_at) }}
        </p>
      </div>
      <button
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        @click="onPrint"
      >
        Print
      </button>
    </header>

    <div
      v-if="isLoading"
      class="mx-auto max-w-5xl rounded-xl border border-border bg-background p-5 text-center text-sm text-muted-foreground"
    >
      Loading…
    </div>

    <div
      v-else-if="errorMessage"
      class="mx-auto max-w-md rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-center text-sm text-destructive"
    >
      <p class="font-semibold">{{ errorMessage }}</p>
      <p v-if="errorCode === 410" class="mt-2 text-xs">
        This link is no longer valid. Ask the sender for a new one.
      </p>
      <p v-else-if="errorCode === 404" class="mt-2 text-xs">
        Check the URL and try again.
      </p>
    </div>

    <!-- Form draft branch — render filled values overlaying the
         template background, no editable inputs. -->
    <div
      v-else-if="draft && template"
      class="mx-auto max-w-5xl overflow-x-auto rounded-xl border border-border bg-background shadow-sm"
    >
      <div
        class="relative mx-auto bg-card"
        :style="{ width: `${template.width}px`, height: `${template.height}px` }"
      >
        <img
          :src="template.background"
          :alt="template.name"
          class="absolute inset-0 h-full w-full select-none"
          draggable="false"
        />

        <template v-for="f in template.fields" :key="f.key">
          <!-- Signature: render the saved PNG. -->
          <div
            v-if="f.type === 'signature' && signatureUrl(f)"
            :style="fieldStyle(f)"
            class="overflow-hidden rounded-md"
          >
            <img
              :src="signatureUrl(f)!"
              :alt="`${f.label || humanizeFieldKey(f.key)} signature`"
              class="h-full w-full object-contain"
            />
          </div>
          <!-- Textarea: render in a multi-line div. -->
          <div
            v-else-if="f.type === 'textarea'"
            :style="fieldStyle(f)"
            class="overflow-hidden whitespace-pre-wrap rounded-md px-2 py-1 text-sm text-foreground"
          >
            {{ fieldValue(f) }}
          </div>
          <!-- Other types: single-line text. -->
          <div
            v-else
            :style="fieldStyle(f)"
            class="flex items-center overflow-hidden rounded-md px-2 text-sm text-foreground"
          >
            {{ fieldValue(f) }}
          </div>
        </template>
      </div>
    </div>

    <!-- Form draft with template id we can't resolve (was deleted /
         renamed since the link was minted). -->
    <div
      v-else-if="draft && draft.template_id"
      class="mx-auto max-w-md rounded-xl border border-warning/30 bg-warning/10 p-6 text-center text-sm text-warning"
    >
      The template for this draft is no longer available. Field values
      are still saved — ask the sender to refresh the link if you need
      to view them.
    </div>

    <!-- Imported-file branch — display a download tile. We deliberately
         don't pull pdfjs in here to keep the public bundle small;
         users can download and view in their native viewer. -->
    <div
      v-else-if="draft && draft.storage_url"
      class="mx-auto max-w-xl rounded-xl border border-border bg-background p-6 shadow-sm"
    >
      <p class="mb-2 text-sm font-semibold text-foreground">
        {{ draft.title || 'Imported document' }}
      </p>
      <p class="mb-4 text-xs text-muted-foreground">
        {{ draft.storage_mime || 'application/octet-stream' }}
        ·
        {{ draft.storage_size_bytes ? `${Math.round(draft.storage_size_bytes / 1024)} KB` : '—' }}
      </p>
      <a
        :href="draft.storage_url"
        target="_blank"
        rel="noopener"
        class="inline-block rounded-md bg-primary px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
      >
        Open / download
      </a>
    </div>

    <div
      v-else
      class="mx-auto max-w-md rounded-xl border border-dashed border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Empty draft.
    </div>
  </div>
</template>
