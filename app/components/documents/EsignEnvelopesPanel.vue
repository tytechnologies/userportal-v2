<script setup lang="ts">
/**
 * eSign envelopes panel — lists every DocuSign envelope sent for
 * this draft, with the latest status reported via webhook. Surfaces
 * the per-recipient breakdown so brokers can see who's signed and
 * who's still pending.
 *
 * No actions in v1 — voiding an envelope is a future phase. The
 * panel is read-only beyond a "Refresh" button to re-poll while
 * waiting on webhook updates.
 */
import { computed, onMounted, ref, watch } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'

type Recipient = {
  placeholder_id: string
  name: string
  email: string
  role: string
  status: string
  signed_at: string | null
}
type Envelope = {
  id: string
  envelope_id: string
  status: 'created' | 'sent' | 'delivered' | 'completed' | 'declined' | 'voided' | 'expired'
  recipients: Recipient[]
  version_id: string | null
  sent_at: string
  completed_at: string | null
  voided_at: string | null
  webhook_received_at: string | null
}

const props = defineProps<{
  draftId: string
}>()

const envelopes = ref<Envelope[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Envelope[] }>(`/api/document-drafts/${props.draftId}/esign`)
    envelopes.value = res.data ?? []
  } catch {
    envelopes.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.draftId, load)

defineExpose({ refresh: load })

type StatusVariant = 'success' | 'destructive' | 'warning' | 'primary' | 'neutral'
function statusVariant(s: Envelope['status']): StatusVariant {
  switch (s) {
    case 'completed':           return 'success'
    case 'declined':            return 'destructive'
    case 'voided':              return 'destructive'
    case 'expired':             return 'destructive'
    case 'sent':
    case 'delivered':           return 'primary'
    case 'created':             return 'warning'
    default:                    return 'neutral'
  }
}

function recipientStatusVariant(s: string): StatusVariant {
  const v = (s || '').toLowerCase()
  if (v === 'completed' || v === 'signed') return 'success'
  if (v === 'declined' || v === 'autoresponded') return 'destructive'
  if (v === 'sent' || v === 'delivered') return 'primary'
  return 'neutral'
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const isEmpty = computed(() => !loading.value && envelopes.value.length === 0)
</script>

<template>
  <section v-if="!isEmpty || loading" class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-card-title">eSign envelopes</h3>
        <p class="mt-0.5 text-meta">
          DocuSign Connect updates land here. Refresh if you sent
          something and don't see it within 30s.
        </p>
      </div>
      <button
        type="button"
        class="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent focus-ring disabled:opacity-50"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </header>

    <p
      v-if="loading && envelopes.length === 0"
      class="text-xs text-muted-foreground"
    >
      Loading envelopes…
    </p>

    <ul v-else class="space-y-2">
      <li
        v-for="e in envelopes"
        :key="e.id"
        class="rounded-md border border-border bg-card p-3"
      >
        <header class="flex flex-wrap items-baseline gap-2 text-xs">
          <UiBadge :variant="statusVariant(e.status)" size="xs">{{ e.status }}</UiBadge>
          <span class="font-mono text-[10px] text-muted-foreground">{{ e.envelope_id.slice(0, 8) }}…</span>
          <span class="text-muted-foreground">
            sent {{ relativeTime(e.sent_at) }}
            <span v-if="e.webhook_received_at"> · last update {{ relativeTime(e.webhook_received_at) }}</span>
          </span>
        </header>
        <ul class="mt-2 space-y-1">
          <li
            v-for="r in e.recipients"
            :key="r.placeholder_id + r.email"
            class="flex flex-wrap items-baseline gap-2 text-xs"
          >
            <UiBadge :variant="recipientStatusVariant(r.status)" size="xs">{{ r.status || 'sent' }}</UiBadge>
            <span class="font-semibold text-foreground">{{ r.name || r.email }}</span>
            <span class="text-muted-foreground">
              {{ r.email }} · {{ r.role.replace('_', ' ') }}
            </span>
            <span
              v-if="r.signed_at"
              class="ml-auto text-[10px] tabular-nums text-success"
            >
              signed {{ relativeTime(r.signed_at) }}
            </span>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
