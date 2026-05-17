<script setup lang="ts">
/**
 * Admin tab: manage outbound webhook subscriptions.
 *
 * CRUD over /api/admin/webhook-subscriptions/* — list, create, edit,
 * enable/disable, delete. Per-row "deliveries" expander shows the
 * recent delivery log so admins can debug a flapping partner without
 * leaving the page.
 *
 * Signing-secret reveal: the secret is returned on creation and
 * surfaced ONCE in a one-time copy banner, then never shown again
 * (we don't ship the secret in subsequent list responses either —
 * the existing GET returns it, but the UI deliberately doesn't
 * render it after the create flow).
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Subscription = {
  id: string
  display_name: string
  url: string
  source_id: number | null
  event_kinds: string[]
  enabled: boolean
  consecutive_failures: number
  last_delivery_at: string | null
  last_delivery_status: number | null
  notes: string | null
  signing_secret?: string
  created_at: string
  updated_at: string
}

type Delivery = {
  id: string
  event_kind: string
  http_status: number | null
  error_message: string | null
  response_excerpt: string | null
  duration_ms: number | null
  attempted_at: string
  delivery_chain_id: string | null
}

type RetryRow = {
  id: string
  event_kind: string
  attempt_number: number
  next_attempt_at: string
  last_status: number | null
  last_error: string | null
  enqueued_at: string
}

// Source of truth for what's subscribable. Mirrored from the
// KNOWN_KINDS array in server/api/admin/webhook-subscriptions/index.post.ts.
// New event kinds added there should also be added here.
const KNOWN_KINDS = [
  'inquiry.received',
  'listing.created',
  'listing.updated',
  'listing.archived',
  'listing.ingested',
  'verification.approved',
  'verification.rejected',
] as const

const subscriptions = ref<Subscription[]>([])
const loading = ref(true)
const submitting = ref<Record<string, boolean>>({})
const expandedDeliveries = ref<Record<string, Delivery[] | null>>({})
const expandedRetryQueue = ref<Record<string, RetryRow[] | null>>({})
const expandedNotice = ref<Record<string, string>>({})

// Create-form state. Inline (collapsed by default) so the table is
// what the admin sees first.
const showCreateForm = ref(false)
const createForm = ref({
  display_name: '',
  url: '',
  event_kinds: [] as string[],
  notes: '',
})
const createError = ref<string | null>(null)

// One-shot secret banner. Populated only after a successful create;
// cleared when the admin dismisses or creates another.
const newSecret = ref<{ id: string; display_name: string; secret: string } | null>(null)

// Edit state — at most one row in edit mode at a time.
const editingId = ref<string | null>(null)
const editForm = ref({
  display_name: '',
  url: '',
  event_kinds: [] as string[],
  notes: '',
})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Subscription[] }>(
      '/api/admin/webhook-subscriptions',
    )
    subscriptions.value = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load subscriptions',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

function urlHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function formatTs(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function statusClass(s: Subscription): string {
  if (!s.enabled) return 'bg-muted text-foreground'
  if (s.consecutive_failures >= 5) return 'bg-destructive/15 text-destructive'
  if (s.consecutive_failures > 0) return 'bg-warning/15 text-warning'
  if (s.last_delivery_status && s.last_delivery_status >= 200 && s.last_delivery_status < 300) {
    return 'bg-success/15 text-success'
  }
  return 'bg-primary/15 text-primary'
}

function statusLabel(s: Subscription): string {
  if (!s.enabled) return 'Disabled'
  if (s.consecutive_failures >= 5) return `Failing (${s.consecutive_failures}×)`
  if (s.consecutive_failures > 0) return `Recovering (${s.consecutive_failures} fail)`
  if (s.last_delivery_status) return `OK ${s.last_delivery_status}`
  return 'No deliveries yet'
}

async function copyToClipboard(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast({ title: `${what} copied`, icon: 'success' })
  } catch {
    showToast({ title: 'Copy failed — select and Ctrl+C manually', icon: 'warning' })
  }
}

// ---- Create ----

async function submitCreate() {
  createError.value = null
  if (!createForm.value.display_name.trim()) {
    createError.value = 'Display name is required.'
    return
  }
  if (!/^https:\/\//.test(createForm.value.url.trim())) {
    createError.value = 'URL must start with https://'
    return
  }
  submitting.value['__create'] = true
  try {
    const created = await $fetch<Subscription>('/api/admin/webhook-subscriptions', {
      method: 'POST',
      body: {
        display_name: createForm.value.display_name.trim(),
        url: createForm.value.url.trim(),
        event_kinds: createForm.value.event_kinds,
        notes: createForm.value.notes.trim() || null,
      },
    })
    subscriptions.value = [created, ...subscriptions.value]
    if (created.signing_secret) {
      newSecret.value = {
        id: created.id,
        display_name: created.display_name,
        secret: created.signing_secret,
      }
    }
    // Reset form.
    createForm.value = { display_name: '', url: '', event_kinds: [], notes: '' }
    showCreateForm.value = false
  } catch (err: any) {
    createError.value =
      err?.statusMessage || err?.message || 'Failed to create subscription'
  } finally {
    delete submitting.value['__create']
  }
}

function cancelCreate() {
  showCreateForm.value = false
  createForm.value = { display_name: '', url: '', event_kinds: [], notes: '' }
  createError.value = null
}

// ---- Edit ----

function startEdit(s: Subscription) {
  editingId.value = s.id
  editForm.value = {
    display_name: s.display_name,
    url: s.url,
    event_kinds: [...s.event_kinds],
    notes: s.notes ?? '',
  }
}

function cancelEdit() {
  editingId.value = null
}

async function submitEdit(id: string) {
  submitting.value[id] = true
  try {
    const updated = await $fetch<Subscription>(`/api/admin/webhook-subscriptions/${id}`, {
      method: 'PATCH',
      body: {
        display_name: editForm.value.display_name.trim(),
        url: editForm.value.url.trim(),
        event_kinds: editForm.value.event_kinds,
        notes: editForm.value.notes.trim() || null,
      },
    })
    const idx = subscriptions.value.findIndex((s) => s.id === id)
    if (idx >= 0) subscriptions.value[idx] = { ...subscriptions.value[idx], ...updated }
    editingId.value = null
    showToast({ title: 'Subscription updated', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to update',
      icon: 'error',
    })
  } finally {
    delete submitting.value[id]
  }
}

// ---- Toggle / Delete ----

async function toggleEnabled(s: Subscription) {
  submitting.value[s.id] = true
  const prev = s.enabled
  // Optimistic flip.
  s.enabled = !prev
  try {
    await $fetch(`/api/admin/webhook-subscriptions/${s.id}`, {
      method: 'PATCH',
      body: { enabled: !prev },
    })
    if (!prev) {
      // Re-enabled: server clears consecutive_failures. Reflect that.
      s.consecutive_failures = 0
    }
    showToast({
      title: !prev ? 'Subscription enabled' : 'Subscription disabled',
      icon: 'success',
    })
  } catch (err: any) {
    s.enabled = prev
    showToast({
      title: err?.statusMessage || err?.message || 'Toggle failed',
      icon: 'error',
    })
  } finally {
    delete submitting.value[s.id]
  }
}

async function replayChain(s: Subscription, chain: { chainId: string; attempts: Delivery[] }) {
  const sample = chain.attempts[0]
  if (!sample) return
  // Legacy / pre-chain rows have a synthetic key — guard against
  // sending the synthetic id back to the server which expects a real
  // uuid. The button's `disabled` already covers this; double-check.
  if (chain.chainId.startsWith('legacy:')) {
    showToast({
      title: 'This delivery predates retry chaining and cannot be replayed.',
      icon: 'warning',
    })
    return
  }
  if (
    !confirm(
      `Re-fire ${sample.event_kind} to "${s.display_name}" using the payload from ${formatTs(sample.attempted_at)}?\n\n` +
        `A new attempt chain is created — the partner sees this as a fresh delivery. They may want an idempotency key on (event_kind, payload) to dedupe with the original.`,
    )
  ) {
    return
  }
  submitting.value[s.id] = true
  try {
    const res = await $fetch<{
      replayed: boolean
      outcome: string
      new_chain_id: string
    }>(`/api/admin/webhook-subscriptions/${s.id}/replay`, {
      method: 'POST',
      body: { chain_id: chain.chainId },
    })
    showToast({
      title:
        res.outcome === 'ok'
          ? 'Replay delivered'
          : res.outcome === 'enqueued'
            ? 'Replay accepted; partner returned a transient error — retrying.'
            : `Replay attempted (${res.outcome})`,
      icon: res.outcome === 'ok' ? 'success' : 'warning',
    })
    // Refresh the deliveries list so the new chain shows up.
    if (expandedDeliveries.value[s.id] !== undefined) {
      expandedDeliveries.value[s.id] = null
      try {
        const d = await $fetch<{ data: Delivery[] }>(
          `/api/admin/webhook-subscriptions/${s.id}/deliveries`,
          { query: { limit: 20 } },
        )
        expandedDeliveries.value[s.id] = d.data ?? []
      } catch {
        // Refresh failed — the in-memory list is now empty; user
        // can click View deliveries again.
        delete expandedDeliveries.value[s.id]
      }
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Replay failed',
      icon: 'error',
    })
  } finally {
    delete submitting.value[s.id]
  }
}

async function rotateSecret(s: Subscription) {
  if (
    !confirm(
      `Rotate the signing secret for "${s.display_name}"?\n\n` +
        `The current secret stops working immediately. The partner needs the new secret to verify the HMAC signature on subsequent deliveries — copy it from the banner before navigating away.`,
    )
  ) {
    return
  }
  submitting.value[s.id] = true
  try {
    const res = await $fetch<{ subscription_id: string; signing_secret: string }>(
      `/api/admin/webhook-subscriptions/${s.id}/rotate-secret`,
      { method: 'POST' },
    )
    // Reuse the same one-shot banner the create flow uses. The admin
    // copies, then dismisses.
    newSecret.value = {
      id: s.id,
      display_name: s.display_name,
      secret: res.signing_secret,
    }
    // Server resets consecutive_failures during rotation.
    s.consecutive_failures = 0
    showToast({ title: 'Signing secret rotated', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Rotation failed',
      icon: 'error',
    })
  } finally {
    delete submitting.value[s.id]
  }
}

async function deleteSubscription(s: Subscription) {
  if (
    !confirm(
      `Delete subscription "${s.display_name}"? This also removes its delivery history (CASCADE). Disable it instead if you want to preserve the audit trail.`,
    )
  ) {
    return
  }
  submitting.value[s.id] = true
  try {
    await $fetch(`/api/admin/webhook-subscriptions/${s.id}`, { method: 'DELETE' })
    subscriptions.value = subscriptions.value.filter((x) => x.id !== s.id)
    delete expandedDeliveries.value[s.id]
    delete expandedNotice.value[s.id]
    showToast({ title: 'Subscription deleted', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Delete failed',
      icon: 'error',
    })
  } finally {
    delete submitting.value[s.id]
  }
}

// ---- Deliveries expander ----

async function toggleDeliveries(s: Subscription) {
  if (expandedDeliveries.value[s.id]) {
    delete expandedDeliveries.value[s.id]
    return
  }
  expandedDeliveries.value[s.id] = null // loading
  try {
    const res = await $fetch<{ data: Delivery[] }>(
      `/api/admin/webhook-subscriptions/${s.id}/deliveries`,
      { query: { limit: 20 } },
    )
    expandedDeliveries.value[s.id] = res.data ?? []
  } catch (err: any) {
    expandedNotice.value[s.id] =
      err?.statusMessage || err?.message || 'Failed to load deliveries'
    expandedDeliveries.value[s.id] = []
  }
}

function deliveryStatusLabel(d: Delivery): string {
  if (d.http_status) return String(d.http_status)
  if (d.error_message?.toLowerCase().includes('timeout')) return 'timeout'
  return 'error'
}
function deliveryStatusClass(d: Delivery): string {
  if (d.http_status && d.http_status >= 200 && d.http_status < 300) return 'text-success'
  if (d.http_status && d.http_status >= 400) return 'text-destructive'
  return 'text-warning'
}

// Group deliveries by chain so retries thread under their original
// event. Chains are ordered by their MOST RECENT attempt's
// attempted_at desc so an actively-retrying event surfaces at top.
// Within a chain, attempts are ordered ASC (1, 2, 3, ...) so the
// reader sees the timeline forward.
type Chain = {
  chainId: string
  attempts: Delivery[]
  // Outcome describes the chain's terminal state:
  //   'delivered' — at least one 2xx
  //   'failing'   — most recent attempt failed; chain may still be
  //                 retrying (queue panel shows that)
  outcome: 'delivered' | 'failing'
}
function chainOutcome(attempts: Delivery[]): 'delivered' | 'failing' {
  // Attempts in chain order (asc) — last entry is most recent.
  const last = attempts[attempts.length - 1]
  if (last && last.http_status && last.http_status >= 200 && last.http_status < 300) {
    return 'delivered'
  }
  // If any attempt succeeded, the chain delivered (success ends the
  // chain). The latest-was-failure case must mean the chain is either
  // still retrying or terminally failed.
  const anyOk = attempts.some(
    (a) => a.http_status && a.http_status >= 200 && a.http_status < 300,
  )
  return anyOk ? 'delivered' : 'failing'
}
function groupDeliveries(rows: Delivery[]): Chain[] {
  // The endpoint returns rows ordered by attempted_at DESC (most
  // recent first). For threading we need ASC within a chain, so we
  // collect then reverse at chain level.
  const byChain = new Map<string, Delivery[]>()
  // Treat a NULL delivery_chain_id (legacy / pre-migration rows) as a
  // chain-of-one keyed off the row id, so they still render — just
  // never threaded. Same render path either way.
  for (const r of rows) {
    const key = r.delivery_chain_id || `legacy:${r.id}`
    const list = byChain.get(key) ?? []
    list.push(r)
    byChain.set(key, list)
  }
  const chains: Chain[] = []
  for (const [chainId, attempts] of byChain) {
    const sortedAsc = [...attempts].sort(
      (a, b) =>
        new Date(a.attempted_at).getTime() - new Date(b.attempted_at).getTime(),
    )
    chains.push({
      chainId,
      attempts: sortedAsc,
      outcome: chainOutcome(sortedAsc),
    })
  }
  // Order chains by their most-recent attempt desc.
  chains.sort((a, b) => {
    const aT = new Date(a.attempts[a.attempts.length - 1]!.attempted_at).getTime()
    const bT = new Date(b.attempts[b.attempts.length - 1]!.attempted_at).getTime()
    return bT - aT
  })
  return chains
}

async function toggleRetryQueue(s: Subscription) {
  if (expandedRetryQueue.value[s.id]) {
    delete expandedRetryQueue.value[s.id]
    return
  }
  expandedRetryQueue.value[s.id] = null // loading
  try {
    const res = await $fetch<{ data: RetryRow[] }>(
      `/api/admin/webhook-subscriptions/${s.id}/retry-queue`,
      { query: { limit: 50 } },
    )
    expandedRetryQueue.value[s.id] = res.data ?? []
  } catch (err: any) {
    expandedNotice.value[s.id] =
      err?.statusMessage || err?.message || 'Failed to load retry queue'
    expandedRetryQueue.value[s.id] = []
  }
}

// Human-readable "fires in N min/h" for the next_attempt_at column.
// Past timestamps mean the worker hasn't fired yet — the row is due
// any moment. We surface "due now" rather than negative durations.
function untilLabel(iso: string): string {
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target)) return ''
  const diffMs = target - Date.now()
  if (diffMs <= 0) return 'due now'
  const diffSec = Math.round(diffMs / 1000)
  if (diffSec < 60) return `in ${diffSec}s`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `in ${diffMin}m`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `in ${diffHr}h`
  return `in ${Math.round(diffHr / 24)}d`
}

const isEmpty = computed(() => !loading.value && subscriptions.value.length === 0)

// Live auto-refresh during retry chains.
//
// We poll only when there's something dynamic to watch — keeps the
// /admin/webhooks page idle when everything's healthy. Triggers:
//   1. Any enabled subscription with consecutive_failures > 0 (the
//      partner is mid-recovery; deliveries should land + the count
//      reset within the next minute or so)
//   2. Any expanded retry-queue panel with rows (operator opened the
//      drawer specifically to watch the queue drain)
//
// Tick refreshes the subs list silently + any open expanders. Skips
// the list refresh while the operator is mid-edit so input focus is
// preserved.
const autoRefreshActive = computed(() => {
  if (subscriptions.value.some((s) => s.enabled && s.consecutive_failures > 0)) return true
  for (const id of Object.keys(expandedRetryQueue.value)) {
    const rows = expandedRetryQueue.value[id]
    if (Array.isArray(rows) && rows.length > 0) return true
  }
  return false
})

let pollTimer: ReturnType<typeof setInterval> | null = null

async function pollTick() {
  // Subs-list refresh — silent. Skip when editing so we don't blow
  // away the operator's input.
  if (editingId.value === null) {
    try {
      const res = await $fetch<{ data: Subscription[] }>(
        '/api/admin/webhook-subscriptions',
      )
      subscriptions.value = res.data ?? []
    } catch {
      // Swallow — manual Refresh remains available; we don't want a
      // toast popping every 30s during a transient network blip.
    }
  }

  // Refresh open retry-queue panels.
  for (const id of Object.keys(expandedRetryQueue.value)) {
    if (expandedRetryQueue.value[id] === null) continue // currently loading
    try {
      const res = await $fetch<{ data: RetryRow[] }>(
        `/api/admin/webhook-subscriptions/${id}/retry-queue`,
        { query: { limit: 50 } },
      )
      expandedRetryQueue.value[id] = res.data ?? []
    } catch {
      // Swallow.
    }
  }

  // Refresh open deliveries panels.
  for (const id of Object.keys(expandedDeliveries.value)) {
    if (expandedDeliveries.value[id] === null) continue
    try {
      const res = await $fetch<{ data: Delivery[] }>(
        `/api/admin/webhook-subscriptions/${id}/deliveries`,
        { query: { limit: 20 } },
      )
      expandedDeliveries.value[id] = res.data ?? []
    } catch {
      // Swallow.
    }
  }
}

watch(
  autoRefreshActive,
  (active) => {
    if (active && !pollTimer) {
      pollTimer = setInterval(pollTick, 30_000)
    } else if (!active && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  },
)

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})

onMounted(load)
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold text-foreground">Webhook subscriptions</h2>
        <p class="text-sm text-muted-foreground">
          Outbound HTTPS endpoints that receive signed events. HMAC-SHA256
          signature in <code class="rounded bg-muted px-1">webhook-signature</code>;
          replay window 5min via <code class="rounded bg-muted px-1">webhook-timestamp</code>.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="autoRefreshActive"
          class="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary ring-1 ring-primary/30"
          title="Active retries detected — polling subscriptions and open panels every 30s. Stops automatically when chains clear."
        >
          <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          Auto-refreshing
        </span>
        <button
          type="button"
          class="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
          :disabled="loading"
          @click="load"
        >
          Refresh
        </button>
        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary/90"
          @click="showCreateForm = !showCreateForm"
        >
          {{ showCreateForm ? 'Cancel' : 'New subscription' }}
        </button>
      </div>
    </div>

    <!-- One-shot secret banner. Shown until dismissed. -->
    <div
      v-if="newSecret"
      class="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-4"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-warning">
            Save this signing secret now — it won't be shown again.
          </p>
          <p class="mt-1 text-xs text-warning">
            Subscription <strong>{{ newSecret.display_name }}</strong> uses this
            secret to verify the HMAC signature on every webhook delivery.
            Re-creating the subscription is the only way to recover access.
          </p>
          <code class="mt-2 block break-all rounded bg-card px-2 py-1.5 font-mono text-xs text-warning ring-1 ring-warning/30">
            {{ newSecret.secret }}
          </code>
        </div>
        <div class="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            class="rounded-md bg-warning px-3 py-1.5 text-xs font-semibold text-warning-foreground hover:bg-warning/90"
            @click="copyToClipboard(newSecret.secret, 'Signing secret')"
          >
            Copy secret
          </button>
          <button
            type="button"
            class="rounded-md border border-warning/40 bg-card px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/10"
            @click="newSecret = null"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>

    <!-- Create form -->
    <div
      v-if="showCreateForm"
      class="mb-4 rounded-xl border border-border bg-background p-4"
    >
      <p class="mb-3 text-sm font-semibold text-foreground">New subscription</p>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="block text-xs font-semibold text-foreground">Display name</span>
          <input
            v-model="createForm.display_name"
            type="text"
            maxlength="160"
            class="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            placeholder="e.g. Partner CRM (production)"
          />
        </label>
        <label class="block">
          <span class="block text-xs font-semibold text-foreground">URL (HTTPS)</span>
          <input
            v-model="createForm.url"
            type="url"
            class="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            placeholder="https://partner.example.com/hooks/hi"
          />
        </label>
      </div>
      <div class="mt-3">
        <p class="mb-1 text-xs font-semibold text-foreground">Event kinds</p>
        <p class="mb-2 text-xs text-muted-foreground">
          Leave all unchecked to receive every event. Pick specific kinds to
          narrow the firehose.
        </p>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="kind in KNOWN_KINDS"
            :key="kind"
            class="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs"
          >
            <input
              v-model="createForm.event_kinds"
              type="checkbox"
              :value="kind"
              class="h-3.5 w-3.5 accent-blue-500"
            />
            <code class="font-mono">{{ kind }}</code>
          </label>
        </div>
      </div>
      <label class="mt-3 block">
        <span class="block text-xs font-semibold text-foreground">Notes (optional)</span>
        <textarea
          v-model="createForm.notes"
          rows="2"
          maxlength="4000"
          class="mt-1 w-full rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          placeholder="Owner / contact / why this subscription exists"
        />
      </label>
      <p
        v-if="createError"
        class="mt-2 text-xs text-destructive"
      >
        {{ createError }}
      </p>
      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
          :disabled="!!submitting['__create']"
          @click="submitCreate"
        >
          Create
        </button>
        <button
          type="button"
          class="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
          @click="cancelCreate"
        >
          Cancel
        </button>
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-if="loading"
      class="rounded-xl border border-border bg-background p-5 text-center text-sm text-muted-foreground"
    >
      Loading…
    </div>
    <div
      v-else-if="isEmpty"
      class="rounded-xl border border-border bg-background p-5 text-center text-sm text-muted-foreground"
    >
      No webhook subscriptions yet.
      Click <strong>New subscription</strong> to create one.
    </div>

    <!-- Subscription list -->
    <ul v-else class="space-y-3">
      <li
        v-for="s in subscriptions"
        :key="s.id"
        class="rounded-xl border border-border bg-background p-4"
      >
        <!-- Header row: name + host + status pill + actions -->
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-foreground">
              {{ s.display_name }}
            </p>
            <p class="mt-0.5 truncate text-xs text-muted-foreground">
              {{ urlHost(s.url) }}
            </p>
          </div>
          <span
            :class="['inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', statusClass(s)]"
          >
            {{ statusLabel(s) }}
          </span>
          <div class="flex flex-wrap gap-1">
            <button
              type="button"
              class="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              :disabled="!!submitting[s.id]"
              @click="toggleEnabled(s)"
            >
              {{ s.enabled ? 'Disable' : 'Enable' }}
            </button>
            <button
              type="button"
              class="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
              @click="startEdit(s)"
            >
              Edit
            </button>
            <button
              type="button"
              class="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
              @click="toggleDeliveries(s)"
            >
              {{ expandedDeliveries[s.id] !== undefined ? 'Hide' : 'View' }} deliveries
            </button>
            <button
              type="button"
              class="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
              @click="toggleRetryQueue(s)"
            >
              {{ expandedRetryQueue[s.id] !== undefined ? 'Hide' : 'View' }} pending
            </button>
            <button
              type="button"
              class="rounded-md border border-warning/30 bg-card px-2.5 py-1 text-xs font-semibold text-warning hover:bg-warning/10 disabled:opacity-50"
              :disabled="!!submitting[s.id]"
              @click="rotateSecret(s)"
            >
              Rotate secret
            </button>
            <button
              type="button"
              class="rounded-md border border-destructive/30 bg-card px-2.5 py-1 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
              :disabled="!!submitting[s.id]"
              @click="deleteSubscription(s)"
            >
              Delete
            </button>
          </div>
        </div>

        <!-- Event-kind chips + last delivery + notes -->
        <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span
            v-if="s.event_kinds.length === 0"
            class="rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
          >
            All events
          </span>
          <code
            v-for="k in s.event_kinds"
            :key="k"
            class="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-primary"
          >
            {{ k }}
          </code>
          <span class="ml-auto text-muted-foreground">
            Last: {{ formatTs(s.last_delivery_at) }}
          </span>
        </div>
        <p
          v-if="s.notes"
          class="mt-2 rounded-md bg-muted/50 p-2 text-xs text-foreground"
        >
          {{ s.notes }}
        </p>

        <!-- Edit form (inline replaces the row contents below the header). -->
        <div
          v-if="editingId === s.id"
          class="mt-3 rounded-lg border border-primary/30 bg-primary/10 p-3"
        >
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="block text-xs font-semibold text-foreground">Display name</span>
              <input
                v-model="editForm.display_name"
                type="text"
                maxlength="160"
                class="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              />
            </label>
            <label class="block">
              <span class="block text-xs font-semibold text-foreground">URL (HTTPS)</span>
              <input
                v-model="editForm.url"
                type="url"
                class="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              />
            </label>
          </div>
          <div class="mt-3">
            <p class="mb-1 text-xs font-semibold text-foreground">Event kinds</p>
            <div class="flex flex-wrap gap-2">
              <label
                v-for="kind in KNOWN_KINDS"
                :key="kind"
                class="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs"
              >
                <input
                  v-model="editForm.event_kinds"
                  type="checkbox"
                  :value="kind"
                  class="h-3.5 w-3.5 accent-blue-500"
                />
                <code class="font-mono">{{ kind }}</code>
              </label>
            </div>
          </div>
          <label class="mt-3 block">
            <span class="block text-xs font-semibold text-foreground">Notes</span>
            <textarea
              v-model="editForm.notes"
              rows="2"
              maxlength="4000"
              class="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <div class="mt-3 flex gap-2">
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
              :disabled="!!submitting[s.id]"
              @click="submitEdit(s.id)"
            >
              Save
            </button>
            <button
              type="button"
              class="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
              @click="cancelEdit"
            >
              Cancel
            </button>
          </div>
        </div>

        <!-- Pending retries expander — what the worker will replay
             on upcoming cron ticks. Sourced from webhook_retry_queue
             (mutable; rows leave on success / exhaustion). -->
        <div
          v-if="expandedRetryQueue[s.id] !== undefined"
          class="mt-3 border-t border-border pt-3"
        >
          <p class="mb-2 text-xs font-semibold text-foreground">Pending retries</p>
          <div
            v-if="expandedRetryQueue[s.id] === null"
            class="text-xs text-muted-foreground"
          >
            Loading…
          </div>
          <div
            v-else-if="expandedRetryQueue[s.id]?.length === 0"
            class="text-xs text-muted-foreground"
          >
            No pending retries — the queue is clear for this subscription.
          </div>
          <table v-else class="w-full text-xs">
            <thead>
              <tr class="text-left text-muted-foreground">
                <th class="py-1 font-semibold">Event</th>
                <th class="py-1 font-semibold">Attempt</th>
                <th class="py-1 font-semibold">Next</th>
                <th class="py-1 font-semibold">Last status</th>
                <th class="py-1 font-semibold">Last error</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in expandedRetryQueue[s.id]!"
                :key="r.id"
                class="border-t border-border"
              >
                <td class="py-1.5">
                  <code class="font-mono text-foreground">{{ r.event_kind }}</code>
                </td>
                <td class="py-1.5 text-foreground">
                  #{{ r.attempt_number + 1 }}
                </td>
                <td class="py-1.5 text-foreground" :title="formatTs(r.next_attempt_at)">
                  {{ untilLabel(r.next_attempt_at) }}
                </td>
                <td class="py-1.5 text-foreground">
                  <span v-if="r.last_status">{{ r.last_status }}</span>
                  <span v-else class="text-muted-foreground/70">—</span>
                </td>
                <td class="py-1.5 truncate max-w-[260px] text-destructive">
                  {{ r.last_error || '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Deliveries expander -->
        <div v-if="expandedDeliveries[s.id] !== undefined" class="mt-3 border-t border-border pt-3">
          <p class="mb-2 text-xs font-semibold text-foreground">Recent deliveries</p>
          <p
            v-if="expandedNotice[s.id]"
            class="text-xs text-destructive"
          >
            {{ expandedNotice[s.id] }}
          </p>
          <div
            v-if="expandedDeliveries[s.id] === null"
            class="text-xs text-muted-foreground"
          >
            Loading…
          </div>
          <div
            v-else-if="expandedDeliveries[s.id]?.length === 0"
            class="text-xs text-muted-foreground"
          >
            No deliveries logged yet.
          </div>
          <!-- Threaded chains: each event groups its retry attempts.
               A chain with one attempt looks the same as the old flat
               row; a multi-attempt chain shows "Attempt N of M" with
               the chain's terminal outcome chip. -->
          <ul v-else class="space-y-2">
            <li
              v-for="chain in groupDeliveries(expandedDeliveries[s.id]!)"
              :key="chain.chainId"
              class="rounded-md border border-border bg-muted/40 p-2"
            >
              <div class="flex items-center gap-2">
                <code class="font-mono text-xs text-foreground">
                  {{ chain.attempts[0]?.event_kind }}
                </code>
                <span
                  v-if="chain.attempts.length > 1"
                  :class="[
                    'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    chain.outcome === 'delivered'
                      ? 'bg-success/15 text-success'
                      : 'bg-destructive/15 text-destructive',
                  ]"
                >
                  {{ chain.outcome === 'delivered' ? 'Delivered' : 'Failing' }}
                  · {{ chain.attempts.length }} attempts
                </span>
                <span
                  v-else-if="chain.attempts[0]"
                  :class="[
                    'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    chain.outcome === 'delivered'
                      ? 'bg-success/15 text-success'
                      : 'bg-warning/15 text-warning',
                  ]"
                >
                  {{ chain.outcome === 'delivered' ? 'Delivered' : 'Pending' }}
                </span>
                <span class="ml-auto text-[10px] text-muted-foreground">
                  {{ formatTs(chain.attempts[chain.attempts.length - 1]!.attempted_at) }}
                </span>
                <button
                  type="button"
                  class="rounded-md border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  :disabled="!!submitting[s.id] || chain.chainId.startsWith('legacy:')"
                  :title="chain.chainId.startsWith('legacy:') ? 'Pre-chaining row, replay not supported' : 'Re-fire this event to the partner'"
                  @click="replayChain(s, chain)"
                >
                  Replay
                </button>
              </div>
              <table class="mt-2 w-full text-xs">
                <tbody>
                  <tr
                    v-for="(d, idx) in chain.attempts"
                    :key="d.id"
                    class="border-t border-border"
                  >
                    <td class="py-1 pr-2 text-muted-foreground whitespace-nowrap" style="width: 90px">
                      Attempt #{{ idx + 1 }}
                    </td>
                    <td class="py-1 pr-2 text-foreground whitespace-nowrap">
                      {{ formatTs(d.attempted_at) }}
                    </td>
                    <td class="py-1 pr-2">
                      <span :class="['font-semibold', deliveryStatusClass(d)]">
                        {{ deliveryStatusLabel(d) }}
                      </span>
                    </td>
                    <td class="py-1 pr-2 text-foreground whitespace-nowrap">
                      {{ d.duration_ms != null ? `${d.duration_ms}ms` : '—' }}
                    </td>
                    <td class="py-1 truncate max-w-[260px] text-destructive">
                      {{ d.error_message || '' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </li>
          </ul>
        </div>
      </li>
    </ul>
  </div>
</template>
