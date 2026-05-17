<script setup lang="ts">
/**
 * /admin/ai-suggestions — review queue for LLM-generated suggestions.
 *
 * Phase D foundation. Lists pending suggestions with kind filter.
 * Per-row actions: accept (operator-edited payload optional) → status='accepted',
 * reject with reason → status='rejected'.
 *
 * Acceptance does NOT auto-mutate the target. The domain action
 * (e.g., update listing description, mark duplicate as confirmed)
 * runs through its existing RPC separately. This page just records
 * the operator's verdict on the suggestion itself.
 *
 * Suggestions are inserted by the AI worker (deferred — drops in
 * when an LLM provider is wired). For now operators can paste
 * suggestions in via the Supabase SQL editor.
 */

import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'AI Suggestions | Admin' })

type Status = 'pending' | 'accepted' | 'rejected' | 'superseded' | 'expired'

type Suggestion = {
  id: string
  kind: string
  target_kind: string
  target_id: string
  suggested_payload: Record<string, unknown>
  model_provider: string | null
  model_name: string | null
  prompt_version: string | null
  confidence: number | null
  status: Status
  reviewed_by: string | null
  reviewed_at: string | null
  reject_reason: string | null
  created_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const suggestions = ref<Suggestion[]>([])
const loading = ref(false)
const statusFilter = ref<Status | 'all'>('pending')
const kindFilter = ref('')

const expandedId = ref<string | null>(null)
const acting = ref<Record<string, 'accept' | 'reject' | null>>({})
const rejectReasons = ref<Record<string, string>>({})

// Worker trigger state.
const runningWorker = ref(false)
const lastRunStats = ref<Record<string, { candidates: number; written: number; failed: number }> | null>(null)

// Manual-create modal state.
const createModal = ref(false)
const createForm = reactive({
  kind: 'listing.description_enrichment',
  target_kind: 'listing',
  target_id: '',
  payload_json: '{\n  "proposed_description": "",\n  "diff_summary": ""\n}',
  confidence: 0.8,
  prompt_version: '',
})
const creatingSuggestion = ref(false)

async function load() {
  loading.value = true
  try {
    // Direct Supabase REST via PostgREST since there's no dedicated
    // /api/admin endpoint yet — keep this turn small. The RLS policy
    // already gates to ai_suggestions.manage, so any auth'd admin
    // call works. Future: dedicated endpoint with pagination.
    const params = new URLSearchParams()
    params.set('select', '*')
    params.set('order', 'created_at.desc')
    if (statusFilter.value !== 'all') params.set('status', `eq.${statusFilter.value}`)
    if (kindFilter.value) params.set('kind', `eq.${kindFilter.value}`)
    params.set('limit', '200')

    // The userportal already has Supabase client configured for the page
    // context; we'll go through $fetch on the standard PostgREST URL when
    // available. Until a dedicated endpoint lands, route through the
    // existing /api/me as a connectivity probe and fall back to empty.
    // Placeholder: ship the UI; backend GET endpoint follows.
    const items = await $fetch<{ items: Suggestion[] }>('/api/admin/ai-suggestions', {
      query: {
        status: statusFilter.value !== 'all' ? statusFilter.value : undefined,
        kind: kindFilter.value || undefined,
      },
    }).catch(() => ({ items: [] }))
    suggestions.value = items.items ?? []
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Could not load suggestions', icon: 'error' })
  } finally {
    loading.value = false
  }
}

async function accept(s: Suggestion) {
  acting.value[s.id] = 'accept'
  try {
    const res = await $fetch<{
      dispatch: { status: 'applied' | 'noop' | 'failed'; detail?: string } | null
    }>(`/api/admin/ai-suggestions/${s.id}`, {
      method: 'PATCH',
      body: { status: 'accepted' },
    })
    if (res?.dispatch?.status === 'applied') {
      showToast({ title: 'Accepted + applied to target' })
    } else if (res?.dispatch?.status === 'failed') {
      showToast({
        title: `Accepted, but apply failed: ${res.dispatch.detail ?? 'unknown error'}`,
        icon: 'warning',
      })
    } else if (res?.dispatch?.status === 'noop') {
      showToast({ title: `Accepted (no change applied: ${res.dispatch.detail})` })
    } else {
      showToast({ title: 'Suggestion accepted' })
    }
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Accept failed', icon: 'error' })
  } finally {
    acting.value[s.id] = null
  }
}

async function reject(s: Suggestion) {
  const reason = (rejectReasons.value[s.id] ?? '').trim()
  if (!reason) {
    showToast({ title: 'Reason required to reject', icon: 'warning' })
    return
  }
  acting.value[s.id] = 'reject'
  try {
    await $fetch(`/api/admin/ai-suggestions/${s.id}`, {
      method: 'PATCH',
      body: { status: 'rejected', reject_reason: reason },
    })
    showToast({ title: 'Suggestion rejected' })
    rejectReasons.value[s.id] = ''
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Reject failed', icon: 'error' })
  } finally {
    acting.value[s.id] = null
  }
}

const counts = computed(() => {
  const c: Record<string, number> = {
    all: suggestions.value.length,
    pending: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
    expired: 0,
  }
  for (const s of suggestions.value) c[s.status] = (c[s.status] ?? 0) + 1
  return c
})

async function runWorker() {
  runningWorker.value = true
  try {
    const res = await $fetch<{
      ok: boolean
      total_written: number
      stats: Record<string, { candidates: number; written: number; failed: number }>
    }>('/api/admin/ai-worker/run-now', {
      method: 'POST',
      body: {},
    })
    lastRunStats.value = res.stats ?? null
    showToast({
      title: `Worker tick: ${res.total_written} suggestion(s) written across ${Object.keys(res.stats ?? {}).length} kind(s)`,
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Worker run failed',
      icon: 'error',
    })
  } finally {
    runningWorker.value = false
  }
}

function openCreate() {
  createForm.kind = 'listing.description_enrichment'
  createForm.target_kind = 'listing'
  createForm.target_id = ''
  createForm.payload_json = '{\n  "proposed_description": "",\n  "diff_summary": ""\n}'
  createForm.confidence = 0.8
  createForm.prompt_version = ''
  createModal.value = true
}

async function createSuggestion() {
  if (!createForm.target_id.trim()) {
    showToast({ title: 'target_id is required', icon: 'warning' })
    return
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(createForm.payload_json)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('payload must be an object')
    }
  } catch (err: any) {
    showToast({
      title: `Invalid JSON: ${err?.message ?? 'parse failed'}`,
      icon: 'warning',
    })
    return
  }
  creatingSuggestion.value = true
  try {
    await $fetch('/api/admin/ai-suggestions', {
      method: 'POST',
      body: {
        kind: createForm.kind,
        target_kind: createForm.target_kind,
        target_id: createForm.target_id.trim(),
        suggested_payload: payload,
        confidence: createForm.confidence,
        prompt_version: createForm.prompt_version.trim() || null,
      },
    })
    showToast({ title: 'Suggestion created' })
    createModal.value = false
    statusFilter.value = 'pending'
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not create suggestion',
      icon: 'error',
    })
  } finally {
    creatingSuggestion.value = false
  }
}

function statusClass(s: Status) {
  if (s === 'accepted') return 'bg-success/15 text-success'
  if (s === 'rejected') return 'bg-destructive/15 text-destructive'
  if (s === 'pending') return 'bg-warning/15 text-warning'
  return 'bg-muted text-muted-foreground'
}

onMounted(async () => {
  const ok =
    (await hasPermission('ai_suggestions.manage')) ||
    (await hasPermission('admin.access'))
  isChecking.value = false
  if (!ok) {
    showToast({ title: 'Access denied', icon: 'warning' })
    router.replace('/dashboard')
    return
  }
  allowed.value = true
  await load()
})
</script>

<template>
  <div class="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <div
      v-if="isChecking"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Checking access…
    </div>

    <template v-else-if="allowed">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 class="text-page-title">
            AI Suggestions
          </h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Review and verdict on LLM-generated suggestions. Accepting
            <em>records</em> the verdict — applying the change runs through
            its own domain RPC.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            :disabled="runningWorker"
            class="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-ring disabled:opacity-60"
            title="Run the candidate-finder + LLM completion pipeline now (idempotent)"
            @click="runWorker"
          >
            <span v-if="runningWorker">Running…</span>
            <span v-else>Run worker now</span>
          </button>
          <button
            type="button"
            class="btn-primary focus-ring"
            @click="openCreate"
          >
            + Add suggestion
          </button>
        </div>
      </header>

      <div class="rounded-lg border border-success/30 bg-success/5 p-4 text-xs text-success">
        <p class="font-semibold">Pipeline shipped.</p>
        <p class="mt-1 text-foreground">
          Schema, provider abstraction (Anthropic + OpenAI + safe noop fallback),
          per-kind candidate finders (<code>listing.description_enrichment</code>,
          <code>inquiry.summarisation</code>), per-kind dispatcher, admin queue,
          and verdict-with-dispatch are all live. To enable real generations
          set <code>AI_SUGGESTION_PROVIDER</code> + the matching API key
          (<code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code>) and
          <code>AI_WORKER_SECRET</code>. With no provider configured the worker
          writes a clearly-labelled <em>noop</em> placeholder so the queue
          still flows in dev.
        </p>
        <p
          v-if="lastRunStats"
          class="mt-2 rounded bg-background p-2 font-mono text-[11px] text-foreground"
        >
          Last manual run: {{ JSON.stringify(lastRunStats) }}
        </p>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="opt in (['pending', 'accepted', 'rejected', 'superseded', 'expired', 'all'] as const)"
          :key="opt"
          type="button"
          :class="[
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
            statusFilter === opt
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
          ]"
          @click="statusFilter = opt; load()"
        >
          <span class="capitalize">{{ opt }}</span>
          <span
            :class="[
              'rounded-full px-1.5 text-[10px] font-semibold',
              statusFilter === opt ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground',
            ]"
          >{{ counts[opt] }}</span>
        </button>
        <select
          v-model="kindFilter"
          class="rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:border-ring focus:ring-1 focus:ring-ring"
          @change="load"
        >
          <option value="">All kinds</option>
          <option value="listing.description_enrichment">Listing description enrichment</option>
          <option value="listing.duplicate_review_assist">Duplicate review assist</option>
          <option value="inquiry.summarisation">Inquiry summarisation</option>
          <option value="document_draft.field_autofill">Document field autofill</option>
          <option value="moderation.first_pass">Moderation first pass</option>
        </select>
      </div>

      <!-- List -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">Loading…</div>
        <div
          v-else-if="suggestions.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No suggestions in this view.
        </div>
        <ul v-else class="divide-y divide-border">
          <li v-for="s in suggestions" :key="s.id" class="p-4 hover:bg-muted/40">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="mb-1 flex flex-wrap items-center gap-2">
                  <span :class="['inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(s.status)]">
                    {{ s.status }}
                  </span>
                  <span class="text-xs font-semibold text-foreground">{{ s.kind }}</span>
                  <span class="text-xs text-muted-foreground">
                    on {{ s.target_kind }}
                    <code class="ml-1 font-mono text-[10px]">{{ s.target_id.slice(0, 12) }}…</code>
                  </span>
                  <span v-if="s.confidence !== null" class="text-xs text-muted-foreground">
                    · confidence {{ (Number(s.confidence) * 100).toFixed(0) }}%
                  </span>
                </div>
                <p class="text-xs text-muted-foreground">
                  {{ s.model_provider }} / {{ s.model_name }}
                  <span v-if="s.prompt_version">· prompt {{ s.prompt_version }}</span>
                  · {{ new Date(s.created_at).toLocaleString() }}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  class="text-xs text-primary underline-offset-2 hover:underline"
                  @click="expandedId = expandedId === s.id ? null : s.id"
                >
                  {{ expandedId === s.id ? 'Collapse' : 'Review' }}
                </button>
              </div>
            </div>

            <div
              v-if="expandedId === s.id"
              class="mt-3 rounded-lg border border-border bg-muted/40 p-3"
            >
              <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Suggested payload
              </p>
              <pre class="overflow-x-auto rounded bg-background p-2 text-[11px] text-foreground">{{ JSON.stringify(s.suggested_payload, null, 2) }}</pre>

              <div v-if="s.reject_reason" class="mt-2 text-xs text-destructive">
                <span class="font-semibold">Rejected:</span> {{ s.reject_reason }}
              </div>

              <div v-if="s.status === 'pending'" class="mt-3 space-y-2">
                <textarea
                  v-model="rejectReasons[s.id]"
                  rows="2"
                  maxlength="500"
                  placeholder="Reason for rejection (required if rejecting)…"
                  class="block w-full rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground focus:border-ring focus:ring-1 focus:ring-ring"
                />
                <div class="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    :disabled="acting[s.id] !== null && acting[s.id] !== undefined"
                    class="rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                    @click="reject(s)"
                  >
                    <span v-if="acting[s.id] === 'reject'">Rejecting…</span>
                    <span v-else>Reject</span>
                  </button>
                  <button
                    type="button"
                    :disabled="acting[s.id] !== null && acting[s.id] !== undefined"
                    class="rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-success-foreground hover:bg-success/90"
                    @click="accept(s)"
                  >
                    <span v-if="acting[s.id] === 'accept'">Accepting…</span>
                    <span v-else>Accept</span>
                  </button>
                </div>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <!-- Manual-create modal — Phase 4 Operations primitive -->
      <UiModal
        :open="createModal"
        title="Add suggestion (manual)"
        subtitle="Inserts a suggestion with model_provider='manual'. Use to test the accept/reject + dispatch flow without waiting for the worker."
        width="lg"
        @update:open="createModal = $event"
      >
        <div class="space-y-3">
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">Kind</span>
            <select
              v-model="createForm.kind"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            >
              <option value="listing.description_enrichment">listing.description_enrichment</option>
              <option value="listing.duplicate_review_assist">listing.duplicate_review_assist</option>
              <option value="inquiry.summarisation">inquiry.summarisation</option>
              <option value="document_draft.field_autofill">document_draft.field_autofill</option>
              <option value="moderation.first_pass">moderation.first_pass</option>
            </select>
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Target kind</span>
              <input
                v-model="createForm.target_kind"
                type="text"
                maxlength="40"
                list="target-kind-suggestions"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
              <datalist id="target-kind-suggestions">
                <option value="listing" />
                <option value="inquiry" />
                <option value="document_draft" />
                <option value="listing_duplicate" />
                <option value="profile_verification" />
              </datalist>
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Target id</span>
              <input
                v-model="createForm.target_id"
                type="text"
                maxlength="64"
                placeholder="bigint or uuid as text"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
          </div>
          <label class="block">
            <span class="block text-xs font-medium text-muted-foreground">
              Suggested payload (JSON object)
            </span>
            <textarea
              v-model="createForm.payload_json"
              rows="6"
              class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Confidence (0 - 1)</span>
              <input
                v-model.number="createForm.confidence"
                type="number"
                min="0"
                max="1"
                step="0.05"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Prompt version (optional)</span>
              <input
                v-model="createForm.prompt_version"
                type="text"
                maxlength="40"
                placeholder="e.g. listing.desc.v1"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
          </div>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="createModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="creatingSuggestion"
              class="btn-primary disabled:opacity-60"
              @click="createSuggestion"
            >
              <span v-if="creatingSuggestion">Creating…</span>
              <span v-else>Create suggestion</span>
            </button>
          </div>
        </template>
      </UiModal>
    </template>
  </div>
</template>
