<script setup lang="ts">
/**
 * Admin review moderation queue.
 *
 * Reads /api/admin/review-reports?status=open. Each row carries the
 * underlying review body inline so moderators can triage without a
 * second fetch. Three actions per row:
 *   - Hide review (PATCH /api/reviews/:id { hidden: true })
 *   - Dismiss report (PATCH /api/admin/review-reports/:id { status: 'dismissed' })
 *   - Mark resolved (PATCH /api/admin/review-reports/:id { status: 'reviewed' })
 *
 * The auto-hide trigger (mig 20260507000020) fires at 3+ open reports
 * — rows where the underlying review is already hidden_at != null
 * are styled differently to indicate "system already acted".
 */
import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'

type Reviewer = {
  id: string | null
  full_name: string | null
  avatar_url: string | null
  slug: string | null
}
type Report = {
  id: string
  review_id: string
  reason: string
  status: 'open' | 'reviewed' | 'dismissed'
  created_at: string
  reviewed_at: string | null
  review_notes: string | null
  reporter: Reviewer
  review: {
    id: string
    target_type: string
    target_id: string
    rating: number
    title: string | null
    body: string
    hidden_at: string | null
    hidden_reason: string | null
    created_at: string
    reviewer: Reviewer
  } | null
}

const reports = ref<Report[]>([])
const loading = ref(true)
const submitting = ref<Record<string, boolean>>({})
const tab = ref<'open' | 'reviewed' | 'dismissed'>('open')

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Report[] }>(
      '/api/admin/review-reports',
      { query: { status: tab.value, limit: 100 } },
    )
    reports.value = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load queue',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function hideReview(r: Report) {
  if (!r.review) return
  if (!confirm(
    `Hide this review by ${r.review.reviewer?.full_name || 'reviewer'}? `
    + `It stays in the database but is removed from public view. The reviewer can still see it.`,
  )) return
  submitting.value[r.id] = true
  try {
    await $fetch(`/api/reviews/${r.review.id}`, {
      method: 'PATCH',
      body: {
        hidden: true,
        hidden_reason: 'Hidden by moderator following abuse report',
      },
    })
    // Mark this report as reviewed too — moderator took action.
    await $fetch(`/api/admin/review-reports/${r.id}`, {
      method: 'PATCH',
      body: { status: 'reviewed', review_notes: 'Review hidden' },
    })
    showToast({ title: 'Review hidden + report resolved', icon: 'success' })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Action failed',
      icon: 'error',
    })
  } finally {
    delete submitting.value[r.id]
  }
}

async function resolveReport(r: Report, status: 'reviewed' | 'dismissed') {
  submitting.value[r.id] = true
  try {
    await $fetch(`/api/admin/review-reports/${r.id}`, {
      method: 'PATCH',
      body: { status },
    })
    showToast({
      title: status === 'dismissed' ? 'Report dismissed' : 'Report resolved',
      icon: 'success',
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Update failed',
      icon: 'error',
    })
  } finally {
    delete submitting.value[r.id]
  }
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function selectTab(t: 'open' | 'reviewed' | 'dismissed') {
  tab.value = t
  load()
}

const isEmpty = computed(() => !loading.value && reports.value.length === 0)

onMounted(load)
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 class="text-base font-semibold text-foreground">Review moderation</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          User-flagged reviews. Auto-hide kicks in at 3+ open reports
          (migration
          <code class="rounded bg-muted-foreground/10 px-1">20260507000020</code>);
          this queue still surfaces those for human review.
        </p>
      </div>
      <button
        type="button"
        class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="loading"
        @click="load"
      >
        Refresh
      </button>
    </header>

    <!-- Tab strip: open / reviewed / dismissed -->
    <div class="flex gap-1.5 rounded-lg border border-border bg-card p-2">
      <button
        v-for="t in (['open', 'reviewed', 'dismissed'] as const)"
        :key="t"
        type="button"
        class="flex-1 rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition-colors"
        :class="
          tab === t
            ? 'bg-foreground text-background'
            : 'bg-muted-foreground/10 text-foreground/80 hover:bg-muted-foreground/20'
        "
        @click="selectTab(t)"
      >
        {{ t }}
      </button>
    </div>

    <!-- Loading: 4-row skeleton matching report card shape. -->
    <div v-if="loading" class="space-y-3">
      <div
        v-for="n in 4"
        :key="n"
        class="rounded-lg border border-border bg-card p-4"
      >
        <div class="flex items-baseline gap-2">
          <Skeleton class="h-3 w-32" />
          <Skeleton class="h-3 w-20" />
        </div>
        <Skeleton class="mt-2 h-4 w-full" />
        <Skeleton class="mt-3 h-20 w-full" />
        <div class="mt-3 flex gap-2">
          <Skeleton class="h-7 w-32 rounded-lg" />
          <Skeleton class="h-7 w-24 rounded-lg" />
        </div>
      </div>
    </div>

    <section
      v-else-if="isEmpty"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        :variant="tab === 'open' ? 'success' : 'neutral'"
        size="cozy"
        :title="tab === 'open' ? 'No open reports' : `No ${tab} reports`"
        :description="
          tab === 'open'
            ? 'The community is calm — every flagged review has been triaged.'
            : `Reports moved to the ${tab} state will surface here.`
        "
      />
    </section>

    <ul v-else class="space-y-3">
      <li
        v-for="r in reports"
        :key="r.id"
        class="rounded-lg border bg-card p-4 transition-colors"
        :class="
          r.review?.hidden_at
            ? 'border-warning/30 bg-warning/10'
            : 'border-border'
        "
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <p class="text-sm font-semibold text-foreground">
            Report by
            {{ r.reporter?.full_name || r.reporter?.id || 'Unknown' }}
          </p>
          <span class="text-xs text-muted-foreground">{{ formatTs(r.created_at) }}</span>
          <span
            v-if="r.review?.hidden_at"
            class="ml-auto inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning ring-1 ring-warning/30"
          >
            Already hidden
            <span v-if="r.review.hidden_reason?.startsWith('auto-hidden')">
              · auto
            </span>
          </span>
        </div>

        <p class="mt-2 rounded-lg border border-border bg-muted-foreground/5 p-2.5 text-sm text-foreground/90">
          <strong class="text-foreground">Reason:</strong> {{ r.reason }}
        </p>

        <div
          v-if="r.review"
          class="mt-3 rounded-lg border border-border bg-background p-3"
        >
          <div class="flex items-baseline gap-2">
            <span class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {{ r.review.target_type }}
            </span>
            <span class="text-xs text-muted-foreground">
              #{{ r.review.target_id }}
            </span>
            <span class="ml-auto" aria-label="rating">
              <span v-for="slot in 5" :key="slot">
                <span
                  :class="
                    r.review.rating >= slot
                      ? 'text-warning'
                      : 'text-muted-foreground/40'
                  "
                  >â˜…</span
                >
              </span>
            </span>
          </div>
          <p
            v-if="r.review.title"
            class="mt-1 text-sm font-semibold text-foreground"
          >
            {{ r.review.title }}
          </p>
          <p class="mt-1 whitespace-pre-line text-sm text-foreground/85">
            {{ r.review.body }}
          </p>
          <p class="mt-2 text-xs text-muted-foreground">
            By {{ r.review.reviewer?.full_name || 'Unknown' }}
            · {{ formatTs(r.review.created_at) }}
          </p>
        </div>

        <div v-if="tab === 'open'" class="mt-3 flex flex-wrap gap-2">
          <button
            v-if="!r.review?.hidden_at"
            type="button"
            class="rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-colors duration-150 ease-out hover:bg-destructive/90 focus-ring disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!!submitting[r.id]"
            @click="hideReview(r)"
          >
            Hide review + resolve
          </button>
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!!submitting[r.id]"
            @click="resolveReport(r, 'reviewed')"
          >
            Mark resolved
          </button>
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!!submitting[r.id]"
            @click="resolveReport(r, 'dismissed')"
          >
            Dismiss report
          </button>
        </div>

        <p
          v-if="r.review_notes"
          class="mt-2 text-xs text-muted-foreground"
        >
          <strong class="text-foreground/80">Notes:</strong>
          {{ r.review_notes }}
        </p>
      </li>
    </ul>
  </section>
</template>
