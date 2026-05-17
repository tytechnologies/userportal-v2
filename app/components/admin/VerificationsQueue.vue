<script setup lang="ts">
/**
 * Admin verification review queue.
 *
 * Lists profile_verifications rows with status='pending' and lets an
 * admin approve or reject each one. Backend (PATCH /api/profile-
 * verifications/[id]) does the heavy lifting — optimistic concurrency
 * via `eq('status', 'pending')` means a second admin clicking the
 * same row gets a 404 and a "row disappeared" toast.
 *
 * Optimistic UI: row is removed from the local list immediately, then
 * restored if the PATCH fails. Avoids the queue feeling sluggish on
 * approve.
 *
 * Profile display: the endpoint returns rows by profile_id only. We
 * resolve display name + avatar via a single batch fetch against
 * `public_profiles` (anon-safe view, but also readable to admins via
 * the underlying authenticated policy).
 */
import { ref, onMounted, computed } from 'vue'
import { showToast } from '~/helpers/helpers'

type Verification = {
  id: string
  profile_id: string
  status: 'pending' | 'approved' | 'rejected'
  license_number: string | null
  license_authority: string | null
  brokerage_name: string | null
  evidence_url: string | null
  applicant_notes: string | null
  submitted_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_notes: string | null
}

type ProfileLite = {
  id: string
  full_name: string | null
  avatar_url: string | null
  slug: string | null
}

const rows = ref<Verification[]>([])
const profiles = ref<Record<string, ProfileLite>>({})
const loading = ref(true)
const submitting = ref<Record<string, boolean>>({})
const reviewNotes = ref<Record<string, string>>({})

const supabase = useSupabaseClient()

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{
      data: Verification[]
      total: number
    }>('/api/profile-verifications', {
      query: { status: 'pending', page: 1, page_size: 50 },
    })
    rows.value = res.data ?? []
    await hydrateProfiles()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load queue',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function hydrateProfiles() {
  const ids = Array.from(new Set(rows.value.map((r) => r.profile_id))).filter(
    (id): id is string => !!id,
  )
  if (ids.length === 0) {
    profiles.value = {}
    return
  }
  const { data } = await (supabase as any)
    .from('public_profiles')
    .select('id, full_name, avatar_url, slug')
    .in('id', ids)

  const map: Record<string, ProfileLite> = {}
  for (const p of (data ?? []) as ProfileLite[]) {
    map[p.id] = p
  }
  profiles.value = map
}

async function decide(row: Verification, status: 'approved' | 'rejected') {
  const id = row.id
  if (submitting.value[id]) return

  // Optimistic remove. Restore on failure.
  const prevIndex = rows.value.findIndex((r) => r.id === id)
  if (prevIndex < 0) return
  const removed = rows.value[prevIndex]!
  rows.value.splice(prevIndex, 1)

  submitting.value[id] = true
  try {
    await $fetch(`/api/profile-verifications/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        status,
        review_notes: reviewNotes.value[id]?.trim() || null,
      },
    })
    showToast({
      title: status === 'approved' ? 'Approved' : 'Rejected',
      icon: 'success',
    })
    delete reviewNotes.value[id]
  } catch (err: any) {
    // Restore the row.
    rows.value.splice(prevIndex, 0, removed)
    showToast({
      title:
        err?.statusCode === 404
          ? 'This row was already decided by someone else.'
          : err?.statusMessage || err?.message || 'Failed to update',
      icon: 'warning',
    })
  } finally {
    delete submitting.value[id]
  }
}

function profileFor(profileId: string): ProfileLite | null {
  return profiles.value[profileId] ?? null
}

function initialFor(p: ProfileLite | null): string {
  return (p?.full_name ?? '?').slice(0, 1).toUpperCase()
}

const isEmpty = computed(() => !loading.value && rows.value.length === 0)

onMounted(load)
</script>

<template>
  <section class="space-y-4">
    <header class="flex items-end justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-foreground">Pending verifications</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Review agent license and brokerage submissions.
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
        class="rounded-lg border border-border bg-card p-4"
      >
        <div class="flex items-start gap-3">
          <Skeleton shape="circle" class="h-10 w-10" />
          <div class="flex-1 space-y-2">
            <Skeleton class="h-3 w-1/3" />
            <Skeleton class="h-2.5 w-1/2" />
            <Skeleton class="h-12 w-full" />
            <div class="flex gap-2">
              <Skeleton class="h-7 w-20 rounded-lg" />
              <Skeleton class="h-7 w-20 rounded-lg" />
            </div>
          </div>
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
        title="No pending submissions"
        description="Approved and rejected requests stay accessible via the API. New submissions surface here for review."
      />
    </section>

    <ul v-else class="space-y-3">
      <li
        v-for="row in rows"
        :key="row.id"
        class="rounded-lg border border-border bg-card p-4"
      >
        <div class="flex items-start gap-3">
          <div class="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-muted-foreground/10">
            <img
              v-if="profileFor(row.profile_id)?.avatar_url"
              :src="profileFor(row.profile_id)!.avatar_url!"
              :alt="profileFor(row.profile_id)?.full_name || ''"
              class="h-full w-full object-cover"
              loading="lazy"
            />
            <div
              v-else
              class="flex h-full w-full items-center justify-center text-sm font-semibold text-foreground/70"
              aria-hidden="true"
            >
              {{ initialFor(profileFor(row.profile_id)) }}
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-2">
              <p class="truncate text-sm font-semibold text-foreground">
                {{ profileFor(row.profile_id)?.full_name || row.profile_id }}
              </p>
              <span class="text-xs text-muted-foreground">
                submitted {{ new Date(row.submitted_at).toLocaleString() }}
              </span>
            </div>

            <dl class="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <template v-if="row.license_number">
                <dt class="text-xs text-muted-foreground">License</dt>
                <dd class="text-foreground">
                  {{ row.license_number }}
                  <span v-if="row.license_authority" class="text-muted-foreground">
                    ({{ row.license_authority }})
                  </span>
                </dd>
              </template>
              <template v-if="row.brokerage_name">
                <dt class="text-xs text-muted-foreground">Brokerage</dt>
                <dd class="text-foreground">{{ row.brokerage_name }}</dd>
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
              <label class="sr-only" :for="`notes-${row.id}`">Review notes</label>
              <textarea
                :id="`notes-${row.id}`"
                v-model="reviewNotes[row.id]"
                rows="2"
                placeholder="Optional decision notes (sent to the agent)"
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
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
