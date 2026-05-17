<script setup lang="ts">
/**
 * /admin/platform-settings — admin-managed config.
 *
 * Currently surfaces:
 *   * eis_provider — { url, token }: where the EIS submitter posts
 *   * eis_supplier — { tin, name, address }: identifies us to BIR
 *
 * Scope: per-org override OR global default. Operator picks via the
 * org dropdown at the top. Empty = global. Per-tenant rows shadow
 * global ones at lookup time (see migration 077).
 *
 * Token field is masked by default — operators reveal to confirm.
 */

import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import AdminPageHeader from '~/components/admin/shell/AdminPageHeader.vue'
import AdminCard from '~/components/admin/shell/AdminCard.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Platform settings | Admin' })

type Setting = {
  key: string
  value: Record<string, any>
  description: string | null
  updated_at: string | null
}

type Organization = {
  id: string
  name: string
  slug: string
}

const loading = ref(true)
const settings = ref<Record<string, Setting>>({})
// Cached global rows so per-tenant scope can show the inherited
// fallback value next to each empty input.
const globalSettings = ref<Record<string, Setting>>({})

const organizations = ref<Organization[]>([])
const selectedOrgId = ref<string | ''>('') // '' = global scope

const scopeLabel = computed(() => {
  if (!selectedOrgId.value) return 'Global default'
  const o = organizations.value.find((o) => o.id === selectedOrgId.value)
  return o ? `Override for ${o.name}` : 'Override'
})

const eisProvider = ref<{ url: string; token: string }>({ url: '', token: '' })
const eisSupplier = ref<{ tin: string; name: string; address: string }>({
  tin: '',
  name: '',
  address: '',
})
const showToken = ref(false)

const saving = ref<Record<string, boolean>>({})

async function loadOrganizations() {
  try {
    const res = await $fetch<{ items: Organization[] }>('/api/admin/organizations')
    organizations.value = res.items ?? []
  } catch {
    // Per-tenant editor still works; just no dropdown options.
    organizations.value = []
  }
}

// Pulled separately so the per-tenant editor can show "inherits global X"
// hints. Cached for the page lifetime — globals don't change often
// enough to need real-time freshness.
async function loadGlobalSettings() {
  try {
    const res = await $fetch<{ items: Setting[] }>('/api/admin/platform-settings')
    const map: Record<string, Setting> = {}
    for (const s of res.items) map[s.key] = s
    globalSettings.value = map
  } catch {
    globalSettings.value = {}
  }
}

// Helper: in per-tenant scope, returns the global fallback value for
// a key/path so the UI can show "(inherits 'foo')". Returns null in
// global scope (nothing to inherit from).
function inheritedFor(key: string, path: string): string {
  if (!selectedOrgId.value) return ''
  const g = globalSettings.value[key]
  if (!g || !g.value) return ''
  const v = g.value[path]
  if (typeof v === 'string' && v.trim().length > 0) return v
  return ''
}

async function load() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (selectedOrgId.value) params.organization_id = selectedOrgId.value
    const res = await $fetch<{ items: Setting[] }>('/api/admin/platform-settings', {
      query: params,
    })
    const map: Record<string, Setting> = {}
    for (const s of res.items) map[s.key] = s
    settings.value = map

    if (map.eis_provider) {
      eisProvider.value = {
        url: typeof map.eis_provider.value.url === 'string' ? map.eis_provider.value.url : '',
        token:
          typeof map.eis_provider.value.token === 'string'
            ? map.eis_provider.value.token
            : '',
      }
    }
    if (map.eis_supplier) {
      eisSupplier.value = {
        tin: typeof map.eis_supplier.value.tin === 'string' ? map.eis_supplier.value.tin : '',
        name:
          typeof map.eis_supplier.value.name === 'string' ? map.eis_supplier.value.name : '',
        address:
          typeof map.eis_supplier.value.address === 'string'
            ? map.eis_supplier.value.address
            : '',
      }
    }
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load settings', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function saveSetting(key: string, value: Record<string, any>) {
  saving.value[key] = true
  try {
    await $fetch(`/api/admin/platform-settings/${key}`, {
      method: 'PATCH',
      body: { value, organization_id: selectedOrgId.value || null },
    })
    showToast({
      title: `${key} saved (${selectedOrgId.value ? scopeLabel.value : 'global'})`,
    })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Save failed', icon: 'error' })
  } finally {
    saving.value[key] = false
  }
}

// Reload when org changes.
watch(selectedOrgId, () => {
  // Reset transient form state so a stale value doesn't leak into
  // the new scope's editor.
  eisProvider.value = { url: '', token: '' }
  eisSupplier.value = { tin: '', name: '', address: '' }
  load()
})

const isProviderConfigured = () =>
  eisProvider.value.url.trim() !== '' && eisProvider.value.token.trim() !== ''

onMounted(async () => {
  await Promise.all([loadOrganizations(), loadGlobalSettings()])
  await load()
})
</script>

<template>
  <AdminPageShell max-width="4xl">
    <AdminPageHeader title="Platform settings">
      Operator-managed config. Env vars take precedence; settings here fill
      the gaps without a Postgres restart.
    </AdminPageHeader>

    <!-- Scope picker -->
    <AdminCard>
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-sm font-medium text-foreground">Scope: {{ scopeLabel }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            Per-tenant rows shadow global ones at lookup time. Switch the
            organization to manage that tenant's overrides.
          </p>
        </div>
        <label class="block">
          <span class="sr-only">Organization scope</span>
          <select
            v-model="selectedOrgId"
            class="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
          >
            <option value="">Global default</option>
            <option v-for="o in organizations" :key="o.id" :value="o.id">
              {{ o.name }}
            </option>
          </select>
        </label>
      </div>
    </AdminCard>

    <AdminCard v-if="loading" padding="p-5">
      <p class="text-center text-sm text-muted-foreground">Loading…</p>
    </AdminCard>

    <template v-else>
      <!-- EIS provider -->
      <AdminCard>
        <header class="mb-3 flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-foreground">EIS provider</h2>
            <p class="mt-0.5 text-xs text-muted-foreground">
              Where the EIS submitter posts. Empty values = noop mode (the
              worker stamps rows submitted but doesn't contact BIR).
            </p>
          </div>
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
            :class="
              isProviderConfigured()
                ? 'bg-success/15 text-success'
                : 'bg-warning/15 text-warning'
            "
          >
            {{ isProviderConfigured() ? 'Live' : 'Noop' }}
          </span>
        </header>

        <div class="grid grid-cols-1 gap-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">URL</span>
            <input
              v-model="eisProvider.url"
              type="url"
              placeholder="https://eis.bir.gov.ph/api/v1/invoices"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <span
              v-if="!eisProvider.url && inheritedFor('eis_provider', 'url')"
              class="mt-1 block text-[10px] text-muted-foreground"
            >
              Inherits global: <code class="font-mono">{{ inheritedFor('eis_provider', 'url') }}</code>
            </span>
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">
              Bearer token
              <button
                type="button"
                class="ml-2 text-[10px] text-primary hover:underline"
                @click="showToken = !showToken"
              >
                {{ showToken ? 'hide' : 'reveal' }}
              </button>
            </span>
            <input
              v-model="eisProvider.token"
              :type="showToken ? 'text' : 'password'"
              autocomplete="off"
              class="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
            />
            <span
              v-if="!eisProvider.token && inheritedFor('eis_provider', 'token')"
              class="mt-1 block text-[10px] text-muted-foreground"
            >
              Inherits global token (configured)
            </span>
          </label>
        </div>
        <div class="mt-3 flex justify-end">
          <button
            type="button"
            :disabled="saving.eis_provider"
            class="btn-primary disabled:opacity-60"
            @click="saveSetting('eis_provider', { url: eisProvider.url.trim(), token: eisProvider.token.trim() })"
          >
            <span v-if="saving.eis_provider">Saving…</span>
            <span v-else>Save EIS provider</span>
          </button>
        </div>
      </AdminCard>

      <!-- EIS supplier -->
      <AdminCard>
        <header class="mb-3">
          <h2 class="text-base font-semibold text-foreground">EIS supplier (us)</h2>
          <p class="mt-0.5 text-xs text-muted-foreground">
            Supplier identity stamped into every EIS payload. Required for BIR
            acceptance.
          </p>
        </header>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">BIR TIN</span>
            <input
              v-model="eisSupplier.tin"
              type="text"
              maxlength="40"
              placeholder="000-000-000-000"
              class="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
            />
            <span
              v-if="!eisSupplier.tin && inheritedFor('eis_supplier', 'tin')"
              class="mt-1 block text-[10px] text-muted-foreground"
            >
              Inherits global: <code class="font-mono">{{ inheritedFor('eis_supplier', 'tin') }}</code>
            </span>
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Registered name</span>
            <input
              v-model="eisSupplier.name"
              type="text"
              maxlength="200"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <span
              v-if="!eisSupplier.name && inheritedFor('eis_supplier', 'name')"
              class="mt-1 block text-[10px] text-muted-foreground"
            >
              Inherits global: {{ inheritedFor('eis_supplier', 'name') }}
            </span>
          </label>
          <label class="block sm:col-span-2">
            <span class="block text-xs font-medium text-muted-foreground">Registered address</span>
            <input
              v-model="eisSupplier.address"
              type="text"
              maxlength="500"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <span
              v-if="!eisSupplier.address && inheritedFor('eis_supplier', 'address')"
              class="mt-1 block text-[10px] text-muted-foreground"
            >
              Inherits global: {{ inheritedFor('eis_supplier', 'address') }}
            </span>
          </label>
        </div>
        <div class="mt-3 flex justify-end">
          <button
            type="button"
            :disabled="saving.eis_supplier"
            class="btn-primary disabled:opacity-60"
            @click="
              saveSetting('eis_supplier', {
                tin: eisSupplier.tin.trim(),
                name: eisSupplier.name.trim(),
                address: eisSupplier.address.trim(),
              })
            "
          >
            <span v-if="saving.eis_supplier">Saving…</span>
            <span v-else>Save EIS supplier</span>
          </button>
        </div>
      </AdminCard>
    </template>
  </AdminPageShell>
</template>
