<script setup lang="ts">
/**
 * /admin/ai-settings — platform AI config.
 *
 * Single page where a platform admin sets the endpoint, API key,
 * model, and system prompt that powers the "Generate" option on
 * the New Document wizard. One config for the whole platform —
 * every broker uses the same upstream provider.
 *
 * The api_key is write-only on the wire. The GET endpoint masks it
 * (returns api_key_set: bool). Pasting a new value overwrites;
 * leaving the field empty preserves whatever's currently stored.
 * Submitting an explicit "Clear key" action sends an empty string
 * which the PATCH treats as a clear.
 */
import { onMounted, ref } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'AI Settings | Housing Interactive' })

type Cfg = {
  provider: string
  endpoint: string
  model: string
  header_style: 'bearer' | 'anthropic'
  system_prompt: string
  api_key_set: boolean
  updated_at?: string | null
}

const loading = ref(true)
const saving = ref(false)
const cfg = ref<Cfg>({
  provider: '',
  endpoint: '',
  model: '',
  header_style: 'bearer',
  system_prompt: '',
  api_key_set: false,
})
// Separate field so the masked api_key_set state isn't overwritten by
// what the user types — typing only matters on submit.
const newApiKey = ref<string>('')

async function load() {
  loading.value = true
  try {
    cfg.value = await $fetch<Cfg>('/api/admin/platform-settings/ai-generation')
    newApiKey.value = ''
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load AI settings',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function save() {
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      provider:      cfg.value.provider.trim(),
      endpoint:      cfg.value.endpoint.trim(),
      model:         cfg.value.model.trim(),
      header_style:  cfg.value.header_style,
      system_prompt: cfg.value.system_prompt,
    }
    // Only send api_key when the admin typed something. Empty input
    // means "leave existing key alone." If they want to clear the
    // key, the explicit Clear button below sends api_key: ''.
    if (newApiKey.value !== '') body.api_key = newApiKey.value

    cfg.value = await $fetch<Cfg>('/api/admin/platform-settings/ai-generation', {
      method: 'PATCH',
      body,
    })
    newApiKey.value = ''
    showToast({ title: 'AI settings saved', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Save failed',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}

async function clearKey() {
  // Sends an explicit empty string — the PATCH treats that as a clear,
  // distinct from "field omitted" (which preserves the existing key).
  if (!confirm('Clear the API key? Brokers will see a "configure AI" CTA until you set a new one.')) return
  saving.value = true
  try {
    cfg.value = await $fetch<Cfg>('/api/admin/platform-settings/ai-generation', {
      method: 'PATCH',
      body: { api_key: '' },
    })
    showToast({ title: 'API key cleared', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Clear failed',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="3xl">
    <UiPageHeader title="AI generation settings">
      <template #description>
        Platform-wide config powering the "Generate" option on the New
        Document wizard. Every broker on the platform uses this same
        endpoint and key — there's no per-user override. Anthropic,
        OpenAI, and OpenAI-compatible proxies (LiteLLM, OpenRouter) are
        all supported.
      </template>
    </UiPageHeader>

    <div v-if="loading" class="space-y-3">
      <div v-for="n in 4" :key="n" class="h-10 animate-pulse rounded-md bg-muted-foreground/10" />
    </div>

    <form
      v-else
      class="space-y-4"
      @submit.prevent="save"
    >
      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">
          Provider label
        </span>
        <input
          v-model="cfg.provider"
          type="text"
          maxlength="80"
          placeholder="e.g. Anthropic"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
        <span class="mt-1 block text-[11px] text-muted-foreground">
          Free-text label so you can spot which provider is configured. Not sent to the upstream.
        </span>
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">
          Endpoint URL <span class="text-destructive">*</span>
        </span>
        <input
          v-model="cfg.endpoint"
          type="url"
          required
          maxlength="2000"
          placeholder="https://api.anthropic.com/v1/messages"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">
          API key
          <span v-if="cfg.api_key_set" class="ml-1 text-success">· configured</span>
          <span v-else class="ml-1 text-warning">· not set</span>
        </span>
        <input
          v-model="newApiKey"
          type="password"
          autocomplete="off"
          maxlength="8000"
          :placeholder="cfg.api_key_set ? 'Leave empty to keep existing key' : 'Paste API key…'"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
        <span class="mt-1 block text-[11px] text-muted-foreground">
          Stored encrypted at rest via the standard Postgres role boundary.
          Never returned through the API once saved.
        </span>
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">
          Header style
        </span>
        <select
          v-model="cfg.header_style"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        >
          <option value="bearer">Authorization: Bearer (OpenAI / OpenRouter / generic)</option>
          <option value="anthropic">x-api-key + anthropic-version (direct to Anthropic)</option>
        </select>
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">
          Model
        </span>
        <input
          v-model="cfg.model"
          type="text"
          maxlength="120"
          placeholder="claude-sonnet-4-6"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">
          System prompt
        </span>
        <textarea
          v-model="cfg.system_prompt"
          rows="4"
          maxlength="8000"
          placeholder="Optional. Defaults to a paralegal-assistant prompt scoped to PH real estate."
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
      </label>

      <div class="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <button
          type="submit"
          class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="saving"
        >
          {{ saving ? 'Saving…' : 'Save settings' }}
        </button>
        <button
          v-if="cfg.api_key_set"
          type="button"
          class="rounded-md border border-destructive/30 bg-card px-3.5 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 focus-ring disabled:opacity-60"
          :disabled="saving"
          @click="clearKey"
        >
          Clear API key
        </button>
        <span
          v-if="cfg.updated_at"
          class="ml-auto text-[11px] text-muted-foreground"
        >
          Last updated {{ new Date(cfg.updated_at).toLocaleString() }}
        </span>
      </div>
    </form>
  </AdminPageShell>
</template>
