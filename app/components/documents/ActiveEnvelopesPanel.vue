<script setup lang="ts">
/**
 * "Envelopes you sent" — top-of-list strip on the documents hub.
 * Surfaces in-flight DocuSign envelopes (sent / delivered) that the
 * current user kicked off, with per-recipient signing progress.
 *
 * Self-hides when nothing's in flight. Click-through opens the
 * draft on the Export tab where the full per-draft envelope panel
 * lives.
 */
import { onMounted, ref } from 'vue'
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
  draft_id: string
  envelope_id: string
  status: 'sent' | 'delivered'
  recipients: Recipient[]
  sent_at: string
  webhook_received_at: string | null
  draft: { id: string; title: string | null; doc_type_key: string | null } | null
}

const items = ref<Envelope[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Envelope[] }>('/api/docusign-envelopes/mine')
    items.value = res.data ?? []
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
defineExpose({ refresh: load })

function signedCount(env: Envelope): number {
  return env.recipients.filter((r) => !!r.signed_at).length
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
</script>

<template>
  <section
    v-if="!loading && items.length > 0"
    class="rounded-lg border border-primary/20 bg-primary/5 p-4"
  >
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <h2 class="text-card-title">
        Envelopes you sent
        <UiBadge variant="primary" size="xs" class="ml-1">
          {{ items.length }} in-flight
        </UiBadge>
      </h2>
      <p class="text-[11px] text-muted-foreground">
        Statuses update from DocuSign Connect webhooks; refresh if a
        signer says they signed but the row hasn't moved yet.
      </p>
    </header>

    <ul class="space-y-1.5">
      <li
        v-for="e in items"
        :key="e.id"
        class="rounded-md border border-border bg-card px-3 py-2"
      >
        <NuxtLink
          v-if="e.draft"
          :to="`/document-drafts/${e.draft.id}#export`"
          class="block focus-ring rounded"
        >
          <div class="flex flex-wrap items-baseline gap-2 text-xs">
            <UiBadge :variant="e.status === 'delivered' ? 'primary' : 'warning'" size="xs">
              {{ e.status }}
            </UiBadge>
            <span class="min-w-0 flex-1 truncate font-semibold text-foreground">
              {{ e.draft.title || e.draft.doc_type_key || `Draft ${e.draft.id.slice(0, 8)}` }}
            </span>
            <span class="text-[10px] tabular-nums text-muted-foreground">
              {{ signedCount(e) }}/{{ e.recipients.length }} signed
            </span>
            <span class="ml-auto text-[10px] tabular-nums text-muted-foreground">
              sent {{ relativeTime(e.sent_at) }}
            </span>
          </div>
          <p class="mt-1 truncate text-[10px] text-muted-foreground">
            {{ e.recipients.map(r => r.name || r.email).join(' · ') }}
          </p>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>
