<script setup lang="ts">
/**
 * /admin/ticker — manage the live data ticker shown below the
 * website nav (component: websiteo/app/components/TickerBanner.vue).
 *
 * Each row picks a `kind` (a closed enum mapped to a server-side
 * resolver), a `label` template with {{value}} substitution, an
 * optional link, a tone (mapped to UiBadge variants), and a
 * priority. Disabling a row hides it from the public ticker without
 * losing the row's config.
 *
 * Public read endpoint: /api/public/ticker (anon-readable, 60s cache).
 * Admin endpoints: /api/admin/ticker (GET/POST), /api/admin/ticker/:id (PATCH/DELETE).
 *
 * Uses the standard admin page primitives per
 * feedback_admin_page_primitive_recipe.
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
useHead({ title: 'Ticker | Admin' })

type TickerKind =
  | 'static'
  | 'new_listings_recent'
  | 'active_agents'
  | 'total_listings_online'
  | 'city_pulse'

type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'primary' | 'neutral'

type Row = {
  id: string
  kind: TickerKind
  label: string
  source_config: Record<string, unknown>
  tone: Tone
  link_url: string | null
  priority: number
  enabled: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

const KIND_LABELS: Record<TickerKind, string> = {
  static:                'Static — verbatim label',
  new_listings_recent:   'New listings (recent window)',
  active_agents:         'Active brokers + agents',
  total_listings_online: 'Total live listings',
  city_pulse:            'City pulse (price vs 90d)',
}

const TONES: Tone[] = ['success', 'warning', 'destructive', 'info', 'primary', 'neutral']

const items = ref<Row[]>([])
const loading = ref(false)
const saving = ref(false)

const enabledCount = computed(() => items.value.filter((i) => i.enabled).length)

const editorOpen = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const form = reactive({
  kind: 'static' as TickerKind,
  label: '',
  tone: 'neutral' as Tone,
  source_config_json: '{}',
  link_url: '',
  priority: 100,
  enabled: true,
  notes: '',
})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ items: Row[] }>('/api/admin/ticker')
    items.value = res.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load ticker', icon: 'error' })
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editorMode.value = 'create'
  editingId.value = null
  form.kind = 'static'
  form.label = ''
  form.tone = 'neutral'
  form.source_config_json = '{}'
  form.link_url = ''
  form.priority = 100
  form.enabled = true
  form.notes = ''
  editorOpen.value = true
}

function openEdit(row: Row) {
  editorMode.value = 'edit'
  editingId.value = row.id
  form.kind = row.kind
  form.label = row.label
  form.tone = row.tone
  form.source_config_json = JSON.stringify(row.source_config ?? {}, null, 2)
  form.link_url = row.link_url ?? ''
  form.priority = row.priority
  form.enabled = row.enabled
  form.notes = row.notes ?? ''
  editorOpen.value = true
}

async function submitEditor() {
  if (!form.label.trim()) {
    showToast({ title: 'Label is required', icon: 'error' })
    return
  }
  let sourceConfig: Record<string, unknown> = {}
  try {
    sourceConfig = form.source_config_json.trim() ? JSON.parse(form.source_config_json) : {}
    if (typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) {
      throw new Error('source_config must be a JSON object')
    }
  } catch (err: any) {
    showToast({ title: `Invalid source_config JSON: ${err?.message || 'parse failed'}`, icon: 'error' })
    return
  }

  const payload = {
    kind: form.kind,
    label: form.label.trim(),
    tone: form.tone,
    source_config: sourceConfig,
    link_url: form.link_url.trim() || null,
    priority: Number(form.priority) || 100,
    enabled: form.enabled,
    notes: form.notes.trim() || null,
  }

  saving.value = true
  try {
    if (editorMode.value === 'create') {
      await $fetch('/api/admin/ticker', { method: 'POST', body: payload })
      showToast({ title: 'Ticker added', icon: 'success' })
    } else if (editingId.value) {
      await $fetch(`/api/admin/ticker/${editingId.value}`, {
        method: 'PATCH',
        body: payload,
      })
      showToast({ title: 'Ticker updated', icon: 'success' })
    }
    editorOpen.value = false
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Save failed', icon: 'error' })
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(row: Row) {
  try {
    await $fetch(`/api/admin/ticker/${row.id}`, {
      method: 'PATCH',
      body: { enabled: !row.enabled },
    })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Toggle failed', icon: 'error' })
  }
}

async function deleteRow(row: Row) {
  if (!confirm(`Delete "${row.label}"? This is permanent. To temporarily hide, disable instead.`)) return
  try {
    await $fetch(`/api/admin/ticker/${row.id}`, { method: 'DELETE' })
    showToast({ title: 'Deleted', icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Delete failed', icon: 'error' })
  }
}

const kindHintByKind: Record<TickerKind, string> = {
  static:                'source_config: { "value": "string to show verbatim" }',
  new_listings_recent:   'source_config: { "window_days": 7 }',
  active_agents:         'source_config: { "window_days": 30 }',
  total_listings_online: 'source_config: {} (no params)',
  city_pulse:            'source_config: { "city_slug": "makati" } or { "city_id": 1 }',
}

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['admin.access']" max-width="wide">
    <UiPageHeader
      title="Ticker Banner"
      description="Live-data chips shown below the website nav. Each entry picks a kind, gets resolved server-side (new listings count, active agents, city pulse, etc.), and renders with the chosen tone + label template. Disable to hide without losing the config."
    >
      <template #actions>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          @click="load"
        >
          Refresh
        </button>
        <button type="button" class="btn-primary focus-ring" @click="openCreate">
          + New ticker
        </button>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <UiStatCard label="Tickers" :value="items.length" />
      <UiStatCard label="Enabled" :value="enabledCount" tone="success" />
      <UiStatCard
        label="Disabled"
        :value="items.length - enabledCount"
        :tone="items.length - enabledCount > 0 ? 'warning' : 'neutral'"
      />
    </div>

    <UiCard variant="surface" padding="none">
      <div v-if="loading" class="p-5 text-center text-meta">Loading…</div>
      <UiEmptyState
        v-else-if="items.length === 0"
        title="No ticker entries yet"
        description="Add a chip — pick a kind, write a label like '🆕 {{value}} new listings this week', and save."
      >
        <template #action>
          <button type="button" class="btn-primary focus-ring" @click="openCreate">
            + New ticker
          </button>
        </template>
      </UiEmptyState>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-muted/40">
            <tr>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground w-12">Pri</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Label / Kind</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Tone</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Config</th>
              <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">State</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="row in items" :key="row.id" :class="row.enabled ? '' : 'opacity-50'">
              <td class="px-3 py-2 tabular-nums text-xs">{{ row.priority }}</td>
              <td class="px-3 py-2 max-w-md">
                <div class="text-foreground">{{ row.label }}</div>
                <div class="text-[11px] text-muted-foreground mt-0.5">
                  <UiBadge variant="neutral">{{ KIND_LABELS[row.kind] }}</UiBadge>
                </div>
              </td>
              <td class="px-3 py-2">
                <UiBadge :variant="row.tone">{{ row.tone }}</UiBadge>
              </td>
              <td class="px-3 py-2 max-w-xs">
                <code class="block truncate font-mono text-[10px] text-muted-foreground" :title="JSON.stringify(row.source_config)">
                  {{ Object.keys(row.source_config ?? {}).length ? JSON.stringify(row.source_config) : '—' }}
                </code>
              </td>
              <td class="px-3 py-2 text-xs">
                <UiBadge :variant="row.enabled ? 'success' : 'neutral'">
                  {{ row.enabled ? 'enabled' : 'disabled' }}
                </UiBadge>
              </td>
              <td class="px-3 py-2 text-right">
                <div class="flex justify-end gap-3">
                  <button
                    type="button"
                    :class="['text-xs hover:underline', row.enabled ? 'text-warning' : 'text-success']"
                    @click="toggleEnabled(row)"
                  >
                    {{ row.enabled ? 'Disable' : 'Enable' }}
                  </button>
                  <button type="button" class="text-xs text-primary hover:underline" @click="openEdit(row)">Edit</button>
                  <button type="button" class="text-xs text-destructive hover:underline" @click="deleteRow(row)">Delete</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Create / Edit -->
    <UiModal
      :open="editorOpen"
      :title="`${editorMode === 'create' ? 'New' : 'Edit'} ticker entry`"
      subtitle="The label is a template — use {{value}} where the resolved live number/string should appear. Static rows can put the literal text in source_config.value and skip the placeholder."
      width="xl"
      @update:open="editorOpen = $event"
    >
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Kind</span>
          <select
            v-model="form.kind"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          >
            <option v-for="(label, key) in KIND_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
          <span class="text-[11px] text-muted-foreground mt-1 block">{{ kindHintByKind[form.kind] }}</span>
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Tone</span>
          <select
            v-model="form.tone"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          >
            <option v-for="t in TONES" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label class="block sm:col-span-2">
          <span class="block text-xs font-medium text-muted-foreground">Label (template)</span>
          <input
            v-model="form.label"
            type="text"
            maxlength="240"
            placeholder="🆕 {{value}} new listings this week"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          />
        </label>
        <label class="block sm:col-span-2">
          <span class="block text-xs font-medium text-muted-foreground">source_config (JSON)</span>
          <textarea
            v-model="form.source_config_json"
            rows="3"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus-ring"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Link URL (optional)</span>
          <input
            v-model="form.link_url"
            type="text"
            maxlength="500"
            placeholder="/buildings or https://…"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Priority (lower = first)</span>
          <input
            v-model.number="form.priority"
            type="number"
            min="0"
            max="10000"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-medium text-muted-foreground">Enabled</span>
          <select
            v-model="form.enabled"
            class="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-ring"
          >
            <option :value="true">Enabled — visible on the website</option>
            <option :value="false">Disabled — preserved but hidden</option>
          </select>
        </label>
        <label class="block sm:col-span-2">
          <span class="block text-xs font-medium text-muted-foreground">Notes (admin-only)</span>
          <textarea
            v-model="form.notes"
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
          :disabled="saving"
          @click="editorOpen = false"
        >
          Cancel
        </button>
        <button type="button" class="btn-primary focus-ring" :disabled="saving" @click="submitEditor">
          {{ saving ? 'Saving…' : editorMode === 'create' ? 'Create' : 'Save changes' }}
        </button>
      </template>
    </UiModal>
  </AdminPageShell>
</template>
