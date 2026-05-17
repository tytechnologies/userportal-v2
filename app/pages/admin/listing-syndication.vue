<script setup lang="ts">
/**
 * /admin/listing-syndication — outbound feed targets.
 *
 * Phase A admin surface for the syndication backend shipped in
 * 20260508000008. Lists targets with status badge + last-run summary.
 * Per-row Run/Edit/Archive actions. Detail drawer shows the recent
 * run history. Override management UI is deferred (operators use
 * SQL or the future Phase B endpoints).
 */

import { ref, computed, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { hasPermission } from '~/composables/useAuth'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Listing Syndication | Admin' })

type Status = 'active' | 'paused' | 'archived'
type DeliveryMode = 'pull' | 'push'
type FeedFormat = 'json' | 'xml' | 'csv' | 'rss'
type RunKind = 'cron' | 'manual' | 'pull'
type RunStatus = 'running' | 'completed' | 'failed'

type PushAuthKind = 'none' | 'bearer' | 'hmac' | 'basic'

type Target = {
  id: string
  slug: string
  display_name: string
  feed_format: FeedFormat
  delivery_mode: DeliveryMode
  push_endpoint_url: string | null
  push_auth_kind: PushAuthKind | null
  push_secret_vault_key: string | null
  include_filters: Record<string, unknown>
  max_listings_per_run: number
  refresh_cron: string | null
  status: Status
  last_run_at: string | null
  last_run_listings: number | null
  last_run_status: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

type Run = {
  id: string
  run_kind: RunKind
  status: RunStatus
  started_at: string
  completed_at: string | null
  listings_included: number
  listings_excluded: number
  bytes_emitted: number | null
  errors: Array<{ message?: string; stage?: string }>
  push_response_status: number | null
  pull_origin: { ip?: string; user_agent?: string; referer?: string } | null
}

type Override = {
  id: string
  target_id: string
  listing_id: number
  override_kind: 'force_include' | 'force_exclude'
  reason: string | null
  created_at: string
}

const router = useRouter()
const isChecking = ref(true)
const allowed = ref(false)

const targets = ref<Target[]>([])
const loading = ref(false)
const statusFilter = ref<Status | 'all'>('active')

// Per-row busy flags.
const runningRow = ref<Record<string, boolean>>({})
const archivingRow = ref<Record<string, boolean>>({})
const pushingRow = ref<Record<string, boolean>>({})

// Detail drawer state.
const detailId = ref<string | null>(null)
const detailRuns = ref<Run[]>([])
const loadingDetail = ref(false)
const lastRunBody = ref<string | null>(null)
const detailOverrides = ref<Override[]>([])
const addOverrideForm = reactive({
  listing_id: '' as string | number,
  override_kind: 'force_include' as 'force_include' | 'force_exclude',
  reason: '',
})
const addingOverride = ref(false)

const detailTarget = computed(() =>
  targets.value.find((t) => t.id === detailId.value) ?? null,
)

// Create modal.
const createModal = ref(false)
const createForm = reactive({
  slug: '',
  display_name: '',
  feed_format: 'json' as FeedFormat,
  delivery_mode: 'pull' as DeliveryMode,
  push_endpoint_url: '',
  include_filters_json: '{\n  "status": "active"\n}',
  max_listings_per_run: 1000,
  notes: '',
})
const creating = ref(false)

// Edit modal (re-uses create-style form but for an existing target).
const editModal = ref(false)
const editTargetId = ref<string | null>(null)
const editForm = reactive({
  display_name: '',
  feed_format: 'json' as FeedFormat,
  delivery_mode: 'pull' as DeliveryMode,
  push_endpoint_url: '',
  push_auth_kind: 'none' as PushAuthKind,
  push_secret_vault_key: '',
  include_filters_json: '{}',
  max_listings_per_run: 1000,
  refresh_cron: '',
  notes: '',
  status: 'active' as Status,
})
const savingEdit = ref(false)

const filtered = computed(() => {
  if (statusFilter.value === 'all') return targets.value
  return targets.value.filter((t) => t.status === statusFilter.value)
})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ items: Target[] }>(
      '/api/admin/listing-syndication/targets',
      { query: { limit: 200 } },
    )
    targets.value = res.items ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not load targets',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function runNow(t: Target) {
  runningRow.value[t.id] = true
  lastRunBody.value = null
  try {
    const res = await $fetch<{
      run_id: string
      listings_included: number
      forced_in: number
      forced_out: number
      bytes_emitted: number
      body_preview: string
    }>(`/api/admin/listing-syndication/targets/${t.id}/run-now`, {
      method: 'POST',
    })
    showToast({
      title: `Run done: ${res.listings_included} listings (${(res.bytes_emitted / 1024).toFixed(1)} KB)`,
    })
    if (detailId.value === t.id) {
      lastRunBody.value = res.body_preview
      await loadDetailRuns(t.id)
    }
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Run failed', icon: 'error' })
  } finally {
    runningRow.value[t.id] = false
  }
}

async function pushNow(t: Target) {
  if (t.delivery_mode !== 'push') {
    showToast({ title: 'Target is in pull mode — partner polls the URL', icon: 'warning' })
    return
  }
  pushingRow.value[t.id] = true
  try {
    const res = await $fetch<{
      run_id: string
      listings_included: number
      bytes_emitted: number
      push: {
        ok: boolean
        status_code: number | null
        body_excerpt: string | null
        duration_ms: number
        error?: string
      }
    }>(`/api/admin/listing-syndication/targets/${t.id}/push-now`, {
      method: 'POST',
    })
    if (res.push.ok) {
      showToast({
        title: `Pushed ${res.listings_included} listings (${res.push.status_code} in ${res.push.duration_ms}ms)`,
      })
    } else {
      showToast({
        title: `Push failed: ${res.push.error ?? `HTTP ${res.push.status_code}`}`,
        icon: 'error',
      })
    }
    if (detailId.value === t.id) await loadDetailRuns(t.id)
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Push failed', icon: 'error' })
  } finally {
    pushingRow.value[t.id] = false
  }
}

async function archive(t: Target) {
  if (!confirm(`Archive target "${t.display_name}" (slug: ${t.slug})? The public /syndication/${t.slug} URL will return 404. Past runs are kept.`)) return
  archivingRow.value[t.id] = true
  try {
    await $fetch(`/api/admin/listing-syndication/targets/${t.id}`, {
      method: 'DELETE',
    })
    showToast({ title: 'Target archived' })
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Archive failed', icon: 'error' })
  } finally {
    archivingRow.value[t.id] = false
  }
}

async function openDetail(t: Target) {
  detailId.value = t.id
  lastRunBody.value = null
  await Promise.all([loadDetailRuns(t.id), loadDetailOverrides(t.id)])
}

async function loadDetailRuns(id: string) {
  loadingDetail.value = true
  try {
    const res = await $fetch<{ items: Run[] }>(
      `/api/admin/listing-syndication/targets/${id}/runs`,
      { query: { limit: 50 } },
    )
    detailRuns.value = res.items ?? []
  } catch {
    detailRuns.value = []
  } finally {
    loadingDetail.value = false
  }
}

async function loadDetailOverrides(id: string) {
  try {
    const res = await $fetch<{ items: Override[] }>(
      `/api/admin/listing-syndication/targets/${id}/overrides`,
      { query: { limit: 200 } },
    )
    detailOverrides.value = res.items ?? []
  } catch {
    detailOverrides.value = []
  }
}

async function addOverride() {
  if (!detailId.value) return
  const lid = Number(addOverrideForm.listing_id)
  if (!Number.isFinite(lid) || lid <= 0) {
    showToast({ title: 'Listing id must be a positive integer', icon: 'warning' })
    return
  }
  addingOverride.value = true
  try {
    await $fetch('/api/admin/listing-syndication/overrides', {
      method: 'POST',
      body: {
        target_id: detailId.value,
        listing_id: lid,
        override_kind: addOverrideForm.override_kind,
        reason: addOverrideForm.reason.trim() || null,
      },
    })
    showToast({ title: 'Override added' })
    addOverrideForm.listing_id = ''
    addOverrideForm.reason = ''
    await loadDetailOverrides(detailId.value)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not add override',
      icon: 'error',
    })
  } finally {
    addingOverride.value = false
  }
}

async function removeOverride(o: Override) {
  if (!confirm(`Remove ${o.override_kind} override for listing #${o.listing_id}?`)) return
  try {
    await $fetch(`/api/admin/listing-syndication/overrides/${o.id}`, {
      method: 'DELETE',
    })
    showToast({ title: 'Override removed' })
    if (detailId.value) await loadDetailOverrides(detailId.value)
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || 'Could not remove override',
      icon: 'error',
    })
  }
}

function openCreate() {
  createForm.slug = ''
  createForm.display_name = ''
  createForm.feed_format = 'json'
  createForm.delivery_mode = 'pull'
  createForm.push_endpoint_url = ''
  createForm.include_filters_json = '{\n  "status": "active"\n}'
  createForm.max_listings_per_run = 1000
  createForm.notes = ''
  createModal.value = true
}

async function createTarget() {
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(createForm.slug)) {
    showToast({ title: 'Slug must be a-z 0-9 _ - (2-40 chars, leading alphanumeric)', icon: 'warning' })
    return
  }
  if (!createForm.display_name.trim()) {
    showToast({ title: 'Display name is required', icon: 'warning' })
    return
  }
  let filters: Record<string, unknown>
  try {
    filters = JSON.parse(createForm.include_filters_json)
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      throw new Error('filters must be an object')
    }
  } catch (err: any) {
    showToast({
      title: `Invalid filters JSON: ${err?.message ?? 'parse failed'}`,
      icon: 'warning',
    })
    return
  }
  if (createForm.delivery_mode === 'push' && !createForm.push_endpoint_url.trim()) {
    showToast({ title: 'push_endpoint_url is required for push mode', icon: 'warning' })
    return
  }
  creating.value = true
  try {
    await $fetch('/api/admin/listing-syndication/targets', {
      method: 'POST',
      body: {
        slug: createForm.slug.trim(),
        display_name: createForm.display_name.trim(),
        feed_format: createForm.feed_format,
        delivery_mode: createForm.delivery_mode,
        push_endpoint_url: createForm.push_endpoint_url.trim() || null,
        include_filters: filters,
        max_listings_per_run: createForm.max_listings_per_run,
        notes: createForm.notes.trim() || null,
      },
    })
    showToast({ title: 'Target created' })
    createModal.value = false
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Create failed', icon: 'error' })
  } finally {
    creating.value = false
  }
}

function openEdit(t: Target) {
  editTargetId.value = t.id
  editForm.display_name = t.display_name
  editForm.feed_format = t.feed_format
  editForm.delivery_mode = t.delivery_mode
  editForm.push_endpoint_url = t.push_endpoint_url ?? ''
  editForm.push_auth_kind = (t.push_auth_kind ?? 'none') as PushAuthKind
  editForm.push_secret_vault_key = t.push_secret_vault_key ?? ''
  editForm.include_filters_json = JSON.stringify(t.include_filters ?? {}, null, 2)
  editForm.max_listings_per_run = t.max_listings_per_run
  editForm.refresh_cron = t.refresh_cron ?? ''
  editForm.notes = t.notes ?? ''
  editForm.status = t.status
  editModal.value = true
}

async function saveEdit() {
  if (!editTargetId.value) return
  if (!editForm.display_name.trim()) {
    showToast({ title: 'Display name is required', icon: 'warning' })
    return
  }
  let filters: Record<string, unknown>
  try {
    filters = JSON.parse(editForm.include_filters_json)
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      throw new Error('filters must be an object')
    }
  } catch (err: any) {
    showToast({
      title: `Invalid filters JSON: ${err?.message ?? 'parse failed'}`,
      icon: 'warning',
    })
    return
  }
  savingEdit.value = true
  try {
    await $fetch(`/api/admin/listing-syndication/targets/${editTargetId.value}`, {
      method: 'PATCH',
      body: {
        display_name: editForm.display_name.trim(),
        feed_format: editForm.feed_format,
        delivery_mode: editForm.delivery_mode,
        push_endpoint_url: editForm.push_endpoint_url.trim() || null,
        push_auth_kind: editForm.push_auth_kind === 'none' ? null : editForm.push_auth_kind,
        push_secret_vault_key: editForm.push_secret_vault_key.trim() || null,
        include_filters: filters,
        max_listings_per_run: editForm.max_listings_per_run,
        refresh_cron: editForm.refresh_cron.trim() || null,
        notes: editForm.notes.trim() || null,
        status: editForm.status,
      },
    })
    showToast({ title: 'Target saved' })
    editModal.value = false
    await load()
  } catch (err: any) {
    showToast({ title: err?.statusMessage || 'Save failed', icon: 'error' })
  } finally {
    savingEdit.value = false
  }
}

function statusClass(s: Status): string {
  if (s === 'active') return 'bg-success/15 text-success'
  if (s === 'paused') return 'bg-warning/15 text-warning'
  return 'bg-muted text-muted-foreground'
}

function runStatusClass(s: RunStatus): string {
  if (s === 'completed') return 'bg-success/15 text-success'
  if (s === 'failed') return 'bg-destructive/15 text-destructive'
  return 'bg-primary/15 text-primary'
}

function publicFeedUrl(t: Target): string {
  if (typeof window === 'undefined') return `/syndication/${t.slug}`
  return `${window.location.origin}/syndication/${t.slug}`
}

async function copyFeedUrl(t: Target) {
  try {
    await navigator.clipboard.writeText(publicFeedUrl(t))
    showToast({ title: 'Public feed URL copied' })
  } catch {
    showToast({ title: 'Copy failed — select the URL manually', icon: 'warning' })
  }
}

onMounted(async () => {
  const ok =
    (await hasPermission('syndication.manage')) ||
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
          <h1 class="text-page-title">Listing Syndication</h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Outbound feeds for partner portals (Lamudi-style PH portals,
            MLS partners, OLX). Pull targets are polled by the partner;
            push targets (phase B) get cron-driven POSTs from us.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="btn-primary focus-ring"
            @click="openCreate"
          >
            + Create target
          </button>
        </div>
      </header>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="opt in (['active', 'paused', 'archived', 'all'] as const)"
          :key="opt"
          type="button"
          :class="[
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
            statusFilter === opt
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
          ]"
          @click="statusFilter = opt"
        >
          <span class="capitalize">{{ opt }}</span>
        </button>
        <button
          type="button"
          class="ml-auto text-xs text-muted-foreground hover:underline"
          @click="load"
        >
          Refresh
        </button>
      </div>

      <!-- Targets list -->
      <section class="rounded-lg border border-border bg-card text-card-foreground">
        <div v-if="loading" class="p-5 text-center text-sm text-muted-foreground">
          Loading…
        </div>
        <div
          v-else-if="filtered.length === 0"
          class="p-5 text-center text-sm text-muted-foreground"
        >
          No targets in this view. Create one to start syndicating listings.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Target</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Mode</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
                <th class="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">Cap</th>
                <th class="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Last run</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr
                v-for="t in filtered"
                :key="t.id"
                class="hover:bg-accent/40 cursor-pointer"
                @click="openDetail(t)"
              >
                <td class="px-3 py-2">
                  <div class="font-medium text-foreground">{{ t.display_name }}</div>
                  <div class="font-mono text-[11px] text-muted-foreground">
                    /syndication/{{ t.slug }}
                  </div>
                </td>
                <td class="px-3 py-2 text-xs">
                  <span class="capitalize text-foreground">{{ t.delivery_mode }}</span>
                  <span class="text-muted-foreground"> · {{ t.feed_format }}</span>
                </td>
                <td class="px-3 py-2 text-xs">
                  <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', statusClass(t.status)]">
                    {{ t.status }}
                  </span>
                </td>
                <td class="px-3 py-2 text-right text-xs tabular-nums text-foreground">
                  {{ t.max_listings_per_run.toLocaleString() }}
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <span v-if="t.last_run_at">
                    {{ new Date(t.last_run_at).toLocaleString() }}
                    <span v-if="t.last_run_listings != null"> · {{ t.last_run_listings }} listings</span>
                  </span>
                  <span v-else>—</span>
                </td>
                <td class="px-3 py-2 text-right" @click.stop>
                  <div class="flex justify-end gap-3">
                    <button
                      type="button"
                      :disabled="runningRow[t.id]"
                      class="text-xs text-primary hover:underline disabled:opacity-60"
                      @click="runNow(t)"
                    >
                      <span v-if="runningRow[t.id]">Running…</span>
                      <span v-else>Run</span>
                    </button>
                    <button
                      v-if="t.delivery_mode === 'push'"
                      type="button"
                      :disabled="pushingRow[t.id]"
                      class="text-xs text-primary hover:underline disabled:opacity-60"
                      @click="pushNow(t)"
                      :title="`POST to ${t.push_endpoint_url ?? '(no endpoint)'} with the configured auth`"
                    >
                      <span v-if="pushingRow[t.id]">Pushing…</span>
                      <span v-else>Push</span>
                    </button>
                    <button
                      type="button"
                      class="text-xs text-primary hover:underline"
                      @click="openEdit(t)"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="text-xs text-muted-foreground hover:underline"
                      @click="copyFeedUrl(t)"
                    >
                      Copy URL
                    </button>
                    <button
                      v-if="t.status !== 'archived'"
                      type="button"
                      :disabled="archivingRow[t.id]"
                      class="text-xs text-destructive hover:underline disabled:opacity-60"
                      @click="archive(t)"
                    >
                      Archive
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Detail drawer -->
      <section
        v-if="detailTarget"
        class="rounded-lg border border-border bg-card p-5 text-card-foreground"
      >
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 class="text-base font-semibold text-foreground">
              {{ detailTarget.display_name }}
              <span class="text-xs font-normal text-muted-foreground">recent runs</span>
            </h2>
            <p class="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {{ publicFeedUrl(detailTarget) }}
            </p>
          </div>
          <button
            type="button"
            class="text-xs text-muted-foreground hover:underline"
            @click="detailId = null; lastRunBody = null"
          >
            Close
          </button>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="rounded-lg border border-border bg-muted/40 p-3">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Filters</div>
            <pre class="mt-1 max-h-32 overflow-auto font-mono text-[11px] text-foreground">{{ JSON.stringify(detailTarget.include_filters, null, 2) }}</pre>
          </div>
          <div class="rounded-lg border border-border bg-muted/40 p-3">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Mode</div>
            <p class="mt-1 text-sm text-foreground capitalize">{{ detailTarget.delivery_mode }}</p>
            <p
              v-if="detailTarget.push_endpoint_url"
              class="mt-0.5 break-all font-mono text-[11px] text-muted-foreground"
            >
              {{ detailTarget.push_endpoint_url }}
            </p>
            <p v-if="detailTarget.refresh_cron" class="mt-0.5 font-mono text-[11px] text-muted-foreground">
              cron: {{ detailTarget.refresh_cron }}
            </p>
          </div>
          <div class="rounded-lg border border-border bg-muted/40 p-3">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Caps</div>
            <p class="mt-1 text-sm tabular-nums text-foreground">
              {{ detailTarget.max_listings_per_run.toLocaleString() }} listings/run
            </p>
            <p
              v-if="detailTarget.notes"
              class="mt-2 border-t border-border pt-2 text-xs text-muted-foreground"
            >
              {{ detailTarget.notes }}
            </p>
          </div>
        </div>

        <!-- Per-listing overrides -->
        <div class="mt-4 border-t border-border pt-3">
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Overrides ({{ detailOverrides.length }})
          </h3>
          <p class="mb-2 text-[11px] text-muted-foreground">
            <code>force_include</code> overrides bypass target filters to add a listing.
            <code>force_exclude</code> overrides bypass filters to remove one.
            One override per (target, listing) — delete first to swap kind.
          </p>

          <ul v-if="detailOverrides.length > 0" class="mb-3 divide-y divide-border rounded-lg border border-border">
            <li
              v-for="o in detailOverrides"
              :key="o.id"
              class="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-xs text-foreground">listing #{{ o.listing_id }}</span>
                  <span
                    :class="[
                      'inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                      o.override_kind === 'force_include'
                        ? 'bg-success/15 text-success'
                        : 'bg-destructive/15 text-destructive',
                    ]"
                  >
                    {{ o.override_kind.replace('_', ' ') }}
                  </span>
                </div>
                <p v-if="o.reason" class="mt-0.5 text-[11px] text-muted-foreground">
                  {{ o.reason }}
                </p>
              </div>
              <button
                type="button"
                class="text-xs text-destructive hover:underline"
                @click="removeOverride(o)"
              >
                Remove
              </button>
            </li>
          </ul>

          <!-- Add-override form -->
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-[120px_180px_1fr_auto]">
            <input
              v-model="addOverrideForm.listing_id"
              type="number"
              min="1"
              placeholder="Listing #"
              class="rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
            />
            <select
              v-model="addOverrideForm.override_kind"
              class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
            >
              <option value="force_include">force_include</option>
              <option value="force_exclude">force_exclude</option>
            </select>
            <input
              v-model="addOverrideForm.reason"
              type="text"
              maxlength="500"
              placeholder="Reason (optional, audited)"
              class="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
            />
            <button
              type="button"
              :disabled="addingOverride"
              class="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              @click="addOverride"
            >
              <span v-if="addingOverride">Adding…</span>
              <span v-else>Add override</span>
            </button>
          </div>
        </div>

        <div class="mt-4 border-t border-border pt-3">
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent runs ({{ detailRuns.length }})
          </h3>
          <div v-if="loadingDetail" class="text-sm text-muted-foreground">Loading…</div>
          <div v-else-if="detailRuns.length === 0" class="text-sm text-muted-foreground">
            No runs recorded yet. Run-now generates one immediately.
          </div>
          <ul v-else class="divide-y divide-border">
            <li v-for="r in detailRuns" :key="r.id" class="py-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span :class="['inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase', runStatusClass(r.status)]">
                    {{ r.status }}
                  </span>
                  <span class="text-xs uppercase tracking-wide text-muted-foreground">
                    {{ r.run_kind }}
                  </span>
                  <span class="text-xs text-muted-foreground">
                    · {{ new Date(r.started_at).toLocaleString() }}
                  </span>
                </div>
                <div class="text-xs text-foreground">
                  <span class="tabular-nums">{{ r.listings_included }}</span>
                  listings
                  <span v-if="r.bytes_emitted != null" class="text-muted-foreground">
                    · {{ (r.bytes_emitted / 1024).toFixed(1) }} KB
                  </span>
                </div>
              </div>
              <p
                v-if="r.errors && r.errors.length > 0"
                class="mt-0.5 text-xs text-destructive"
              >
                {{ r.errors.map((e) => e.message ?? 'unknown').join(' · ') }}
              </p>
              <p
                v-else-if="r.run_kind === 'pull' && r.pull_origin"
                class="mt-0.5 font-mono text-[10px] text-muted-foreground"
              >
                pulled by {{ r.pull_origin.ip ?? '?' }}
                <span v-if="r.pull_origin.user_agent">
                  · {{ String(r.pull_origin.user_agent).slice(0, 80) }}
                </span>
              </p>
            </li>
          </ul>
        </div>

        <div v-if="lastRunBody" class="mt-4 border-t border-border pt-3">
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Last manual-run body preview
          </h3>
          <pre class="max-h-64 overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-[11px] text-foreground">{{ lastRunBody }}</pre>
        </div>
      </section>

      <!-- Create syndication target — Phase 5 Operations primitive -->
      <UiModal
        :open="createModal"
        title="Create syndication target"
        subtitle="JSON + XML feeds served at /syndication/<slug>. CSV / RSS + push delivery land in phase B+."
        width="lg"
        @update:open="createModal = $event"
      >
        <div class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Slug (URL path)</span>
                <input
                  v-model="createForm.slug"
                  type="text"
                  maxlength="40"
                  placeholder="lamudi"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
                <span class="mt-1 block text-[11px] text-muted-foreground">a-z 0-9 _ - (cannot change later)</span>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Display name</span>
                <input
                  v-model="createForm.display_name"
                  type="text"
                  maxlength="120"
                  placeholder="Lamudi PH"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Feed format</span>
                <select
                  v-model="createForm.feed_format"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                >
                  <option value="json">JSON (modern partners)</option>
                  <option value="xml">XML (RETS / Lamudi-style)</option>
                  <option value="csv">CSV (legacy / spreadsheet imports)</option>
                </select>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Delivery mode</span>
                <select
                  v-model="createForm.delivery_mode"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                >
                  <option value="pull">Pull (partner polls)</option>
                  <option value="push">Push (cron — phase B+)</option>
                </select>
              </label>
            </div>
            <label v-if="createForm.delivery_mode === 'push'" class="block">
              <span class="block text-xs font-medium text-muted-foreground">Partner endpoint URL</span>
              <input
                v-model="createForm.push_endpoint_url"
                type="url"
                maxlength="2048"
                placeholder="https://partner.example.com/listings"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">
                Include filters (JSON object)
              </span>
              <textarea
                v-model="createForm.include_filters_json"
                rows="6"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
              <span class="mt-1 block text-[11px] text-muted-foreground">
                Supported: status, property_type, city_id, min/max_sale_price,
                min/max_rent_price. Defaults to active listings only.
              </span>
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Max listings per run</span>
              <input
                v-model.number="createForm.max_listings_per_run"
                type="number"
                min="1"
                max="50000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Notes (optional)</span>
              <textarea
                v-model="createForm.notes"
                rows="2"
                maxlength="2000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
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
              :disabled="creating"
              class="btn-primary disabled:opacity-60"
              @click="createTarget"
            >
              <span v-if="creating">Creating…</span>
              <span v-else>Create</span>
            </button>
          </div>
        </template>
      </UiModal>

      <!-- Edit syndication target — Phase 5 Operations primitive -->
      <UiModal
        :open="editModal"
        title="Edit target"
        subtitle="Slug is intentionally not editable (it's the public URL contract). Re-create the target if the slug needs to change."
        width="lg"
        @update:open="editModal = $event"
      >
        <div class="space-y-3">
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Display name</span>
              <input
                v-model="editForm.display_name"
                type="text"
                maxlength="120"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <div class="grid grid-cols-3 gap-3">
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Status</span>
                <select
                  v-model="editForm.status"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                >
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="archived">archived</option>
                </select>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Feed format</span>
                <select
                  v-model="editForm.feed_format"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                >
                  <option value="json">json</option>
                  <option value="xml">xml</option>
                  <option value="csv">csv</option>
                </select>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Delivery mode</span>
                <select
                  v-model="editForm.delivery_mode"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                >
                  <option value="pull">pull</option>
                  <option value="push">push</option>
                </select>
              </label>
            </div>
            <template v-if="editForm.delivery_mode === 'push'">
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Partner endpoint URL</span>
                <input
                  v-model="editForm.push_endpoint_url"
                  type="url"
                  maxlength="2048"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
              <div class="grid grid-cols-2 gap-3">
                <label class="block">
                  <span class="block text-xs font-medium text-muted-foreground">Push auth</span>
                  <select
                    v-model="editForm.push_auth_kind"
                    class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                  >
                    <option value="none">none</option>
                    <option value="bearer">bearer</option>
                    <option value="hmac">hmac (sha256)</option>
                    <option value="basic">basic (user:pass in secret)</option>
                  </select>
                </label>
                <label v-if="editForm.push_auth_kind !== 'none'" class="block">
                  <span class="block text-xs font-medium text-muted-foreground">Secret env var name</span>
                  <input
                    v-model="editForm.push_secret_vault_key"
                    type="text"
                    maxlength="120"
                    placeholder="e.g. SYNDICATION_LAMUDI_SECRET"
                    class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                  />
                  <span class="mt-0.5 block text-[10px] text-muted-foreground">
                    Operator sets the actual secret as an env var with this name in AWS / Cloudflare. The secret never lives in the DB.
                  </span>
                </label>
              </div>
            </template>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Include filters (JSON object)</span>
              <textarea
                v-model="editForm.include_filters_json"
                rows="6"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Max listings per run</span>
                <input
                  v-model.number="editForm.max_listings_per_run"
                  type="number"
                  min="1"
                  max="50000"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-muted-foreground">Refresh cron (push, optional)</span>
                <input
                  v-model="editForm.refresh_cron"
                  type="text"
                  maxlength="64"
                  placeholder="0 * * * *"
                  class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
                />
              </label>
            </div>
            <label class="block">
              <span class="block text-xs font-medium text-muted-foreground">Notes</span>
              <textarea
                v-model="editForm.notes"
                rows="2"
                maxlength="2000"
                class="mt-1 block w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
              />
            </label>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn-secondary"
              @click="editModal = false"
            >
              Cancel
            </button>
            <button
              type="button"
              :disabled="savingEdit"
              class="btn-primary disabled:opacity-60"
              @click="saveEdit"
            >
              <span v-if="savingEdit">Saving…</span>
              <span v-else>Save</span>
            </button>
          </div>
        </template>
      </UiModal>
    </template>
  </div>
</template>
