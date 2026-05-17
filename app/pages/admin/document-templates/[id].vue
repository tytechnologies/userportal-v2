<script setup lang="ts">
// Designer page — wraps TemplateDesigner with permission gating, load/
// error states, and a "back to list" link.

import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import {
  useTemplateDefinitions,
  clearTemplateCache,
  type TemplateDefinition,
} from '~/composables/useTemplateDefinitions'
import TemplateDesigner from '~/components/documents/TemplateDesigner.vue'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const { loadTemplate } = useTemplateDefinitions()

const id = computed(() => String(route.params.id ?? ''))
const template = ref<TemplateDefinition | null>(null)
const isChecking = ref(true)
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)

useHead(() => ({ title: template.value ? `${template.value.name} | Templates` : 'Template' }))

onMounted(async () => {
  const ok = await hasPermission('templates.manage')
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'You do not have access to template management.', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  await load()
})

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    template.value = await loadTemplate(id.value)
  } catch (err: any) {
    if (err?.statusCode === 404) errorMessage.value = 'Template not found.'
    else errorMessage.value = err?.statusMessage || err?.message || 'Failed to load template.'
  } finally {
    isLoading.value = false
  }
}

function onSaved(updated: TemplateDefinition) {
  template.value = updated
  // Invalidate the hybrid registry cache so /document-drafts/new picks
  // up the changes on its next refresh().
  clearTemplateCache()
}
</script>

<template>
  <div class="px-4 py-6 sm:px-6 lg:px-8">
    <div class="mb-4">
      <NuxtLink to="/admin/document-templates" class="text-xs font-semibold text-muted-foreground hover:text-primary">
        ← All templates
      </NuxtLink>
    </div>

    <div
      v-if="isChecking || isLoading"
      class="rounded-xl border border-border bg-background p-5 text-center text-sm text-muted-foreground"
    >
      Loading…
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-center text-sm text-destructive"
    >
      {{ errorMessage }}
    </div>

    <TemplateDesigner
      v-else-if="template"
      :template="template"
      @saved="onSaved"
    />
  </div>
</template>
