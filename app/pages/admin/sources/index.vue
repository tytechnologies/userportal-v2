<script setup lang="ts">
/**
 * /admin/sources — partner source CRUD.
 *
 * Lets operators add / disable / rotate-secret / migrate-to-vault
 * partner listing sources without dropping into the SQL editor.
 * Pairs with /admin/sources/health for SLO observability and with
 * /admin/raw-ingest for the dual-write pipeline.
 *
 * Secret handling:
 *   - Server never ships the actual bearer back on list/edit.
 *   - Bearer is returned ONCE on create + on rotate, displayed in a
 *     copyable affordance the operator dismisses manually. Never
 *     stored client-side beyond the modal's lifetime.
 */

import { ref, reactive, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'
import UiModal from '~/components/ui/UiModal.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Sources | Admin' })

type Source = {
  id: number
  slug: string
  display_name: string | null
  base_url: string | null
  enabled: boolean
  staleness_ttl_hours: number | null
  secret_state: 'vault' | 'plaintext' | 'unconfigured'
  last_ingested_at: string | null
  notes: string | null
  created_at: string | null
  updated_at: string | null
}

const sources = ref<Source[]>([])
const loading = ref(false)
const acting = ref<Record<number, string | null>>({})

const summary = computed(() => ({
  total:        sources.value.length,
  enabled:      sources.value.filter((s) => s.enabled).length,
  vault:        sources.value.filter((s) => s.secret_state === 'vault').length,
  plaintext:    sources.value.filter((s) => s.secret_state === 'plaintext').length,
}))

// Create modal.
const createOpen = ref(false)
const createSaving = ref(false)
const createForm = reactive({
  slug: '',
  display_name: '',
  base_url: '',
  staleness_ttl_hours: 168,
  notes: '',
})

// Bearer display modal (used by both create + rotate).
const bearerOpen = ref(false)
const bearerValue = ref<string | null>(null)
const bearerSourceLabel = ref<string>('')

// Edit modal.
const editOpen = ref(false)
const editing = ref<Source | null>(null)
const editForm = reactive({
  display_name: '',
  base_url: '',
  enabled: true,
  staleness_ttl_hours: 168,
  notes: '',
})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ sources: Source[] }>('/api/admin/sources')
    sources.value = res.sources ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load sources', icon: 'error' })
  } finally {
    loading.value = false
  }
}

function openCreate() {
  createForm.slug = ''
  createForm.display_name = ''
  createForm.base_url = ''
  createForm.staleness_ttl_hours = 168
  createForm.notes = ''
  createOpen.value = true
}

async function submitCreate() {
  if (!createForm.slug.trim() || !createForm.display_name.trim()) {
    showToast({ title: 'Slug + display name are required', icon: 'error' })
    return
  }
  createSaving.value = true
  try {
    const res = await $fetch<{ source: Source; bearer: string }>('/api/admin/sources', {
      method: 'POST',
      body: {
        slug: createForm.slug.trim(),
        display_name: createForm.display_name.trim(),
        base_url: createForm.base_url.trim() || null,
        staleness_ttl_hours: createForm.staleness_ttl_hours,
        notes: createForm.notes.trim() || null,
      },
    })
    createOpen.value = false
    bearerValue.value = res.bearer
    bearerSourceLabel.value = `${res.source.display_name} (${res.source.slug})`
    bearerOpen.value = true
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Create failed', icon: 'error' })
  } finally {
    createSaving.value = false
  }
}

function openEdit(s: Source) {
  editing.value = s
  editForm.display_name        = s.display_name ?? ''
  editForm.base_url            = s.base_url ?? ''
  editForm.enabled             = s.enabled
  editForm.staleness_ttl_hours = s.staleness_ttl_hours ?? 168
  editForm.notes               = s.notes ?? ''
  editOpen.value = true
}

async function submitEdit() {
  if (!editing.value) return
  const id = editing.value.id
  acting.value[id] = 'edit'
  try {
    await $fetch(`/api/admin/sources/${id}`, {
      method: 'PATCH',
      body: {
        display_name: editForm.display_name.trim(),
        base_url:     editForm.base_url.trim() || null,
        enabled:      editForm.enabled,
        staleness_ttl_hours: editForm.staleness_ttl_hours,
        notes:        editForm.notes.trim() || null,
      },
    })
    editOpen.value = false
    showToast({ title: 'Source updated', icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Update failed', icon: 'error' })
  } finally {
    acting.value[id] = null
  }
}

async function toggleEnabled(s: Source) {
  acting.value[s.id] = 'toggle'
  try {
    await $fetch(`/api/admin/sources/${s.id}`, {
      method: 'PATCH',
      body: { enabled: !s.enabled },
    })
    showToast({ title: s.enabled ? 'Source disabled' : 'Source enabled', icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Toggle failed', icon: 'error' })
  } finally {
    acting.value[s.id] = null
  }
}

async function rotate(s: Source) {
  if (!confirm(`Rotate ingest secret for "${s.display_name || s.slug}"? The current bearer will stop working immediately. The new bearer is shown ONCE — capture it before closing the modal.`)) return
  acting.value[s.id] = 'rotate'
  try {
    const res = await $fetch<{ bearer: string }>(`/api/admin/sources/${s.id}/rotate-secret`, {
      method: 'POST',
    })
    bearerValue.value = res.bearer
    bearerSourceLabel.value = `${s.display_name || s.slug} (${s.slug})`
    bearerOpen.value = true
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Rotate failed', icon: 'error' })
  } finally {
    acting.value[s.id] = null
  }
}

async function migrateToVault(s: Source) {
  if (!confirm(`Move "${s.display_name || s.slug}"'s plaintext secret into vault? Current secret value preserved (partner doesn't need to re-receive it).`)) return
  acting.value[s.id] = 'migrate'
  try {
    await $fetch(`/api/admin/sources/${s.id}/migrate-to-vault`, { method: 'POST' })
    showToast({ title: 'Migrated to vault', icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Migration failed', icon: 'error' })
  } finally {
    acting.value[s.id] = null
  }
}

function copyBearer() {
  if (!bearerValue.value) return
  navigator.clipboard.writeText(bearerValue.value).then(
    () => showToast({ title: 'Bearer copied to clipboard', icon: 'success' }),
    () => showToast({ title: 'Copy failed — select + copy manually', icon: 'error' }),
  )
}

function dismissBearer() {
  // Zero out before closing so the value doesn't linger in component state.
  bearerValue.value = null
  bearerSourceLabel.value = ''
  bearerOpen.value = false
}

const secretBadgeVariant = (state: Source['secret_state']) =>
  state === 'vault' ? 'success' : state === 'plaintext' ? 'warning' : 'destructive'

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['sources.manage', 'admin.access']" max-width="wide">
    <UiPageHeader
      title="Sources"
      description="Partner listing sources. Each row owns a bearer used on the x-source-secret header at /api/admin/listings/ingest. Secrets live in Supabase Vault; rotate or migrate plaintext via the row actions."
    >
      <template #actions>
        <NuxtLink
          to="/admin/sources/health"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
        >
          Health
        </NuxtLink>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          @click="load"
        >
          Refresh
        </button>
        <button
          type="button"
          class="btn-primary focus-ring"
          @click="openCreate"
        >
          + New source
        </button>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <UiStatCard label="Sources" :value="summary.total" />
      <UiStatCard label="Enabled" :value="summary.enabled" tone="success" />
      <UiStatCard label="Vault-stored" :value="summary.vault" tone="success" />
      <UiStatCard
        label="Plaintext (migrate me)"
        :value="summary.plaintext"
        :tone="summary.plaintext > 0 ? 'warning' : 'neutral'"
      />
    </div>

    <UiCard variant="surface" padding="none">
      <div v-if="loading" class="p-5 text-center text-meta">Loading…</div>
      <UiEmptyState
        v-else-if="sources.length === 0"
        title="No partner sources registered yet"
        description="Click 'New source' to register your first partner."
      />
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-muted/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">State</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Secret</th>
              <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">TTL (h)</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Last ingest</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="s in sources" :key="s.id" :class="!s.enabled ? 'opacity-60' : ''">
              <td class="px-3 py-2 max-w-xs">
                <div class="font-medium text-foreground">{{ s.display_name || s.slug }}</div>
                <div class="text-[11px] font-mono text-muted-foreground">{{ s.slug }}</div>
                <div v-if="s.base_url" class="text-[11px] text-muted-foreground truncate">{{ s.base_url }}</div>
              </td>
              <td class="px-3 py-2">
                <UiBadge :variant="s.enabled ? 'success' : 'neutral'">
                  {{ s.enabled ? 'enabled' : 'disabled' }}
                </UiBadge>
              </td>
              <td class="px-3 py-2">
                <UiBadge :variant="secretBadgeVariant(s.secret_state)">
                  {{ s.secret_state }}
                </UiBadge>
              </td>
              <td class="px-3 py-2 text-right tabular-nums text-xs">{{ s.staleness_ttl_hours ?? '—' }}</td>
              <td class="px-3 py-2 text-xs text-muted-foreground">
                {{ s.last_ingested_at ? new Date(s.last_ingested_at).toLocaleString() : '—' }}
              </td>
              <td class="px-3 py-2 text-right">
                <div class="flex justify-end gap-3 flex-wrap">
                  <button
                    type="button"
                    class="text-xs text-primary hover:underline"
                    :disabled="!!acting[s.id]"
                    @click="openEdit(s)"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    :class="['text-xs hover:underline', s.enabled ? 'text-warning' : 'text-success']"
                    :disabled="!!acting[s.id]"
                    @click="toggleEnabled(s)"
                  >
                    {{ s.enabled ? 'Disable' : 'Enable' }}
                  </button>
                  <button
                    v-if="s.secret_state === 'plaintext'"
                    type="button"
                    class="text-xs text-primary hover:underline"
                    :disabled="!!acting[s.id]"
                    @click="migrateToVault(s)"
                  >
                    Migrate to vault
                  </button>
                  <button
                    type="button"
                    class="text-xs text-destructive hover:underline"
                    :disabled="!!acting[s.id]"
                    @click="rotate(s)"
                  >
                    Rotate
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Create -->
    <UiModal :open="createOpen" title="New partner source" width="md" @update:open="createOpen = $event">
      <div class="grid grid-cols-1 gap-3">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Slug</span>
          <input
            v-model="createForm.slug"
            type="text"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
            placeholder="partner_xyz"
            maxlength="80"
          />
          <span class="text-[11px] text-muted-foreground">lowercase letters / digits / _ / -; partner-facing identifier</span>
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Display name</span>
          <input
            v-model="createForm.display_name"
            type="text"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
            placeholder="Partner XYZ"
            maxlength="200"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Base URL (optional)</span>
          <input
            v-model="createForm.base_url"
            type="url"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
            placeholder="https://partner.example.com"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Staleness TTL (hours)</span>
          <input
            v-model.number="createForm.staleness_ttl_hours"
            type="number"
            min="1"
            max="8760"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          />
          <span class="text-[11px] text-muted-foreground">Listings not re-observed within this window are auto-archived. Default 168 (7d).</span>
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Notes (optional)</span>
          <textarea
            v-model="createForm.notes"
            rows="2"
            maxlength="2000"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          />
        </label>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          :disabled="createSaving"
          @click="createOpen = false"
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn-primary focus-ring"
          :disabled="createSaving"
          @click="submitCreate"
        >
          {{ createSaving ? 'Creating…' : 'Create + mint secret' }}
        </button>
      </template>
    </UiModal>

    <!-- Edit -->
    <UiModal :open="editOpen" title="Edit source" width="md" @update:open="editOpen = $event">
      <div v-if="editing" class="grid grid-cols-1 gap-3">
        <div class="text-xs text-muted-foreground">Slug <span class="font-mono">{{ editing.slug }}</span> can't be changed.</div>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Display name</span>
          <input
            v-model="editForm.display_name"
            type="text"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
            maxlength="200"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Base URL</span>
          <input
            v-model="editForm.base_url"
            type="url"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Enabled</span>
          <select
            v-model="editForm.enabled"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          >
            <option :value="true">Enabled</option>
            <option :value="false">Disabled</option>
          </select>
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Staleness TTL (hours)</span>
          <input
            v-model.number="editForm.staleness_ttl_hours"
            type="number"
            min="1"
            max="8760"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Notes</span>
          <textarea
            v-model="editForm.notes"
            rows="2"
            maxlength="2000"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          />
        </label>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          @click="editOpen = false"
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn-primary focus-ring"
          @click="submitEdit"
        >
          Save
        </button>
      </template>
    </UiModal>

    <!-- Bearer display -->
    <UiModal :open="bearerOpen" title="Capture the bearer NOW" width="md" @update:open="bearerOpen = $event">
      <div class="space-y-3">
        <div class="text-sm">
          <strong>{{ bearerSourceLabel }}</strong>
        </div>
        <div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
          This is the only time the bearer is shown. Copy it now and hand it to the partner over a secure channel. You will not be able to recover this value later — the only way to surface a new bearer is to rotate again.
        </div>
        <div
          v-if="bearerValue"
          class="rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs break-all select-all"
        >
          {{ bearerValue }}
        </div>
      </div>
      <template #footer>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          @click="copyBearer"
        >
          Copy
        </button>
        <button
          type="button"
          class="btn-primary focus-ring"
          @click="dismissBearer"
        >
          Done
        </button>
      </template>
    </UiModal>
  </AdminPageShell>
</template>
