<script setup lang="ts">
/**
 * /ai-tools — domain hub for AI-powered features.
 *
 * Most AI surfaces are component-level (the AI Assist drawer on the
 * draft detail page, the Generate option on the New Document wizard).
 * This hub gives the AI capabilities a discoverable landing page +
 * shortcuts to the admin-side configuration when the caller has
 * permission.
 */
import { onMounted, ref } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import { useUserRole } from '~/composables/useAuth'

definePageMeta({ layout: 'default' })
useHead({ title: 'AI Tools | Housing Interactive' })

const role = useUserRole()
const isAdmin = computed(() => role.value === 'admin')

// Probe whether AI is configured. The endpoint reads
// platform_settings.ai_generation via service-role; we infer config
// state from a 503 ai_not_configured response. Probe is a HEAD-style
// lightweight prompt that always 422s back if AI works (because the
// prompt is too short) but 503s if not configured. Cheap enough.
const aiConfigured = ref<boolean | null>(null)
async function probeConfig() {
  try {
    await $fetch('/api/documents/ai-assist', {
      method: 'POST',
      body: { operation: 'explain', text: 'lorem ipsum dolor sit amet' },
    })
    aiConfigured.value = true
  } catch (err: any) {
    if (err?.statusCode === 503 && err?.data?.code === 'ai_not_configured') {
      aiConfigured.value = false
    } else {
      // Any other status (422 validation, 502 upstream) implies the
      // platform IS configured — the call reached the upstream.
      aiConfigured.value = true
    }
  }
}
onMounted(probeConfig)
</script>

<template>
  <AdminPageShell :permission="false" max-width="6xl">
    <UiPageHeader title="AI Tools">
      <template #description>
        AI capabilities across the platform: document generation,
        clause insertion, plain-English explanations, Tagalog
        translation. Powered by an admin-configured provider.
      </template>
    </UiPageHeader>

    <p
      v-if="aiConfigured === false"
      class="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground"
    >
      AI generation isn't configured yet.
      <NuxtLink
        v-if="isAdmin"
        to="/admin/ai-settings"
        class="ml-1 font-semibold text-primary hover:underline focus-ring rounded"
      >
        Configure now →
      </NuxtLink>
      <span v-else class="text-muted-foreground">Ask a platform admin to set it up.</span>
    </p>

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <article class="ui-card p-4">
        <p class="text-sm font-semibold text-foreground">Document generation</p>
        <p class="mt-1 text-xs text-muted-foreground">
          From any listing, deal, or contact, click "+ New document"
          and pick "Generate" to draft a full document from a prompt.
          The AI sees the listing + buyer context and produces an
          editable body.
        </p>
      </article>
      <article class="ui-card p-4">
        <p class="text-sm font-semibold text-foreground">AI Assist drawer</p>
        <p class="mt-1 text-xs text-muted-foreground">
          On any draft: explain a clause in plain English, summarize
          the whole doc, detect missing fields, or translate to
          Tagalog. Output is suggestion only — never overrides the
          deterministic validator.
        </p>
      </article>
      <article class="ui-card p-4">
        <p class="text-sm font-semibold text-foreground">Approved clauses</p>
        <p class="mt-1 text-xs text-muted-foreground">
          The "rewrite with clause" operation only splices from
          admin-approved snippets — the AI never invents legal text
          outside the curated library.
        </p>
        <!-- Admin-only CTA. /admin/clause-library is gated by the
             global admin middleware; we also hide the link here so
             Members don't see a path they can't follow. -->
        <NuxtLink
          v-if="isAdmin"
          to="/admin/clause-library"
          class="mt-2 inline-block text-xs font-semibold text-primary hover:underline focus-ring rounded"
        >
          Manage clause library →
        </NuxtLink>
      </article>
      <article v-if="isAdmin" class="ui-card p-4">
        <p class="text-sm font-semibold text-foreground">Provider settings</p>
        <p class="mt-1 text-xs text-muted-foreground">
          Set the AI endpoint, API key, model, and system prompt.
          Anthropic, OpenAI, and OpenAI-compatible proxies (LiteLLM,
          OpenRouter) are all supported.
        </p>
        <NuxtLink to="/admin/ai-settings" class="mt-2 inline-block text-xs font-semibold text-primary hover:underline focus-ring rounded">
          Open AI settings →
        </NuxtLink>
      </article>
      <article v-if="isAdmin" class="ui-card p-4">
        <p class="text-sm font-semibold text-foreground">AI suggestions inbox</p>
        <p class="mt-1 text-xs text-muted-foreground">
          Background AI proposals queued for review (pricing tweaks,
          listing copy improvements, lead-routing hints).
        </p>
        <NuxtLink to="/admin/ai-suggestions" class="mt-2 inline-block text-xs font-semibold text-primary hover:underline focus-ring rounded">
          Open inbox →
        </NuxtLink>
      </article>
      <article class="ui-card p-4">
        <p class="text-sm font-semibold text-foreground">Safety boundaries</p>
        <p class="mt-1 text-xs text-muted-foreground">
          AI never modifies documents directly — every output is
          shown as suggestion text the broker chooses to apply.
          Validation rules are deterministic and run independently
          of any AI signal.
        </p>
      </article>
    </div>
  </AdminPageShell>
</template>
