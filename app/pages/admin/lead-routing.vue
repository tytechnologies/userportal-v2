<script setup lang="ts">
/**
 * /admin/lead-routing — automatic inquiry-routing rules.
 *
 * Rules are walked priority-ASC by the BEFORE INSERT trigger on
 * inquiries; first match wins. When no rule matches, the existing
 * snapshot of listings.created_by stays intact (so this is purely
 * additive on top of legacy routing behavior).
 *
 * The rule editor here is intentionally low-tech for v1 — operators
 * paste user UUIDs into the action fields. A typeahead lookup against
 * /api/admin/users is a clear v2 follow-up.
 */

import { ref, reactive, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiStatCard from '~/components/ui/UiStatCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'

definePageMeta({ layout: 'default' })
useHead({ title: 'Lead Routing | Admin' })

type ActionKind = 'assign_user' | 'round_robin_pool'
type Source = string

type Criteria = {
  property_type?: string | string[]
  listing_kind?: 'sale' | 'rent' | 'sale_or_rent'
  city_id?: number | number[]
  barangay_id?: number | number[]
  min_price?: number
  max_price?: number
  source?: Source | Source[]
  has_listing?: boolean
}

type Rule = {
  id: string
  name: string
  description: string | null
  priority: number
  enabled: boolean
  criteria: Criteria
  action_kind: ActionKind
  assign_user_id: string | null
  pool_user_ids: string[] | null
  pool_state: { last_index?: number }
  match_count: number
  last_matched_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

// Access check is handled by AdminPageShell via the `permission` prop;
// no inline isChecking / allowed / router needed.

const rules = ref<Rule[]>([])
const loading = ref(false)
const togglingRow = ref<Record<string, boolean>>({})

// Editor modal state — single shape for both create + edit.
const editorModal = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const form = reactive({
  name: '',
  description: '',
  priority: 100,
  enabled: true,
  criteria_json: '{\n  "property_type": "condo"\n}',
  action_kind: 'assign_user' as ActionKind,
  assign_user_id: '',
  pool_user_ids_text: '', // comma-separated UUIDs
  notes: '',
})
const saving = ref(false)

// Preview state (evaluate against hypothetical inquiry).
const previewModal = ref(false)
const previewForm = reactive({
  listing_id: '' as string | number,
  source: 'website',
})
const previewing = ref(false)
const previewResult = ref<{
  matched: boolean
  rule_id?: string
  rule_name?: string
  priority?: number
  action_kind?: ActionKind
  would_assign_to?: string | null
  pool_user_ids?: string[] | null
} | null>(null)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ items: Rule[] }>('/api/admin/lead-routing-rules', {
      query: { limit: 200 },
    })
    rules.value = res.items ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load rules',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editorMode.value = 'create'
  editingId.value = null
  form.name = ''
  form.description = ''
  form.priority = nextSuggestedPriority()
  form.enabled = true
  form.criteria_json = '{\n  "property_type": "condo"\n}'
  form.action_kind = 'assign_user'
  form.assign_user_id = ''
  form.pool_user_ids_text = ''
  form.notes = ''
  editorModal.value = true
}

function openEdit(r: Rule) {
  editorMode.value = 'edit'
  editingId.value = r.id
  form.name = r.name
  form.description = r.description ?? ''
  form.priority = r.priority
  form.enabled = r.enabled
  form.criteria_json = JSON.stringify(r.criteria ?? {}, null, 2)
  form.action_kind = r.action_kind
  form.assign_user_id = r.assign_user_id ?? ''
  form.pool_user_ids_text = (r.pool_user_ids ?? []).join(', ')
  form.notes = r.notes ?? ''
  editorModal.value = true
}

function nextSuggestedPriority(): number {
  if (rules.value.length === 0) return 100
  const maxPriority = Math.max(...rules.value.map((r) => r.priority))
  return Math.min(maxPriority + 10, 10000)
}

async function save() {
  if (!form.name.trim()) {
    showToast({ title: 'Name is required', icon: 'warning' })
    return
  }
  let criteria: Criteria
  try {
    criteria = JSON.parse(form.criteria_json)
    if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
      throw new Error('criteria must be an object')
    }
  } catch (err: any) {
    showToast({
      title: `Invalid criteria JSON: ${err?.message ?? 'parse failed'}`,
      icon: 'warning',
    })
    return
  }

  let assignUserId: string | null = null
  let poolUserIds: string[] | null = null
  if (form.action_kind === 'assign_user') {
    if (!/^[0-9a-f-]{36}$/i.test(form.assign_user_id.trim())) {
      showToast({ title: 'assign_user_id must be a uuid', icon: 'warning' })
      return
    }
    assignUserId = form.assign_user_id.trim()
  } else {
    const ids = form.pool_user_ids_text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const bad = ids.filter((id) => !/^[0-9a-f-]{36}$/i.test(id))
    if (bad.length > 0) {
      showToast({
        title: `Invalid pool UUIDs: ${bad.slice(0, 3).join(', ')}`,
        icon: 'warning',
      })
      return
    }
    if (ids.length === 0) {
      showToast({ title: 'Round-robin pool needs at least one user UUID', icon: 'warning' })
      return
    }
    poolUserIds = ids
  }

  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      priority: form.priority,
      enabled: form.enabled,
      criteria,
      action_kind: form.action_kind,
      assign_user_id: assignUserId,
      pool_user_ids: poolUserIds,
      notes: form.notes.trim() || null,
    }
    if (editorMode.value === 'create') {
      await $fetch('/api/admin/lead-routing-rules', { method: 'POST', body: payload })
      showToast({ title: 'Rule created' })
    } else if (editingId.value) {
      await $fetch(`/api/admin/lead-routing-rules/${editingId.value}`, {
        method: 'PATCH',
        body: payload,
      })
      showToast({ title: 'Rule saved' })
    }
    editorModal.value = false
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Save failed',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(r: Rule) {
  togglingRow.value[r.id] = true
  try {
    await $fetch(`/api/admin/lead-routing-rules/${r.id}`, {
      method: 'PATCH',
      body: { enabled: !r.enabled },
    })
    r.enabled = !r.enabled
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Toggle failed',
      icon: 'error',
    })
  } finally {
    togglingRow.value[r.id] = false
  }
}

async function deleteRule(r: Rule) {
  if (!confirm(`Hard-delete rule "${r.name}"? Past matches stay in the audit log; this just removes the rule row.`)) return
  try {
    await $fetch(`/api/admin/lead-routing-rules/${r.id}`, { method: 'DELETE' })
    showToast({ title: 'Rule deleted' })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Delete failed',
      icon: 'error',
    })
  }
}

async function openPreview() {
  previewForm.listing_id = ''
  previewForm.source = 'website'
  previewResult.value = null
  previewModal.value = true
}

async function runPreview() {
  previewing.value = true
  try {
    const lid = previewForm.listing_id ? Number(previewForm.listing_id) : null
    if (lid !== null && (!Number.isFinite(lid) || lid <= 0)) {
      showToast({ title: 'listing_id must be a positive integer', icon: 'warning' })
      return
    }
    const res = await $fetch<typeof previewResult.value>(
      '/api/admin/lead-routing-rules/evaluate',
      {
        method: 'POST',
        body: { listing_id: lid, source: previewForm.source },
      },
    )
    previewResult.value = res
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Evaluation failed',
      icon: 'error',
    })
  } finally {
    previewing.value = false
  }
}

const totalMatches = computed(() =>
  rules.value.reduce((sum, r) => sum + (r.match_count ?? 0), 0),
)
const enabledCount = computed(() => rules.value.filter((r) => r.enabled).length)

function actionSummary(r: Rule): string {
  if (r.action_kind === 'assign_user') {
    return `→ user ${(r.assign_user_id ?? '').slice(0, 8)}…`
  }
  const n = r.pool_user_ids?.length ?? 0
  return `→ round-robin ${n} user${n === 1 ? '' : 's'}`
}

onMounted(load)
</script>

<template>
  <AdminPageShell :permission="['lead_routing.manage', 'admin.access']" max-width="wide">
    <UiPageHeader
      title="Lead Routing"
      description="Auto-assign incoming inquiries by criteria. Rules are walked priority-ASC by the BEFORE INSERT trigger; first match wins and overrides the legacy listing-creator snapshot. Inquiries that match no rule fall through to the existing default."
    >
      <template #actions>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-ring"
          @click="openPreview"
        >
          Preview
        </button>
        <button
          type="button"
          class="btn-primary focus-ring"
          @click="openCreate"
        >
          + Create rule
        </button>
      </template>
    </UiPageHeader>

    <!-- Summary strip -->
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <UiStatCard label="Rules" :value="rules.length" />
      <UiStatCard label="Enabled" :value="enabledCount" tone="success" />
      <UiStatCard label="Lifetime matches" :value="totalMatches.toLocaleString()" />
    </div>

    <!-- Rules table -->
    <UiCard variant="surface" padding="none">
      <div v-if="loading" class="p-5 text-center text-meta">
        Loading…
      </div>
      <UiEmptyState
        v-else-if="rules.length === 0"
        title="No routing rules yet"
        description="New inquiries fall through to the legacy listing-creator snapshot."
      >
        <template #action>
          <button
            type="button"
            class="btn-primary focus-ring"
            @click="openCreate"
          >
            Create your first rule
          </button>
        </template>
      </UiEmptyState>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground w-16">Pri</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Rule</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Criteria</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Action</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Matches</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Last match</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="r in rules" :key="r.id" :class="!r.enabled ? 'opacity-60' : ''">
                <td class="px-3 py-2 tabular-nums text-xs">{{ r.priority }}</td>
                <td class="px-3 py-2">
                  <div class="font-medium text-foreground">{{ r.name }}</div>
                  <div v-if="r.description" class="text-[11px] text-muted-foreground">{{ r.description }}</div>
                </td>
                <td class="px-3 py-2 max-w-xs">
                  <code class="block truncate font-mono text-[10px] text-muted-foreground" :title="JSON.stringify(r.criteria)">
                    {{ Object.keys(r.criteria ?? {}).length === 0 ? '(catch-all)' : JSON.stringify(r.criteria) }}
                  </code>
                </td>
                <td class="px-3 py-2 font-mono text-xs">{{ actionSummary(r) }}</td>
                <td class="px-3 py-2 text-right tabular-nums text-xs">
                  {{ r.match_count.toLocaleString() }}
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  {{ r.last_matched_at ? new Date(r.last_matched_at).toLocaleString() : '—' }}
                </td>
                <td class="px-3 py-2 text-right">
                  <div class="flex justify-end gap-3">
                    <button
                      type="button"
                      :disabled="togglingRow[r.id]"
                      :class="[
                        'text-xs hover:underline disabled:opacity-60',
                        r.enabled ? 'text-warning' : 'text-success',
                      ]"
                      @click="toggleEnabled(r)"
                    >
                      {{ r.enabled ? 'Disable' : 'Enable' }}
                    </button>
                    <button
                      type="button"
                      class="text-xs text-primary hover:underline"
                      @click="openEdit(r)"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="text-xs text-destructive hover:underline"
                      @click="deleteRule(r)"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <!-- Create / Edit routing rule — Phase 5 Operations primitive -->
      <UiModal
        :open="editorModal"
        :title="`${editorMode === 'create' ? 'Create' : 'Edit'} routing rule`"
        subtitle="Lower priority number = runs first. First match wins. Empty criteria = catch-all (use a high priority number for default-of-last-resort)."
        width="xl"
        @update:open="editorModal = $event"
      >
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="block sm:col-span-2">
              <span class="block text-xs font-medium text-muted-foreground">Name</span>
              <input
                v-model="form.name"
                type="text"
                maxlength="200"
                placeholder="e.g. Makati condos to Maria"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block sm:col-span-2">
              <span class="block text-xs font-medium text-muted-foreground">Description (optional)</span>
              <input
                v-model="form.description"
                type="text"
                maxlength="2000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Priority (0-10000, lower = first)</span>
              <input
                v-model.number="form.priority"
                type="number"
                min="0"
                max="10000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm tabular-nums text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="flex items-end gap-2 text-sm text-foreground">
              <input
                v-model="form.enabled"
                type="checkbox"
                class="h-4 w-4 rounded border-border"
              />
              <span>Enabled</span>
            </label>
          </div>

          <label class="mt-3 block">
            <span class="block text-xs font-medium text-muted-foreground">
              Criteria (JSON object — empty {} matches everything)
            </span>
            <textarea
              v-model="form.criteria_json"
              rows="6"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <span class="mt-1 block text-[11px] text-muted-foreground">
              Supported keys: <code>property_type</code>, <code>listing_kind</code>
              ('sale'|'rent'), <code>city_id</code>, <code>barangay_id</code>,
              <code>min_price</code>, <code>max_price</code>, <code>source</code>,
              <code>has_listing</code>. Each accepts a single value or array.
            </span>
          </label>

          <label class="mt-3 block">
            <span class="block text-xs font-medium text-muted-foreground">Action</span>
            <select
              v-model="form.action_kind"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            >
              <option value="assign_user">Assign to a specific user</option>
              <option value="round_robin_pool">Round-robin a pool of users</option>
            </select>
          </label>

          <label v-if="form.action_kind === 'assign_user'" class="mt-3 block">
            <span class="block text-xs font-medium text-muted-foreground">Assign to (user UUID)</span>
            <input
              v-model="form.assign_user_id"
              type="text"
              maxlength="36"
              placeholder="00000000-0000-0000-0000-000000000000"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <span class="mt-1 block text-[11px] text-muted-foreground">
              Copy the UUID from /admin Users tab.
            </span>
          </label>
          <label v-else class="mt-3 block">
            <span class="block text-xs font-medium text-muted-foreground">
              Round-robin pool (UUIDs, comma or newline separated)
            </span>
            <textarea
              v-model="form.pool_user_ids_text"
              rows="3"
              placeholder="00000000-0000-0000-0000-000000000000, 11111111-..."
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
            <span class="mt-1 block text-[11px] text-muted-foreground">
              Trigger advances mod pool length on each match.
            </span>
          </label>

          <label class="mt-3 block">
            <span class="block text-xs font-medium text-muted-foreground">Notes (optional, audited)</span>
            <textarea
              v-model="form.notes"
              rows="2"
              maxlength="2000"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>

        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="editorModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="saving"
              class="btn-primary disabled:opacity-60"
              @click="save"
            >
              <span v-if="saving">Saving…</span>
              <span v-else>{{ editorMode === 'create' ? 'Create' : 'Save' }}</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Preview match — Phase 5 Operations primitive -->
      <UiModal
        :open="previewModal"
        title="Preview match"
        subtitle="Walks the active rules against a hypothetical inquiry and shows which one would match. No DB writes; safe to run repeatedly."
        width="md"
        @update:open="previewModal = $event"
      >
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Listing id (optional)</span>
            <input
              v-model="previewForm.listing_id"
              type="number"
              min="1"
              placeholder="leave blank to test no-listing inquiry"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Source</span>
            <input
              v-model="previewForm.source"
              type="text"
              maxlength="80"
              placeholder="website"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
        </div>
        <div v-if="previewResult" class="mt-4 border-t border-border pt-3">
          <div v-if="!previewResult.matched" class="text-sm text-muted-foreground">
            <strong class="text-foreground">No match.</strong>
            The inquiry would fall through to the legacy listing-creator snapshot.
          </div>
          <div v-else>
            <div class="flex flex-wrap items-center gap-2">
              <UiBadge variant="success" size="sm" dot>Match</UiBadge>
              <span class="text-sm font-medium text-foreground">{{ previewResult.rule_name }}</span>
              <span class="text-xs text-muted-foreground">priority {{ previewResult.priority }}</span>
            </div>
            <div class="mt-1 font-mono text-[11px] text-muted-foreground">
              {{ previewResult.action_kind === 'assign_user'
                  ? `→ assign user ${previewResult.would_assign_to}`
                  : `→ round-robin from pool of ${previewResult.pool_user_ids?.length ?? 0}` }}
            </div>
          </div>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="previewModal = false"
            >
              Close
            </button>
            <button
              type="button"
              :disabled="previewing"
              class="btn-primary disabled:opacity-60"
              @click="runPreview"
            >
              <span v-if="previewing">Evaluating…</span>
              <span v-else>Evaluate</span>
            </button>
          </div>
        </template>
      </UiModal>
  </AdminPageShell>
</template>
