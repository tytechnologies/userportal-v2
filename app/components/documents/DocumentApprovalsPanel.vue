<script setup lang="ts">
/**
 * Approvals panel for the draft detail page.
 *
 * Two halves:
 *   - "Request" composer: pick a reviewer (paste UUID for now;
 *     type-ahead picker ships in Phase 3 alongside the staff
 *     directory) + optional comment + optional version pin.
 *   - History list: every approval row, newest first, with status
 *     badge, requester, reviewer, comment, decided-at timestamp.
 *
 * Decisions are wired inline — the same row gets Approve/Reject
 * buttons when the current user is the reviewer of a pending row,
 * and a Withdraw button when the current user is the requester.
 *
 * Shape note: the user-id picker is intentionally crude in v1. Most
 * brokerages have a known small set of reviewers; the type-ahead
 * polish is Phase 3 work.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import UiBadge from '~/components/ui/UiBadge.vue'

type Approval = {
  id: string
  draft_id: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  comment: string | null
  version_id: string | null
  requested_at: string
  decided_at: string | null
  reviewer_user_id: string
  requested_by: string | null
  reviewer:  { id: string; full_name: string | null; avatar_url: string | null } | null
  requester: { id: string; full_name: string | null; avatar_url: string | null } | null
}

const props = defineProps<{
  draftId: string
}>()

const approvals = ref<Approval[]>([])
const loading = ref(false)
const requesting = ref(false)
const decidingId = ref<string | null>(null)

// Reviewer is picked through a type-ahead against /api/staff/search.
// The id-paste field is gone — `pickedReviewer` holds the resolved
// profile object once selected.
type StaffMatch = {
  id: string
  full_name: string | null
  email: string | null
  avatar_url: string | null
}
const newRequest = ref<{ reviewer: string; comment: string }>({
  reviewer: '',  // search query input
  comment: '',
})
const pickedReviewer = ref<StaffMatch | null>(null)
const matches = ref<StaffMatch[]>([])
const searching = ref(false)
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

async function runSearch() {
  const q = newRequest.value.reviewer.trim()
  if (q.length < 2) { matches.value = []; return }
  searching.value = true
  const seq = ++searchSeq
  try {
    const res = await $fetch<{ data: StaffMatch[] }>('/api/staff/search', {
      query: { q, limit: 8 },
    })
    if (seq !== searchSeq) return
    matches.value = res.data ?? []
  } catch {
    if (seq === searchSeq) matches.value = []
  } finally {
    if (seq === searchSeq) searching.value = false
  }
}

watch(() => newRequest.value.reviewer, (v) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!v.trim()) { matches.value = []; pickedReviewer.value = null; return }
  if (pickedReviewer.value && v !== (pickedReviewer.value.full_name || pickedReviewer.value.email || '')) {
    pickedReviewer.value = null
  }
  searchTimer = setTimeout(runSearch, 220)
})

function pickMatch(m: StaffMatch) {
  pickedReviewer.value = m
  newRequest.value.reviewer = m.full_name || m.email || m.id
  matches.value = []
}

// Resolve current user id once so the UI knows which actions to render.
const supabaseUser = useSupabaseUser()
const myId = computed(() => supabaseUser.value?.id || null)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Approval[] }>(`/api/document-drafts/${props.draftId}/approvals`)
    approvals.value = res.data ?? []
  } catch {
    approvals.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.draftId, load)

async function request() {
  if (requesting.value) return
  if (!pickedReviewer.value) {
    showToast({ title: 'Pick a reviewer from the dropdown.', icon: 'error' })
    return
  }
  requesting.value = true
  try {
    await $fetch(`/api/document-drafts/${props.draftId}/approvals`, {
      method: 'POST',
      body: {
        reviewer_user_id: pickedReviewer.value.id,
        comment: newRequest.value.comment.trim() || undefined,
      },
    })
    newRequest.value = { reviewer: '', comment: '' }
    pickedReviewer.value = null
    matches.value = []
    await load()
    showToast({ title: 'Approval requested', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not request approval',
      icon: 'error',
    })
  } finally {
    requesting.value = false
  }
}

async function decide(a: Approval, status: 'approved' | 'rejected' | 'withdrawn') {
  if (decidingId.value) return
  decidingId.value = a.id
  try {
    await $fetch(`/api/document-drafts/${props.draftId}/approvals/${a.id}`, {
      method: 'PATCH',
      body: { status },
    })
    await load()
    showToast({ title: `Marked ${status}`, icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Decision failed',
      icon: 'error',
    })
  } finally {
    decidingId.value = null
  }
}

type StatusVariant = 'success' | 'destructive' | 'warning' | 'neutral'
function statusVariant(s: Approval['status']): StatusVariant {
  switch (s) {
    case 'approved':  return 'success'
    case 'rejected':  return 'destructive'
    case 'pending':   return 'warning'
    case 'withdrawn': return 'neutral'
  }
}

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

const pendingCount = computed(() => approvals.value.filter((a) => a.status === 'pending').length)
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-card-title">
          Approvals
          <UiBadge
            v-if="pendingCount > 0"
            variant="warning"
            size="xs"
            class="ml-1"
          >
            {{ pendingCount }} pending
          </UiBadge>
        </h3>
        <p class="mt-0.5 text-meta">
          Each row shows what was reviewed, by whom, and when. Approved
          decisions are immutable — re-request to revisit.
        </p>
      </div>
    </header>

    <!-- Request composer with type-ahead reviewer picker -->
    <form
      class="mb-3 grid gap-2 border-b border-border pb-3 sm:grid-cols-[1fr_auto] sm:items-start"
      @submit.prevent="request"
    >
      <div class="relative">
        <input
          v-model="newRequest.reviewer"
          type="text"
          maxlength="120"
          placeholder="Find reviewer by name or email…"
          autocomplete="off"
          class="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
        />
        <div
          v-if="matches.length > 0 && !pickedReviewer"
          class="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border-strong bg-card shadow-lg"
        >
          <button
            v-for="m in matches"
            :key="m.id"
            type="button"
            class="block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-accent focus-ring last:border-b-0"
            @click="pickMatch(m)"
          >
            <span class="font-semibold text-foreground">
              {{ m.full_name || m.email || m.id.slice(0, 8) }}
            </span>
            <span v-if="m.email" class="ml-1 text-muted-foreground">{{ m.email }}</span>
          </button>
        </div>
        <p
          v-else-if="searching"
          class="mt-1 text-[11px] text-muted-foreground"
        >
          Searching…
        </p>
        <p
          v-else-if="newRequest.reviewer.trim().length >= 2 && matches.length === 0 && !pickedReviewer"
          class="mt-1 text-[11px] text-muted-foreground"
        >
          No matches. Try a different name or email.
        </p>
      </div>
      <button
        type="submit"
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
        :disabled="!pickedReviewer || requesting"
      >
        {{ requesting ? 'Requesting…' : 'Request approval' }}
      </button>
      <textarea
        v-model="newRequest.comment"
        rows="2"
        maxlength="2000"
        placeholder="Optional comment for the reviewer."
        class="sm:col-span-2 rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
      />
    </form>

    <!-- History -->
    <p
      v-if="loading"
      class="text-xs text-muted-foreground"
    >
      Loading approvals…
    </p>
    <p
      v-else-if="approvals.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      No approval history yet.
    </p>

    <ul v-else class="space-y-2">
      <li
        v-for="a in approvals"
        :key="a.id"
        class="rounded-md border border-border bg-card p-3"
      >
        <header class="flex flex-wrap items-baseline gap-2 text-xs">
          <UiBadge :variant="statusVariant(a.status)" size="xs">{{ a.status }}</UiBadge>
          <span class="font-semibold text-foreground">
            {{ a.reviewer?.full_name || 'Reviewer' }}
          </span>
          <span class="text-muted-foreground">
            (requested by {{ a.requester?.full_name || 'someone' }} · {{ relativeTime(a.requested_at) }})
          </span>
          <span
            v-if="a.decided_at"
            class="ml-auto text-[11px] text-muted-foreground tabular-nums"
          >
            decided {{ relativeTime(a.decided_at) }}
          </span>
        </header>
        <p
          v-if="a.comment"
          class="mt-1 text-xs text-foreground/80"
        >
          {{ a.comment }}
        </p>

        <!-- Inline decision buttons. Reviewer sees Approve+Reject;
             requester sees Withdraw; everyone else sees nothing. -->
        <div
          v-if="a.status === 'pending'"
          class="mt-2 flex flex-wrap gap-1.5"
        >
          <template v-if="myId === a.reviewer_user_id">
            <button
              type="button"
              class="rounded-md bg-success px-2.5 py-1 text-[11px] font-semibold text-success-foreground hover:bg-success/90 focus-ring disabled:opacity-50"
              :disabled="decidingId === a.id"
              @click="decide(a, 'approved')"
            >
              Approve
            </button>
            <button
              type="button"
              class="rounded-md bg-destructive px-2.5 py-1 text-[11px] font-semibold text-destructive-foreground hover:bg-destructive/90 focus-ring disabled:opacity-50"
              :disabled="decidingId === a.id"
              @click="decide(a, 'rejected')"
            >
              Reject
            </button>
          </template>
          <button
            v-if="myId === a.requested_by"
            type="button"
            class="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent focus-ring disabled:opacity-50"
            :disabled="decidingId === a.id"
            @click="decide(a, 'withdrawn')"
          >
            Withdraw
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
