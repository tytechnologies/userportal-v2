<script setup lang="ts">
/**
 * Per-listing shares panel — read + lifecycle controls.
 *
 * Lives on the listing detail page; reads /api/listings/:id/shares
 * (which returns shares with both recipient + sharer profile blocks
 * joined). Each row exposes:
 *   - status pill (pending / accepted / revoked)
 *   - recipient identity
 *   - capability chips (from listing_shares.permissions JSONB)
 *   - revoke button (owner-only)
 *
 * Pairs with `<ShareListingModal>` already shipped in this session;
 * the parent listing-detail page owns both the panel and the modal.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type ShareRow = {
  id: string
  listing_id: number
  shared_with_user_id: string
  shared_by_user_id: string | null
  share_role: 'co_broker' | 'viewer'
  status: 'pending' | 'accepted' | 'revoked'
  permissions: Record<string, boolean>
  message: string | null
  expires_at: string | null
  created_at: string
  recipient: {
    id: string
    full_name: string | null
    email: string | null
    avatar_url: string | null
  } | null
  sharer: {
    id: string
    full_name: string | null
    email: string | null
    avatar_url: string | null
  } | null
}

const props = defineProps<{
  listingId: number
  /**
   * Hint to show owner-only controls. The server still RLS-gates,
   * so this is purely UX (avoid showing a Revoke button to a
   * non-owner who'd hit 403 on click).
   */
  isOwner?: boolean
}>()

const emit = defineEmits<{
  changed: []   // raised after revoke so the parent can refresh the
                // collaborators list, etc.
}>()

const shares = ref<ShareRow[]>([])
const loading = ref(true)
const submitting = ref<Record<string, boolean>>({})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: ShareRow[] }>(
      `/api/listings/${props.listingId}/shares`,
    )
    shares.value = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load shares',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

watch(() => props.listingId, load)
onMounted(load)

async function revoke(s: ShareRow) {
  if (!confirm(
    `Revoke ${s.recipient?.full_name || 'this share'}? They lose access immediately. `
    + `Re-sharing later is allowed.`,
  )) return
  submitting.value[s.id] = true
  try {
    await $fetch(
      `/api/listings/${props.listingId}/shares/${s.id}`,
      {
        method: 'PATCH',
        body: { status: 'revoked' },
      },
    )
    showToast({ title: 'Share revoked', icon: 'success' })
    emit('changed')
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Revoke failed',
      icon: 'error',
    })
  } finally {
    delete submitting.value[s.id]
  }
}

const isEmpty = computed(() => !loading.value && shares.value.length === 0)

function formatTs(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusClass(status: ShareRow['status']): string {
  if (status === 'accepted') return 'bg-success/15 text-success'
  if (status === 'pending') return 'bg-warning/15 text-warning'
  return 'bg-muted text-foreground'
}

function activeCaps(s: ShareRow): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(s.permissions || {})) {
    if (v === true) out.push(k)
  }
  // Legacy rows: empty permissions {} → fall back to share_role.
  if (out.length === 0) {
    return s.share_role === 'co_broker'
      ? ['view_listing', 'view_inquiries', 'edit_listing']
      : ['view_listing']
  }
  return out
}

function capLabel(key: string): string {
  return key.replace(/_/g, ' ')
}

function isExpired(s: ShareRow): boolean {
  if (!s.expires_at) return false
  return new Date(s.expires_at).getTime() <= Date.now()
}

defineExpose({ refresh: load })
</script>

<template>
  <section
    class="rounded-xl border border-border bg-background p-4"
    aria-label="Listing shares"
  >
    <div class="mb-3 flex items-center justify-between">
      <p class="text-sm font-semibold text-foreground">
        Shared with
      </p>
      <button
        type="button"
        class="text-xs font-semibold text-muted-foreground hover:underline"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <div
      v-if="loading && shares.length === 0"
      class="rounded-md border border-border bg-muted/50 p-4 text-xs text-muted-foreground"
    >
      Loading…
    </div>
    <div
      v-else-if="isEmpty"
      class="rounded-md border border-dashed border-border bg-muted/50 p-4 text-xs text-muted-foreground"
    >
      Not shared with anyone yet.
    </div>

    <ul v-else class="space-y-2">
      <li
        v-for="s in shares"
        :key="s.id"
        class="rounded-md border border-border bg-muted/40 p-3"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <p class="text-sm font-semibold text-foreground">
            {{ s.recipient?.full_name || s.recipient?.email || 'Unknown agent' }}
          </p>
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            :class="statusClass(s.status)"
          >
            {{ s.status }}
          </span>
          <span
            v-if="isExpired(s)"
            class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground"
          >
            expired
          </span>
          <p class="ml-auto text-xs text-muted-foreground">
            Shared {{ formatTs(s.created_at) }}
            <template v-if="s.expires_at">
              · expires {{ formatTs(s.expires_at) }}
            </template>
          </p>
        </div>

        <div class="mt-2 flex flex-wrap gap-1">
          <code
            v-for="cap in activeCaps(s)"
            :key="cap"
            class="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
          >
            {{ capLabel(cap) }}
          </code>
        </div>

        <p
          v-if="s.message"
          class="mt-2 text-xs text-foreground"
        >
          “{{ s.message }}”
        </p>

        <div
          v-if="isOwner && s.status !== 'revoked'"
          class="mt-2 flex justify-end"
        >
          <button
            type="button"
            class="rounded-md border border-destructive/30 bg-card px-2.5 py-1 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
            :disabled="!!submitting[s.id]"
            @click="revoke(s)"
          >
            Revoke
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
