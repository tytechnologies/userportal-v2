<script setup lang="ts">
/**
 * Admin duplicate-candidate review queue.
 *
 * Reads /api/admin/duplicates. Two-step admin action:
 *   1. Verdict (PATCH /:id) — confirm / distinct / dismiss / reopen
 *   2. Merge (POST /:id/merge) — only after confirm, picks which
 *      listing to keep (canonical) and which to soft-delete + flag
 *      duplicate_of_id. Idempotent and audit-logged.
 *
 * The UI never auto-merges. The two-step keeps merge intent
 * explicit + reversible-by-DB before the destructive step runs.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Listing = {
  id: number
  title: string | null
  sale_price: number | null
  rent_price: number | null
  floor_area: number | null
  bedrooms: number | null
  bathrooms: number | null
  building_id: number | null
  created_by: string | null
  created_at: string
  is_online: boolean
  deleted_at: string | null
  broker: { id: string; full_name: string | null } | null
}

type Candidate = {
  id: string
  a_listing_id: number
  b_listing_id: number
  confidence: number
  signals: Record<string, number>
  status: 'pending' | 'confirmed_duplicate' | 'distinct' | 'dismissed'
  reviewed_at: string | null
  review_notes: string | null
  detected_at: string
  detected_run: string | null
  // Merge fields (mig 42) — populated after merge_listing_duplicate runs.
  canonical_listing_id?: number | null
  merged_listing_id?:    number | null
  merged_at?:            string | null
  a: Listing | null
  b: Listing | null
}

type Status = 'pending' | 'confirmed_duplicate' | 'distinct' | 'dismissed'

const status = ref<Status>('pending')
const page = ref(1)
const pageSize = 20
const candidates = ref<Candidate[]>([])
const total = ref(0)
const loading = ref(true)
const submitting = ref<Record<string, boolean>>({})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ candidates: Candidate[]; total: number }>(
      '/api/admin/duplicates',
      { query: { status: status.value, page: page.value, page_size: pageSize } },
    )
    candidates.value = res.candidates ?? []
    total.value = res.total ?? 0
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load duplicates',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([status, page], load)

async function verdict(c: Candidate, next: Status) {
  if (submitting.value[c.id]) return
  submitting.value[c.id] = true
  try {
    await $fetch(`/api/admin/duplicates/${c.id}`, {
      method: 'PATCH',
      body: { status: next },
    })
    showToast({
      title: next === 'confirmed_duplicate' ? 'Marked duplicate' :
             next === 'distinct'            ? 'Marked distinct' :
                                              'Dismissed',
      icon: 'success',
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to update verdict',
      icon: 'error',
    })
  } finally {
    delete submitting.value[c.id]
  }
}

// Merge action: pick which side to KEEP. Loser gets soft-deleted +
// duplicate_of_id stamped. Confirms before running because it's
// destructive (reversible only by direct DB edit).
async function mergeKeeping(c: Candidate, canonicalListingId: number) {
  if (submitting.value[c.id]) return
  const loserListingId = canonicalListingId === c.a_listing_id ? c.b_listing_id : c.a_listing_id
  const message =
    `Merge: keep listing #${canonicalListingId}, soft-delete listing #${loserListingId}?\n\n` +
    `The deleted listing will be flagged duplicate_of_id = ${canonicalListingId} and removed from public surfaces. ` +
    `Reversible only by direct DB edit.`
  if (!confirm(message)) return

  submitting.value[c.id] = true
  try {
    await $fetch(`/api/admin/duplicates/${c.id}/merge`, {
      method: 'POST',
      body: { canonical_listing_id: canonicalListingId },
    })
    showToast({
      title: `Merged — kept #${canonicalListingId}, removed #${loserListingId}`,
      icon: 'success',
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to merge',
      icon: 'error',
    })
  } finally {
    delete submitting.value[c.id]
  }
}

function fmtCurrency(n: number | null): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v >= 1_000_000) return '₱' + (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000)     return '₱' + (v / 1_000).toFixed(1) + 'K'
  return '₱' + v.toFixed(0)
}

function confidenceClass(c: number): string {
  if (c >= 80) return 'bg-destructive/10 text-destructive ring-destructive/30'
  if (c >= 65) return 'bg-warning/10 text-warning ring-warning/30'
  return            'bg-primary/10 text-primary ring-primary/30'
}

function activeSignals(s: Record<string, number>): Array<{ key: string; value: number }> {
  return Object.entries(s)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => ({ key: k, value: Number(v) }))
    .sort((a, b) => b.value - a.value)
}

function signalLabel(key: string): string {
  return key.replace(/_/g, ' ')
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 class="text-base font-semibold text-foreground">Duplicate review queue</h2>
        <p class="mt-0.5 max-w-3xl text-xs text-muted-foreground">
          Pair candidates flagged by the deterministic detector. Verdicts are
          audit-logged. Confirming a duplicate does NOT delete listings —
          merging is a separate explicit operator action.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs font-medium text-muted-foreground">Status</label>
        <select
          v-model="status"
          class="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          @change="page = 1"
        >
          <option value="pending">Pending review</option>
          <option value="confirmed_duplicate">Confirmed duplicate</option>
          <option value="distinct">Marked distinct</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <span class="rounded-full bg-muted-foreground/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground/80">
          {{ total.toLocaleString() }}
        </span>
      </div>
    </header>

    <div v-if="loading" class="space-y-3">
      <div
        v-for="n in 3"
        :key="n"
        class="rounded-lg border border-border bg-card p-4"
      >
        <div class="flex items-baseline gap-2">
          <Skeleton class="h-5 w-24 rounded-full" />
          <Skeleton class="h-3 w-40" />
        </div>
        <div class="mt-3 grid grid-cols-2 gap-3">
          <Skeleton class="h-20" />
          <Skeleton class="h-20" />
        </div>
        <div class="mt-3 flex gap-2">
          <Skeleton class="h-7 w-32 rounded-lg" />
          <Skeleton class="h-7 w-24 rounded-lg" />
        </div>
      </div>
    </div>

    <section
      v-else-if="candidates.length === 0"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        :variant="status === 'pending' ? 'success' : 'neutral'"
        size="cozy"
        :title="
          status === 'pending'
            ? 'Duplicate queue is clear'
            : `No ${status.replace('_', ' ')} candidates`
        "
        description="The detector cron runs nightly + every 30 min. New pairs surface here for human review."
      />
    </section>

    <ul v-else class="space-y-3">
      <li
        v-for="c in candidates"
        :key="c.id"
        class="rounded-lg border border-border bg-card p-4"
      >
        <header class="mb-3 flex flex-wrap items-baseline gap-2">
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1"
            :class="confidenceClass(c.confidence)"
          >
            {{ c.confidence }}/100 confidence
          </span>
          <span class="text-[11px] text-muted-foreground">
            detected {{ new Date(c.detected_at).toLocaleString() }} · run
            <code class="font-mono">{{ c.detected_run }}</code>
          </span>
        </header>

        <!-- Side-by-side listing comparison -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div
            v-for="(side, label) in { A: c.a, B: c.b }"
            :key="label"
            class="rounded-lg border border-border bg-background p-3"
          >
            <p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Listing {{ label }} · #{{ side?.id }}
            </p>
            <p
              v-if="side"
              class="line-clamp-2 text-sm font-semibold text-foreground"
            >
              {{ side.title || `Listing #${side.id}` }}
            </p>
            <p v-else class="text-sm italic text-muted-foreground">
              (listing deleted)
            </p>
            <p v-if="side" class="mt-1 text-[11px] tabular-nums text-foreground/80">
              {{ fmtCurrency(side.sale_price ?? side.rent_price) }}
              <span v-if="side.bedrooms != null"> · {{ side.bedrooms }}BR</span>
              <span v-if="side.floor_area"> · {{ side.floor_area }}sqm</span>
            </p>
            <p v-if="side?.broker" class="mt-1 text-[10px] text-muted-foreground">
              by {{ side.broker.full_name || side.broker.id.slice(0, 8) }}
            </p>
            <NuxtLink
              v-if="side"
              :to="`/listings/${side.id}`"
              class="mt-2 inline-block text-[11px] font-semibold text-primary hover:underline"
              target="_blank"
            >
              Open listing â†—
            </NuxtLink>
          </div>
        </div>

        <!-- Signal breakdown — explainability -->
        <div class="mt-3">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Why flagged
          </p>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="s in activeSignals(c.signals)"
              :key="s.key"
              class="rounded-full bg-muted-foreground/10 px-2 py-0.5 font-mono text-[10px] text-foreground/80 ring-1 ring-muted-foreground/15"
              :title="`Contribution to confidence from ${signalLabel(s.key)}`"
            >
              {{ signalLabel(s.key) }}: +{{ s.value }}
            </span>
          </div>
        </div>

        <!-- Verdict actions (only for pending) -->
        <div v-if="c.status === 'pending'" class="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="submitting[c.id]"
            @click="verdict(c, 'confirmed_duplicate')"
          >
            Confirm duplicate
          </button>
          <button
            type="button"
            class="rounded-lg border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-semibold text-success transition-colors hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="submitting[c.id]"
            @click="verdict(c, 'distinct')"
          >
            Mark distinct
          </button>
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="submitting[c.id]"
            @click="verdict(c, 'dismissed')"
          >
            Dismiss
          </button>
        </div>

        <!-- Merge actions (after confirm). Hidden once already merged. -->
        <div
          v-else-if="c.status === 'confirmed_duplicate' && !c.merged_at"
          class="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-3"
        >
          <p class="mb-2 text-[11px] font-semibold text-warning">
            Confirmed duplicate. Pick which to keep — the other will be
            soft-deleted and flagged
            <code class="rounded bg-warning/15 px-1">duplicate_of_id</code>:
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="rounded-lg border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-semibold text-warning transition-colors hover:bg-warning/25 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="submitting[c.id] || !c.a"
              @click="mergeKeeping(c, c.a_listing_id)"
            >
              Keep A (#{{ c.a_listing_id }})
            </button>
            <button
              type="button"
              class="rounded-lg border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-semibold text-warning transition-colors hover:bg-warning/25 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="submitting[c.id] || !c.b"
              @click="mergeKeeping(c, c.b_listing_id)"
            >
              Keep B (#{{ c.b_listing_id }})
            </button>
            <button
              type="button"
              class="ml-auto rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="submitting[c.id]"
              @click="verdict(c, 'pending')"
            >
              Reopen
            </button>
          </div>
        </div>

        <!-- Already merged: surface the result -->
        <div
          v-else-if="c.status === 'confirmed_duplicate' && c.merged_at"
          class="mt-3 rounded-lg border border-success/30 bg-success/10 p-2.5 text-[11px] text-success"
        >
          ✓ Merged {{ new Date(c.merged_at).toLocaleString() }} —
          kept #{{ c.canonical_listing_id }}, removed #{{ c.merged_listing_id }}
        </div>
        <p
          v-else-if="c.reviewed_at"
          class="mt-3 text-[10px] text-muted-foreground"
        >
          Reviewed {{ new Date(c.reviewed_at).toLocaleString() }}
          <span v-if="c.review_notes"> · "{{ c.review_notes }}"</span>
          <button
            type="button"
            class="ml-2 font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="submitting[c.id]"
            @click="verdict(c, 'pending')"
          >
            Reopen
          </button>
        </p>
      </li>
    </ul>

    <!-- Pagination -->
    <div
      v-if="totalPages > 1"
      class="flex items-center justify-between text-xs"
    >
      <p class="tabular-nums text-muted-foreground">
        Page {{ page }} of {{ totalPages }} · {{ total.toLocaleString() }} total
      </p>
      <div class="flex gap-1">
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="page <= 1"
          @click="page = page - 1"
        >
          ← Previous
        </button>
        <button
          type="button"
          class="rounded-lg border border-border bg-card px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="page >= totalPages"
          @click="page = page + 1"
        >
          Next →
        </button>
      </div>
    </div>
  </section>
</template>
