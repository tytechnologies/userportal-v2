<script setup lang="ts">
/**
 * Admin queue for listing verification requests.
 *
 * Lifecycle mirror of profile_verifications: pending → approved /
 * rejected. Optimistic remove on action; restore on PATCH failure.
 *
 * Endpoint: /api/admin/listing-verifications
 * Action:   PATCH /api/admin/listing-verifications/:id
 */
import { ref, computed, onMounted } from 'vue'
import { showToast } from '~/helpers/helpers'

type Listing = {
  id: number
  title: string | null
  sale_price: number | null
  rent_price: number | null
  for_sale: boolean | null
  for_rent: boolean | null
  is_online: boolean | null
  created_by: string | null
}
type Profile = {
  id: string
  full_name: string | null
  avatar_url: string | null
  slug: string | null
}
type Verification = {
  id: string
  listing_id: number
  status: 'pending' | 'approved' | 'rejected'
  evidence_url: string | null
  applicant_notes: string | null
  submitted_at: string
  reviewed_at: string | null
  review_notes: string | null
  listing: Listing | null
  submitter: Profile | null
}

const rows = ref<Verification[]>([])
const loading = ref(true)
const submitting = ref<Record<string, boolean>>({})
const reviewNotes = ref<Record<string, string>>({})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Verification[] }>(
      '/api/admin/listing-verifications',
      { query: { status: 'pending', limit: 100 } },
    )
    rows.value = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load queue',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function decide(row: Verification, status: 'approved' | 'rejected') {
  if (submitting.value[row.id]) return
  const prevIndex = rows.value.findIndex((r) => r.id === row.id)
  if (prevIndex < 0) return
  const removed = rows.value[prevIndex]!
  rows.value.splice(prevIndex, 1)
  submitting.value[row.id] = true
  try {
    await $fetch(`/api/admin/listing-verifications/${row.id}`, {
      method: 'PATCH',
      body: {
        status,
        review_notes: reviewNotes.value[row.id]?.trim() || null,
      },
    })
    showToast({
      title: status === 'approved' ? 'Approved' : 'Rejected',
      icon: 'success',
    })
    delete reviewNotes.value[row.id]
  } catch (err: any) {
    rows.value.splice(prevIndex, 0, removed)
    showToast({
      title:
        err?.statusCode === 404
          ? 'This row was already decided by someone else.'
          : err?.statusMessage || err?.message || 'Failed to update',
      icon: 'warning',
    })
  } finally {
    delete submitting.value[row.id]
  }
}

function formatPrice(l: Listing | null): string {
  if (!l) return ''
  if (l.for_sale && l.sale_price != null) return `₱${Number(l.sale_price).toLocaleString()}`
  if (l.for_rent && l.rent_price != null) return `₱${Number(l.rent_price).toLocaleString()} / mo`
  return '—'
}
function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const isEmpty = computed(() => !loading.value && rows.value.length === 0)
onMounted(load)
</script>

<template>
  <section class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-foreground">
          Pending listing verifications
        </h3>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Listing owners submit evidence; admin reviews. Approved listings
          surface a verified badge on the marketplace.
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

    <div v-if="loading" class="space-y-3">
      <div
        v-for="n in 3"
        :key="n"
        class="rounded-lg border border-border bg-card p-4 space-y-2"
      >
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="h-16 w-full" />
        <div class="flex gap-2">
          <Skeleton class="h-7 w-20 rounded-lg" />
          <Skeleton class="h-7 w-20 rounded-lg" />
        </div>
      </div>
    </div>

    <section
      v-else-if="isEmpty"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        variant="success"
        size="cozy"
        title="No pending listing verifications"
        description="When a listing owner submits evidence, it lands here for review."
      />
    </section>

    <ul v-else class="space-y-3">
      <li
        v-for="row in rows"
        :key="row.id"
        class="rounded-lg border border-border bg-card p-4"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <p class="text-sm font-semibold text-foreground">
            {{ row.listing?.title || `Listing #${row.listing_id}` }}
          </p>
          <NuxtLink
            :to="`/listings/${row.listing_id}`"
            class="font-mono text-xs text-primary hover:underline"
          >
            #{{ row.listing_id }}
          </NuxtLink>
          <span class="ml-auto text-xs text-muted-foreground">
            submitted {{ formatTs(row.submitted_at) }}
          </span>
        </div>

        <dl class="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <template v-if="row.listing">
            <dt class="text-xs text-muted-foreground">Price</dt>
            <dd class="text-foreground">{{ formatPrice(row.listing) }}</dd>
            <dt class="text-xs text-muted-foreground">Online</dt>
            <dd>
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1"
                :class="
                  row.listing.is_online
                    ? 'bg-success/10 text-success ring-success/30'
                    : 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/15'
                "
              >
                {{ row.listing.is_online ? 'Online' : 'Offline' }}
              </span>
            </dd>
          </template>
          <template v-if="row.submitter">
            <dt class="text-xs text-muted-foreground">Submitted by</dt>
            <dd class="text-foreground">{{ row.submitter.full_name || '—' }}</dd>
          </template>
          <template v-if="row.evidence_url">
            <dt class="text-xs text-muted-foreground">Evidence</dt>
            <dd>
              <a
                :href="row.evidence_url"
                target="_blank"
                rel="noopener noreferrer"
                class="font-medium text-primary hover:underline"
              >
                Open â†—
              </a>
            </dd>
          </template>
        </dl>

        <p
          v-if="row.applicant_notes"
          class="mt-3 rounded-lg border border-border bg-muted-foreground/5 p-2.5 text-sm text-foreground/90"
        >
          {{ row.applicant_notes }}
        </p>

        <div class="mt-3">
          <label :for="`l-notes-${row.id}`" class="sr-only">Review notes</label>
          <textarea
            :id="`l-notes-${row.id}`"
            v-model="reviewNotes[row.id]"
            rows="2"
            placeholder="Optional decision notes"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-lg bg-success px-3 py-1.5 text-xs font-semibold text-success-foreground transition-colors hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!!submitting[row.id]"
            @click="decide(row, 'approved')"
          >
            Approve
          </button>
          <button
            type="button"
            class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="!!submitting[row.id]"
            @click="decide(row, 'rejected')"
          >
            Reject
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
