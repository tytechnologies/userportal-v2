<script setup lang="ts">
/**
 * Admin queue for building verifications.
 *
 * Buildings don't go through a self-submit / pending → approved
 * lifecycle. Admins flip the flag directly via
 *   POST /api/admin/buildings/:id/verify { status }.
 *
 * This component is therefore a "verified buildings" list with:
 *   - search across the public buildings table
 *   - per-row Verify (toggle) action
 *   - filter on currently-approved view
 *
 * Search uses the existing public.buildings query (curated only, by
 * ilike on name). The list of EXISTING verifications and the list
 * of buildings overlap; we render whichever the operator filters to.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { showToast } from '~/helpers/helpers'

type Building = {
  id: number
  name: string
  slug: string | null
  address: string | null
  is_curated?: boolean
}
type Verification = {
  id: string
  property_id: number
  status: 'pending' | 'approved' | 'rejected'
  evidence_url: string | null
  reviewed_at: string | null
  review_notes: string | null
  building: Building | null
}

type View = 'verified' | 'search'

const view = ref<View>('verified')
const verifications = ref<Verification[]>([])
const candidates = ref<Building[]>([])
const search = ref('')
const loading = ref(false)
const submitting = ref<Record<number, boolean>>({})

const supabase = useSupabaseClient()

async function loadVerified() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Verification[] }>(
      '/api/admin/building-verifications',
      { query: { status: 'approved', limit: 100 } },
    )
    verifications.value = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load verifications',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!q || q.trim().length < 2) {
    candidates.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    loading.value = true
    try {
      // Read directly from public.buildings (curated only). This is
      // an admin-authenticated client, so RLS allows the read.
      const { data, error } = await (supabase as any)
        .from('buildings')
        .select('id, name, slug, address, is_curated')
        .eq('is_curated', true)
        .ilike('name', `%${q.trim().replace(/[%,()]/g, '')}%`)
        .order('name', { ascending: true })
        .limit(50)
      if (error) throw error
      candidates.value = (data ?? []) as Building[]
    } catch (err: any) {
      showToast({
        title: err?.message || 'Search failed',
        icon: 'error',
      })
    } finally {
      loading.value = false
    }
  }, 250)
})

function isVerified(buildingId: number): boolean {
  return verifications.value.some((v) => v.property_id === buildingId)
}

async function toggleVerify(building: Building, currentlyVerified: boolean) {
  submitting.value[building.id] = true
  try {
    const newStatus = currentlyVerified ? 'rejected' : 'approved'
    await $fetch(`/api/admin/buildings/${building.id}/verify`, {
      method: 'POST',
      body: {
        status: newStatus,
        review_notes: currentlyVerified
          ? 'Unverified by moderator'
          : 'Verified by moderator',
      },
    })
    showToast({
      title: currentlyVerified ? 'Verification removed' : 'Building verified',
      icon: 'success',
    })
    await loadVerified()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Update failed',
      icon: 'error',
    })
  } finally {
    delete submitting.value[building.id]
  }
}

const verifiedRows = computed(() =>
  verifications.value.map((v) => ({
    building: v.building,
    verified: true,
    verification: v,
  })),
)
const searchRows = computed(() =>
  candidates.value.map((b) => ({
    building: b,
    verified: isVerified(b.id),
    verification: null,
  })),
)

const visibleRows = computed(() =>
  view.value === 'verified' ? verifiedRows.value : searchRows.value,
)
const isEmpty = computed(() => !loading.value && visibleRows.value.length === 0)

onMounted(loadVerified)
</script>

<template>
  <section class="space-y-3">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Building verifications</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Direct-verify pattern. No submit-then-approve cycle — admins flip
          the flag inline.
        </p>
      </div>
      <button
        type="button"
        class="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="loading"
        @click="loadVerified"
      >
        Refresh
      </button>
    </header>

    <!-- View toggle -->
    <div class="flex gap-1.5 rounded-lg border border-border bg-card p-2">
      <button
        type="button"
        class="flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors"
        :class="
          view === 'verified'
            ? 'bg-foreground text-background'
            : 'bg-muted-foreground/10 text-foreground/80 hover:bg-muted-foreground/20'
        "
        @click="view = 'verified'"
      >
        Verified ({{ verifications.length }})
      </button>
      <button
        type="button"
        class="flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors"
        :class="
          view === 'search'
            ? 'bg-foreground text-background'
            : 'bg-muted-foreground/10 text-foreground/80 hover:bg-muted-foreground/20'
        "
        @click="view = 'search'"
      >
        Search buildings
      </button>
    </div>

    <input
      v-if="view === 'search'"
      v-model="search"
      type="text"
      placeholder="Search by building name…"
      class="w-full rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
    />

    <div v-if="loading && visibleRows.length === 0" class="space-y-2">
      <div
        v-for="n in 4"
        :key="n"
        class="rounded-lg border border-border bg-card p-3"
      >
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="mt-1 h-2.5 w-1/2" />
      </div>
    </div>

    <section
      v-else-if="isEmpty"
      class="rounded-lg border border-border bg-card"
    >
      <EmptyState
        :variant="view === 'verified' ? 'success' : 'neutral'"
        size="cozy"
        :title="
          view === 'verified'
            ? 'No buildings verified yet'
            : search.length >= 2
              ? `No matches for ${JSON.stringify(search)}`
              : 'Search to verify a building'
        "
        :description="
          view === 'verified'
            ? 'Switch to Search to find a building and flip its verified flag.'
            : search.length >= 2
              ? 'Try a different name or partial match.'
              : 'Type at least 2 characters to search the building registry.'
        "
      />
    </section>

    <ul v-else class="space-y-2">
      <li
        v-for="row in visibleRows"
        :key="row.building?.id ?? Math.random()"
        class="rounded-lg border border-border bg-card p-3"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <p class="text-sm font-semibold text-foreground">
            {{ row.building?.name || '—' }}
          </p>
          <span
            v-if="row.verified"
            class="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success ring-1 ring-success/30"
          >
            Verified
          </span>
          <NuxtLink
            v-if="row.building?.slug"
            :to="`/building/${row.building.slug}`"
            target="_blank"
            class="text-xs font-medium text-primary hover:underline"
          >
            View â†—
          </NuxtLink>
          <button
            v-if="row.building"
            type="button"
            class="ml-auto rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            :class="
              row.verified
                ? 'border border-border bg-card text-destructive hover:bg-destructive/10'
                : 'bg-success text-success-foreground hover:bg-success/90'
            "
            :disabled="!!submitting[row.building.id]"
            @click="toggleVerify(row.building, row.verified)"
          >
            {{ row.verified ? 'Unverify' : 'Verify' }}
          </button>
        </div>
        <p
          v-if="row.building?.address"
          class="mt-0.5 text-xs text-muted-foreground"
        >
          {{ row.building.address }}
        </p>
      </li>
    </ul>
  </section>
</template>
