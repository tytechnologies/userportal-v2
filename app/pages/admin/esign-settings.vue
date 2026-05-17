<script setup lang="ts">
/**
 * /admin/esign-settings — DocuSign integration config.
 *
 * Mirrors /admin/ai-settings: read-merge-write, secrets are write-only,
 * `_set` flags surface presence without echoing the value.
 *
 * First-time setup also requires a one-off DocuSign "consent" step
 * (a URL the integration owner visits to grant the JWT-grant scopes).
 * The page surfaces the consent URL after a save attempt fails with
 * `consent_required`.
 */
import { onMounted, ref } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'eSign Settings | Housing Interactive' })

type Cfg = {
  account_id: string
  integration_key: string
  user_id: string
  base_uri: string
  redirect_uri: string
  private_key_set: boolean
  webhook_secret_set: boolean
  updated_at?: string | null
}

const loading = ref(true)
const saving = ref(false)
const cfg = ref<Cfg>({
  account_id: '',
  integration_key: '',
  user_id: '',
  base_uri: 'demo.docusign.net',
  redirect_uri: '',
  private_key_set: false,
  webhook_secret_set: false,
})
const newPrivateKey = ref('')
const newWebhookSecret = ref('')
const consentUrl = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    cfg.value = await $fetch<Cfg>('/api/admin/platform-settings/docusign')
    newPrivateKey.value = ''
    newWebhookSecret.value = ''
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load DocuSign settings',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function save() {
  saving.value = true
  consentUrl.value = null
  try {
    const body: Record<string, unknown> = {
      account_id:      cfg.value.account_id.trim(),
      integration_key: cfg.value.integration_key.trim(),
      user_id:         cfg.value.user_id.trim(),
      base_uri:        cfg.value.base_uri.trim(),
      redirect_uri:    cfg.value.redirect_uri.trim(),
    }
    if (newPrivateKey.value !== '')   body.private_key = newPrivateKey.value
    if (newWebhookSecret.value !== '') body.webhook_secret = newWebhookSecret.value

    cfg.value = await $fetch<Cfg>('/api/admin/platform-settings/docusign', {
      method: 'PATCH',
      body,
    })
    newPrivateKey.value = ''
    newWebhookSecret.value = ''
    showToast({ title: 'DocuSign settings saved', icon: 'success' })
  } catch (err: any) {
    if (err?.statusCode === 503 && err?.data?.code === 'docusign_consent_required') {
      consentUrl.value = err.data.consent_url ?? null
      showToast({
        title: 'DocuSign needs one-time consent — see banner below.',
        icon: 'error',
      })
    } else {
      showToast({
        title: err?.statusMessage || err?.message || 'Save failed',
        icon: 'error',
      })
    }
  } finally {
    saving.value = false
  }
}

async function clear(field: 'private_key' | 'webhook_secret') {
  const label = field === 'private_key' ? 'private key' : 'webhook secret'
  if (!confirm(`Clear the ${label}?`)) return
  saving.value = true
  try {
    cfg.value = await $fetch<Cfg>('/api/admin/platform-settings/docusign', {
      method: 'PATCH',
      body: { [field]: '' },
    })
    showToast({ title: `${label} cleared`, icon: 'success' })
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
    <UiPageHeader title="DocuSign settings">
      <template #description>
        Platform-wide DocuSign config powering the Send-for-eSign flow.
        Uses JWT grant for service-account-style authentication; the
        integration key + user need a one-time consent grant before
        first use.
      </template>
    </UiPageHeader>

    <p
      v-if="consentUrl"
      class="rounded-md border border-warning/40 bg-warning/5 px-3 py-3 text-xs text-foreground"
    >
      <strong>One-time DocuSign consent required.</strong>
      Visit the URL below in a browser, sign in as the integration user,
      and grant access. Then come back and re-save this page.
      <br>
      <a
        :href="consentUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-1 inline-block break-all font-mono text-[11px] text-primary underline"
      >{{ consentUrl }}</a>
    </p>

    <div v-if="loading" class="space-y-3">
      <div v-for="n in 5" :key="n" class="h-10 animate-pulse rounded-md bg-muted-foreground/10" />
    </div>

    <form
      v-else
      class="space-y-4"
      @submit.prevent="save"
    >
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Account ID</span>
          <input
            v-model="cfg.account_id"
            type="text"
            maxlength="80"
            placeholder="DocuSign API account UUID"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Base URI</span>
          <select
            v-model="cfg.base_uri"
            class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-xs"
          >
            <option value="demo.docusign.net">demo.docusign.net (sandbox)</option>
            <option value="na2.docusign.net">na2.docusign.net (production)</option>
            <option value="na3.docusign.net">na3.docusign.net</option>
            <option value="na4.docusign.net">na4.docusign.net</option>
            <option value="eu.docusign.net">eu.docusign.net</option>
          </select>
        </label>
      </div>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">Integration key (client ID)</span>
        <input
          v-model="cfg.integration_key"
          type="text"
          maxlength="80"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
        />
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">Impersonated user ID</span>
        <input
          v-model="cfg.user_id"
          type="text"
          maxlength="80"
          placeholder="The DocuSign user envelopes are sent as"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
        />
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">Redirect URI (consent flow)</span>
        <input
          v-model="cfg.redirect_uri"
          type="text"
          maxlength="2000"
          placeholder="Optional — used only by the consent grant URL"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
        />
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">
          Private key (PEM, RS256)
          <span v-if="cfg.private_key_set" class="ml-1 text-success">· configured</span>
          <span v-else class="ml-1 text-warning">· not set</span>
        </span>
        <textarea
          v-model="newPrivateKey"
          rows="6"
          autocomplete="off"
          :placeholder="cfg.private_key_set ? 'Leave empty to keep existing key' : '-----BEGIN RSA PRIVATE KEY-----\\n…'"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-[11px]"
        />
      </label>

      <label class="block">
        <span class="block text-xs font-medium text-muted-foreground">
          Webhook secret (HMAC-SHA256)
          <span v-if="cfg.webhook_secret_set" class="ml-1 text-success">· configured</span>
          <span v-else class="ml-1 text-warning">· not set</span>
        </span>
        <input
          v-model="newWebhookSecret"
          type="password"
          autocomplete="off"
          maxlength="200"
          :placeholder="cfg.webhook_secret_set ? 'Leave empty to keep existing secret' : 'Shared secret for /api/webhooks/docusign'"
          class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
        />
        <span class="mt-1 block text-[11px] text-muted-foreground">
          Configure this same value in DocuSign Connect's HMAC settings.
        </span>
      </label>

      <div class="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <button
          type="submit"
          class="rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
          :disabled="saving"
        >
          {{ saving ? 'Saving…' : 'Save settings' }}
        </button>
        <button
          v-if="cfg.private_key_set"
          type="button"
          class="rounded-md border border-destructive/30 bg-card px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 focus-ring disabled:opacity-60"
          :disabled="saving"
          @click="clear('private_key')"
        >
          Clear private key
        </button>
        <button
          v-if="cfg.webhook_secret_set"
          type="button"
          class="rounded-md border border-destructive/30 bg-card px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 focus-ring disabled:opacity-60"
          :disabled="saving"
          @click="clear('webhook_secret')"
        >
          Clear webhook secret
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
