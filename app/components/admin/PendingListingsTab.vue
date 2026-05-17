<script setup lang="ts">
/**
 * Admin pending-listings moderation queue.
 *
 * Reads /api/admin/listings/moderation. Shows listings awaiting
 * publish review with the operationally-relevant signals: quality
 * score, image count, duplicate-candidate count, source attribution,
 * broker, and resolved geography.
 *
 * Verdict actions (PATCH /:id/moderation):
 *   - Approve & publish → flips is_online = true
 *   - Reject (soft-delete) → flips deleted_at = now()
 *   - Hold (no mutation, audit-logged with notes)
 *
 * Tabs across the top split pending / recently approved / recently
 * rejected so admins can verify their own actions and recover from
 * misclicks.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Status = 'pending' | 'published' | 'rejected'

type Listing = {
  id: number
  title: string | null
  description: string | null
  sale_price: number | null
  rent_price: number | null
  property_category: string | null
  property_type: string | null
  bedrooms: number | null
  bathrooms: number | null
  floor_area: number | null
  is_online: boolean
  deleted_at: string | null
  created_at: string
  broker: { id: string; full_name: string | null; email: string | null } | null
  city: { id: number; name: string; slug: string } | null
  barangay: { id: number; name: string; slug: string } | null
  building: { id: number; name: string; slug: string } | null
  source: { id: number; slug: string; display_name: string } | null
  image_count: number
  quality_score: number | null
  duplicate_candidate_count: number
}

const status = ref<Status>('pending')
const page = ref(1)
const pageSize = 20
const listings = ref<Listing[]>([])
const total = ref(0)
const loading = ref(true)
const submitting = ref<Record<number, boolean>>({})
const expandedListing = ref<number | null>(null)
const holdNotes = ref<Record<number, string>>({})

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ listings: Listing[]; total: number }>(
      '/api/admin/listings/moderation',
      { query: { status: status.value, page: page.value, page_size: pageSize } },
    )
    listings.value = res.listings ?? []
    total.value = res.total ?? 0
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load listings',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([status, page], load)
watch(status, () => { page.value = 1 })

async function verdict(l: Listing, action: 'approve' | 'reject' | 'hold') {
  if (submitting.value[l.id]) return
  if (action === 'reject' && !confirm(`Reject "${l.title || `listing #${l.id}`}"? Soft-deletes the listing.`)) return
  submitting.value[l.id] = true
  try {
    const body: any = { action }
    if (action === 'hold' && holdNotes.value[l.id]) body.notes = holdNotes.value[l.id]
    await $fetch(`/api/admin/listings/${l.id}/moderation`, {
      method: 'PATCH',
      body,
    })
    showToast({
      title:
        action === 'approve' ? 'Published' :
        action === 'reject'  ? 'Rejected (soft-deleted)' :
                               'Held — note logged',
      icon: 'success',
    })
    delete holdNotes.value[l.id]
    expandedListing.value = null
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to update',
      icon: 'error',
    })
  } finally {
    delete submitting.value[l.id]
  }
}

function fmtCurrency(n: number | null): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (v >= 1_000_000) return '₱' + (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000)     return '₱' + (v / 1_000).toFixed(1) + 'K'
  return '₱' + v.toFixed(0)
}

function priceDisplay(l: Listing): string {
  if (l.sale_price) return fmtCurrency(l.sale_price)
  if (l.rent_price) return fmtCurrency(l.rent_price) + '/mo'
  return '—'
}

function qualityBadge(score: number | null): { label: string; cls: string } | null {
  if (score == null) return null
  if (score >= 85) return { label: `quality ${score}`, cls: 'bg-success/10 text-success ring-success/30' }
  if (score >= 70) return { label: `quality ${score}`, cls: 'bg-primary/10 text-primary ring-primary/30' }
  if (score >= 50) return { label: `quality ${score}`, cls: 'bg-warning/10 text-warning ring-warning/30' }
  return                { label: `quality ${score}`, cls: 'bg-destructive/10 text-destructive ring-destructive/30' }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

function locationLabel(l: Listing): string {
  const parts: string[] = []
  if (l.barangay?.name) parts.push(l.barangay.name)
  if (l.city?.name)     parts.push(l.city.name)
  return parts.join(', ') || '—'
}
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 class="text-sm font-semibold text-foreground">Listing moderation</h2>
        <p class="text-xs text-muted-foreground">
          Imported listings start with <span class="font-mono">is_online = false</span>.
          Approve to publish, reject to soft-delete, or hold to log a review note.
          Quality score is from <span class="font-mono">listing_quality</span> (refreshed hourly);
          new listings show <em>—</em> until the next refresh.
        </p>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <label class="font-medium text-muted-foreground">Tab</label>
        <select
          v-model="status"
          class="rounded-md border border-border bg-card px-2 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="pending">Pending review</option>
          <option value="published">Recently published (7d)</option>
          <option value="rejected">Recently rejected (30d)</option>
        </select>
      </div>
    </header>

    <div v-if="loading" class="space-y-2">
      <div
        v-for="n in 4"
        :key="n"
        class="rounded-lg border border-border bg-card p-4"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <Skeleton class="h-3 w-1/3" />
          <Skeleton class="h-4 w-16 rounded-full" />
        </div>
        <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Skeleton v-for="n2 in 4" :key="n2" class="h-3 w-full" />
        </div>
        <div class="mt-3 flex gap-2">
          <Skeleton class="h-7 w-20 rounded-lg" />
          <Skeleton class="h-7 w-20 rounded-lg" />
        </div>
      </div>
    </div>

    <section
      v-else-if="listings.length === 0"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        :variant="status === 'pending' ? 'success' : 'neutral'"
        size="cozy"
        :title="
          status === 'pending'
            ? 'Moderation queue is clear'
            : `No recently ${status} listings`
        "
        description="Listings created via import or marked is_online=false land here for human approval."
      />
    </section>

    <ul v-else class="space-y-2">
      <li
        v-for="l in listings"
        :key="l.id"
        class="rounded-lg border border-border bg-card p-4"
      >
        <header class="flex flex-wrap items-baseline gap-2">
          <NuxtLink
            :to="`/listings/${l.id}`"
            target="_blank"
            class="text-sm font-semibold text-foreground hover:underline"
          >
            {{ l.title || `Listing #${l.id}` }}
          </NuxtLink>
          <span class="text-[11px] text-muted-foreground">#{{ l.id }}</span>

          <!-- Status / signal badges -->
          <span
            v-if="l.image_count === 0"
            class="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive ring-1 ring-destructive/30"
            title="No images attached — listing will publish without photos"
          >
            no images
          </span>
          <span
            v-else
            class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            {{ l.image_count }} image{{ l.image_count === 1 ? '' : 's' }}
          </span>

          <span
            v-if="qualityBadge(l.quality_score)"
            class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1"
            :class="qualityBadge(l.quality_score)!.cls"
          >
            {{ qualityBadge(l.quality_score)!.label }}
          </span>

          <NuxtLink
            v-if="l.duplicate_candidate_count > 0"
            to="/admin?tab=duplicates"
            class="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning ring-1 ring-warning/30 hover:underline"
            :title="`${l.duplicate_candidate_count} pending duplicate candidate(s)`"
          >
            {{ l.duplicate_candidate_count }} dup
          </NuxtLink>

          <span
            v-if="l.source"
            class="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-mono text-primary ring-1 ring-primary/30"
            :title="l.source.display_name"
          >
            src: {{ l.source.slug }}
          </span>

          <span class="ml-auto text-[10px] text-muted-foreground">
            {{ new Date(l.created_at).toLocaleString() }}
          </span>
        </header>

        <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          <div class="text-xs">
            <span class="text-muted-foreground">Price:</span>
            <span class="ml-1 font-semibold">{{ priceDisplay(l) }}</span>
          </div>
          <div class="text-xs">
            <span class="text-muted-foreground">Type:</span>
            <span class="ml-1">{{ l.property_type || '—' }}</span>
          </div>
          <div class="text-xs">
            <span class="text-muted-foreground">Specs:</span>
            <span class="ml-1">
              <span v-if="l.bedrooms != null">{{ l.bedrooms }}BR</span>
              <span v-if="l.bathrooms != null"> · {{ l.bathrooms }}BA</span>
              <span v-if="l.floor_area"> · {{ l.floor_area }}sqm</span>
              <span v-if="l.bedrooms == null && l.bathrooms == null && !l.floor_area">—</span>
            </span>
          </div>
          <div class="text-xs">
            <span class="text-muted-foreground">Location:</span>
            <span class="ml-1">{{ locationLabel(l) }}</span>
          </div>
          <div class="text-xs sm:col-span-2">
            <span class="text-muted-foreground">Building:</span>
            <span class="ml-1">{{ l.building?.name || '—' }}</span>
          </div>
          <div class="text-xs sm:col-span-2">
            <span class="text-muted-foreground">Broker:</span>
            <span class="ml-1">
              {{ l.broker?.full_name || l.broker?.email || (l.broker ? l.broker.id.slice(0, 8) : '—') }}
            </span>
          </div>
        </div>

        <p
          v-if="l.description"
          class="mt-2 line-clamp-2 text-xs text-muted-foreground"
        >
          {{ l.description }}
        </p>

        <!-- Actions (only for pending) -->
        <div v-if="status === 'pending'" class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded-md bg-success px-3 py-1 text-xs font-semibold text-success-foreground hover:bg-success/90 disabled:opacity-50"
            :disabled="submitting[l.id]"
            @click="verdict(l, 'approve')"
          >
            Approve &amp; publish
          </button>
          <button
            type="button"
            class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive hover:bg-destructive/15 disabled:opacity-50"
            :disabled="submitting[l.id]"
            @click="verdict(l, 'reject')"
          >
            Reject
          </button>
          <button
            type="button"
            class="rounded-md border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            @click="expandedListing = expandedListing === l.id ? null : l.id"
          >
            {{ expandedListing === l.id ? 'Cancel hold' : 'Hold with note' }}
          </button>
          <NuxtLink
            :to="`/listings/${l.id}`"
            target="_blank"
            class="ml-auto text-[11px] font-semibold text-primary hover:underline"
          >
            Open listing →
          </NuxtLink>
        </div>

        <div v-if="expandedListing === l.id" class="mt-2 space-y-2">
          <input
            v-model="holdNotes[l.id]"
            type="text"
            class="w-full rounded-md border border-border px-2 py-1 text-xs"
            placeholder="Why are you holding this listing? (logged for audit)"
          />
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
            :disabled="submitting[l.id] || !holdNotes[l.id]"
            @click="verdict(l, 'hold')"
          >
            Save hold note
          </button>
        </div>

        <!-- Status indicators for non-pending tabs -->
        <p
          v-if="status === 'published'"
          class="mt-3 text-[10px] font-semibold text-success"
        >
          Published
        </p>
        <p
          v-else-if="status === 'rejected'"
          class="mt-3 text-[10px] font-semibold text-destructive"
        >
          Soft-deleted at {{ l.deleted_at ? new Date(l.deleted_at).toLocaleString() : '—' }}
        </p>
      </li>
    </ul>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex items-center justify-between text-xs">
      <p class="text-muted-foreground">
        Page {{ page }} of {{ totalPages }} · {{ total }} total
      </p>
      <div class="flex gap-1">
        <button
          type="button"
          class="rounded-md border border-border bg-card px-2 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
          :disabled="page <= 1"
          @click="page = page - 1"
        >
          ←
        </button>
        <button
          type="button"
          class="rounded-md border border-border bg-card px-2 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-ring font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
          :disabled="page >= totalPages"
          @click="page = page + 1"
        >
          →
        </button>
      </div>
    </div>
  </section>
</template>
