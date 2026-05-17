<script setup lang="ts">
/**
 * "Approvals waiting on you" — top-of-list strip on the documents
 * hub for users who are the reviewer on one or more pending
 * approvals. Self-hides when the queue is empty.
 *
 * Each row deep-links to the parent draft on its Review tab, where
 * the broker can see the version, the comment, and the inline
 * Approve/Reject buttons.
 */
import { onMounted, ref } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'

type Pending = {
  id: string
  draft_id: string
  comment: string | null
  requested_at: string
  requester: { id: string; full_name: string | null; avatar_url: string | null } | null
  draft: { id: string; title: string | null; doc_type_key: string | null; status: string; updated_at: string } | null
}

const items = ref<Pending[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Pending[] }>('/api/document-approvals/mine')
    items.value = res.data ?? []
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
defineExpose({ refresh: load })

function relativeTime(iso: string): string {
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
  <!-- Self-hide when the reviewer queue is empty so the page stays
       calm on quiet days. Loading state kept short — if the request
       takes >300ms it's already too slow to gate the rest of the
       page on; we just render nothing for the brief loading window. -->
  <section
    v-if="!loading && items.length > 0"
    class="rounded-lg border border-warning/30 bg-warning/5 p-4"
  >
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <h2 class="text-card-title">
        Approvals waiting on you
        <UiBadge variant="warning" size="xs" class="ml-1">
          {{ items.length }}
        </UiBadge>
      </h2>
      <p class="text-[11px] text-muted-foreground">
        Reviewers see this strip until every pending request is decided.
      </p>
    </header>

    <ul class="space-y-1.5">
      <li
        v-for="a in items"
        :key="a.id"
        class="rounded-md border border-border bg-card px-3 py-2"
      >
        <NuxtLink
          v-if="a.draft"
          :to="`/document-drafts/${a.draft.id}#review`"
          class="block focus-ring rounded"
        >
          <div class="flex flex-wrap items-baseline gap-2 text-xs">
            <UiBadge variant="warning" size="xs">pending</UiBadge>
            <span class="min-w-0 flex-1 truncate font-semibold text-foreground">
              {{ a.draft.title || a.draft.doc_type_key || `Draft ${a.draft.id.slice(0, 8)}` }}
            </span>
            <span class="text-[10px] text-muted-foreground">
              from {{ a.requester?.full_name || 'someone' }}
            </span>
            <span class="ml-auto text-[10px] tabular-nums text-muted-foreground">
              requested {{ relativeTime(a.requested_at) }}
            </span>
          </div>
          <p
            v-if="a.comment"
            class="mt-1 line-clamp-2 text-[11px] text-foreground/80"
          >
            "{{ a.comment }}"
          </p>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>
