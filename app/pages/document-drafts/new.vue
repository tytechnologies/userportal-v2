<script setup lang="ts">
// Template picker. Pulls from useTemplates() which merges the static
// registry with PUBLISHED DB templates — admins can ship new templates
// via /admin/document-templates without a code change and they show
// up here automatically.
//
// Quick-create from CRM context: when ?contact_id or ?listing_id is
// in the URL, the new draft is pre-linked. Lets users go from
// /contacts/123 → "+ New document" → pick template → land in editor
// without manually re-linking. Either or both ids supported.

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTemplates } from '~/composables/useTemplateDefinitions'
import { useDocumentDrafts } from '~/composables/useDocumentDrafts'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'New Draft | Housinginteractive' })

const route = useRoute()
const router = useRouter()
const { createDraft } = useDocumentDrafts()
const { templates, isLoading, refresh } = useTemplates()

// Accept either via query: /document-drafts/new?contact_id=42
//                       or /document-drafts/new?listing_id=42
const presetContactId = computed(() => {
  const v = route.query.contact_id
  if (typeof v !== 'string') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
})
const presetListingId = computed(() => {
  const v = route.query.listing_id
  if (typeof v !== 'string') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
})

async function startFromTemplate(templateId: string) {
  try {
    const draft = await createDraft({
      template_id: templateId,
      contact_id: presetContactId.value,
      listing_id: presetListingId.value,
    })
    router.replace(`/document-drafts/${draft.id}`)
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not create draft.', icon: 'error' })
  }
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <header>
      <NuxtLink
        to="/document-drafts"
        class="inline-flex items-center gap-1 text-meta hover:text-foreground focus-ring rounded"
      >
        <span aria-hidden="true">←</span>
        All drafts
      </NuxtLink>
      <h1 class="mt-2 text-page-title">Pick a template</h1>
      <p class="text-sm text-muted-foreground">
        Choosing a template creates a new editable draft you can fill in
        and link to a contact.
      </p>
      <p
        v-if="presetContactId || presetListingId"
        class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs text-primary"
      >
        <span aria-hidden="true">🔗</span>
        Pre-linked to
        <span v-if="presetContactId">contact #{{ presetContactId }}</span>
        <span v-if="presetContactId && presetListingId"> · </span>
        <span v-if="presetListingId">listing #{{ presetListingId }}</span>
      </p>
    </header>

    <ul v-if="isLoading && templates.length === 0" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <li v-for="n in 3" :key="n" class="ui-card p-4">
        <UiSkeleton class="h-4 w-1/3" />
        <UiSkeleton class="mt-2 h-3 w-1/2" />
      </li>
    </ul>

    <ul v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <li
        v-for="t in templates"
        :key="t.id"
        class="ui-card-interactive p-4"
      >
        <h2 class="mb-1 text-card-title">{{ t.name }}</h2>
        <p v-if="t.description" class="mb-3 text-meta">
          {{ t.description }}
        </p>
        <p class="mb-3 text-caption">
          {{ t.fields.length }}
          {{ t.fields.length === 1 ? 'field' : 'fields' }}
        </p>
        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
          @click="startFromTemplate(t.id)"
        >
          Start
        </button>
      </li>
      <li
        v-if="templates.length === 0"
        class="rounded-xl border border-dashed border-border bg-card p-5 text-center text-sm text-muted-foreground sm:col-span-2 lg:col-span-3"
      >
        No templates available. An admin can publish one in
        <NuxtLink to="/admin/document-templates" class="underline">/admin/document-templates</NuxtLink>.
      </li>
    </ul>
  </AdminPageShell>
</template>
