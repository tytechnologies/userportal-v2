<script setup lang="ts">
/**
 * Admin source registry.
 *
 * Lists rows in `public.listing_sources` and lets an admin:
 *   - Create a new source (auto-generates ingest_secret server-side).
 *   - Edit display_name / base_url / enabled / notes inline.
 *   - Reveal the current ingest_secret (admin-only RLS gates the read).
 *   - Rotate the ingest_secret via the rotate_listing_source_secret RPC,
 *     receiving the new value once for clipboard handoff.
 *
 * RLS posture (post 20260506000014):
 *   - SELECT: requires sources.manage permission (admin only).
 *   - INSERT/UPDATE/DELETE: same.
 *   - rotate RPC: SECURITY DEFINER, re-checks sources.manage internally.
 *
 * No service-role client used here. RLS is the wall.
 */
import { ref, onMounted, computed } from 'vue'
import { showToast } from '~/helpers/helpers'

type ListingSource = {
  id: number
  slug: string
  display_name: string
  base_url: string | null
  enabled: boolean
  ingest_secret: string
  last_ingested_at: string | null
  notes: string | null
  /** Hours of inactivity before listings from this source auto-archive. */
  staleness_ttl_hours: number
  created_at: string
  updated_at: string
}

const supabase = useSupabaseClient()
const sources = ref<ListingSource[]>([])
const loading = ref(true)
const showSecretFor = ref<Set<number>>(new Set())
const rotating = ref<Record<number, boolean>>({})
const editing = ref<Record<number, boolean>>({})
const editForm = ref<Record<number, Partial<ListingSource>>>({})

// Recent ingest runs per source (lazy-loaded on "View runs").
type IngestRun = {
  id: string
  processed: number
  inserted: number
  updated: number
  errors_count: number
  triggered_by: 'admin' | 'source'
  duration_ms: number | null
  created_at: string
}
const runsOpen = ref<Set<number>>(new Set())
const runs = ref<Record<number, IngestRun[]>>({})
const runsLoading = ref<Record<number, boolean>>({})
const showCreate = ref(false)
const createForm = ref({
  slug: '',
  display_name: '',
  base_url: '',
  notes: '',
  staleness_ttl_hours: 168, // 7 days
})
const creating = ref(false)
// One-time-display modal for newly-rotated or freshly-created secrets.
const oneTimeSecret = ref<{ slug: string; secret: string } | null>(null)

async function load() {
  loading.value = true
  try {
    const { data, error } = await (supabase as any)
      .from('listing_sources')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    sources.value = (data ?? []) as ListingSource[]
  } catch (err: any) {
    showToast({
      title: err?.message || 'Failed to load sources',
      icon: 'error',
    })
  } finally {
    loading.value = false
  }
}

const slugRe = /^[a-z0-9_]{2,60}$/

function startCreate() {
  createForm.value = {
    slug: '',
    display_name: '',
    base_url: '',
    notes: '',
    staleness_ttl_hours: 168,
  }
  showCreate.value = true
}
async function createSource() {
  if (creating.value) return
  const { slug, display_name, base_url, notes } = createForm.value
  if (!slugRe.test(slug.trim())) {
    showToast({
      title: 'Slug must be lowercase letters, digits, underscores (2–60 chars).',
      icon: 'warning',
    })
    return
  }
  if (!display_name.trim()) {
    showToast({ title: 'Display name is required.', icon: 'warning' })
    return
  }
  creating.value = true
  try {
    const ttl = Math.max(1, Math.min(8760, Math.trunc(Number(createForm.value.staleness_ttl_hours)) || 168))
    const { data, error } = await (supabase as any)
      .from('listing_sources')
      .insert({
        slug: slug.trim(),
        display_name: display_name.trim(),
        base_url: base_url.trim() || null,
        notes: notes.trim() || null,
        staleness_ttl_hours: ttl,
      })
      .select('*')
      .single()
    if (error) throw error
    sources.value.unshift(data as ListingSource)
    showCreate.value = false
    // Show the auto-generated secret once.
    oneTimeSecret.value = { slug: data.slug, secret: data.ingest_secret }
  } catch (err: any) {
    showToast({
      title: err?.message || 'Failed to create source',
      icon: 'error',
    })
  } finally {
    creating.value = false
  }
}

function startEdit(s: ListingSource) {
  editing.value[s.id] = true
  editForm.value[s.id] = {
    display_name: s.display_name,
    base_url: s.base_url,
    enabled: s.enabled,
    notes: s.notes,
    staleness_ttl_hours: s.staleness_ttl_hours,
  }
}
function cancelEdit(id: number) {
  delete editing.value[id]
  delete editForm.value[id]
}
async function saveEdit(s: ListingSource) {
  const patch = editForm.value[s.id]
  if (!patch) return
  try {
    const ttl = Math.max(
      1,
      Math.min(8760, Math.trunc(Number(patch.staleness_ttl_hours)) || s.staleness_ttl_hours),
    )
    const { data, error } = await (supabase as any)
      .from('listing_sources')
      .update({
        display_name: patch.display_name?.trim() || s.display_name,
        base_url: patch.base_url?.trim() || null,
        enabled: !!patch.enabled,
        notes: patch.notes?.trim() || null,
        staleness_ttl_hours: ttl,
      })
      .eq('id', s.id)
      .select('*')
      .single()
    if (error) throw error
    Object.assign(s, data as ListingSource)
    cancelEdit(s.id)
    showToast({ title: 'Updated', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.message || 'Failed to save',
      icon: 'error',
    })
  }
}

function toggleSecret(id: number) {
  if (showSecretFor.value.has(id)) showSecretFor.value.delete(id)
  else showSecretFor.value.add(id)
  // Trigger reactivity on the Set.
  showSecretFor.value = new Set(showSecretFor.value)
}

async function toggleRuns(id: number) {
  if (runsOpen.value.has(id)) {
    runsOpen.value.delete(id)
    runsOpen.value = new Set(runsOpen.value)
    return
  }
  runsOpen.value.add(id)
  runsOpen.value = new Set(runsOpen.value)

  // Lazy-load on first open.
  if (runs.value[id]) return
  runsLoading.value[id] = true
  try {
    const res = await $fetch<{ data: IngestRun[] }>(
      `/api/admin/listing-sources/${id}/runs`,
      { query: { limit: 10 } },
    )
    runs.value[id] = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load runs',
      icon: 'error',
    })
    runs.value[id] = []
  } finally {
    delete runsLoading.value[id]
  }
}

async function rotate(s: ListingSource) {
  if (rotating.value[s.id]) return
  if (!window.confirm(
    `Rotate the ingest secret for "${s.slug}"?\n\nThe old secret will stop working immediately. Update your scraper before rotating.`,
  )) return
  rotating.value[s.id] = true
  try {
    const { data, error } = await (supabase as any).rpc(
      'rotate_listing_source_secret',
      { p_id: s.id },
    )
    if (error) throw error
    const newSecret = String(data)
    s.ingest_secret = newSecret
    oneTimeSecret.value = { slug: s.slug, secret: newSecret }
  } catch (err: any) {
    showToast({
      title: err?.message || 'Failed to rotate',
      icon: 'error',
    })
  } finally {
    delete rotating.value[s.id]
  }
}

async function copyToClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    showToast({ title: 'Copied', icon: 'success' })
  } catch {
    showToast({ title: 'Copy failed — select and copy manually.', icon: 'warning' })
  }
}

const isEmpty = computed(() => !loading.value && sources.value.length === 0)

onMounted(load)
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold text-foreground">External listing sources</h2>
        <p class="text-sm text-muted-foreground">
          Partner / MLS feeds that POST listings to
          <code class="text-xs">/api/admin/listings/ingest</code> with their
          per-source <code class="text-xs">x-source-secret</code>.
        </p>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground/80 hover:bg-muted-foreground/5"
          :disabled="loading"
          @click="load"
        >
          Refresh
        </button>
        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring"
          @click="startCreate"
        >
          New source
        </button>
      </div>
    </div>

    <!-- Create form -->
    <div
      v-if="showCreate"
      class="mb-4 rounded-lg border border-border bg-card p-4"
    >
      <h3 class="text-sm font-semibold text-foreground mb-3">New source</h3>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="block text-sm">
          <span class="text-foreground/80">Slug (machine name)</span>
          <input
            v-model="createForm.slug"
            type="text"
            placeholder="mls_xyz"
            class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <label class="block text-sm">
          <span class="text-foreground/80">Display name</span>
          <input
            v-model="createForm.display_name"
            type="text"
            placeholder="MLS XYZ"
            class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <label class="block text-sm sm:col-span-2">
          <span class="text-foreground/80">Base URL (optional)</span>
          <input
            v-model="createForm.base_url"
            type="url"
            placeholder="https://example.com"
            class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <label class="block text-sm sm:col-span-2">
          <span class="text-foreground/80">Notes (optional)</span>
          <textarea
            v-model="createForm.notes"
            rows="2"
            class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
        <label class="block text-sm sm:col-span-2">
          <span class="text-foreground/80">
            Staleness TTL (hours)
            <span class="text-muted-foreground/70">— auto-archive listings not re-observed within this window. Default 168 (7 days).</span>
          </span>
          <input
            v-model.number="createForm.staleness_ttl_hours"
            type="number"
            min="1"
            max="8760"
            step="1"
            class="mt-1 w-32 rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </label>
      </div>
      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
          :disabled="creating"
          @click="createSource"
        >
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
        <button
          type="button"
          class="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground/80 hover:bg-muted-foreground/5"
          @click="showCreate = false"
        >
          Cancel
        </button>
      </div>
    </div>

    <!-- Loading / empty -->
    <div
      v-if="loading"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      Loading sources…
    </div>
    <div
      v-else-if="isEmpty"
      class="rounded-lg border border-border bg-card p-5 text-center text-sm text-muted-foreground"
    >
      No sources yet. Create one to start receiving partner ingestions.
    </div>

    <!-- Rows -->
    <ul v-else class="space-y-3">
      <li
        v-for="s in sources"
        :key="s.id"
        class="rounded-lg border border-border bg-card p-4"
      >
        <!-- View mode -->
        <div v-if="!editing[s.id]">
          <div class="flex items-baseline gap-2 flex-wrap">
            <p class="text-sm font-semibold text-foreground">
              {{ s.display_name }}
            </p>
            <code class="text-xs text-muted-foreground">{{ s.slug }}</code>
            <span
              class="ml-1 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
              :class="
                s.enabled
                  ? 'bg-success/15 text-success'
                  : 'bg-muted-foreground/10 text-foreground/80'
              "
            >
              {{ s.enabled ? 'Enabled' : 'Disabled' }}
            </span>
            <span
              v-if="s.last_ingested_at"
              class="text-xs text-muted-foreground"
            >
              · last ingested {{ new Date(s.last_ingested_at).toLocaleString() }}
            </span>
            <span
              v-else
              class="text-xs text-muted-foreground/70"
            >
              · never ingested
            </span>
          </div>

          <p v-if="s.base_url" class="mt-1 text-xs text-muted-foreground">
            <a :href="s.base_url" target="_blank" rel="noopener noreferrer" class="hover:underline">
              {{ s.base_url }}
            </a>
          </p>
          <p v-if="s.notes" class="mt-1 text-xs text-muted-foreground">{{ s.notes }}</p>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <span class="text-xs text-muted-foreground">Ingest secret:</span>
            <code
              class="rounded bg-muted-foreground/5 px-2 py-1 text-xs font-mono text-foreground select-all"
            >
              {{ showSecretFor.has(s.id) ? s.ingest_secret : '••••••••••••••••••••••••' }}
            </code>
            <button
              type="button"
              class="text-xs text-primary hover:underline"
              @click="toggleSecret(s.id)"
            >
              {{ showSecretFor.has(s.id) ? 'Hide' : 'Reveal' }}
            </button>
            <button
              v-if="showSecretFor.has(s.id)"
              type="button"
              class="text-xs text-primary hover:underline"
              @click="copyToClipboard(s.ingest_secret)"
            >
              Copy
            </button>
            <button
              type="button"
              class="text-xs text-warning hover:underline"
              :disabled="!!rotating[s.id]"
              @click="rotate(s)"
            >
              {{ rotating[s.id] ? 'Rotating…' : 'Rotate' }}
            </button>
            <button
              type="button"
              class="text-xs text-muted-foreground hover:underline"
              @click="toggleRuns(s.id)"
            >
              {{ runsOpen.has(s.id) ? 'Hide runs' : 'View runs' }}
            </button>
            <button
              type="button"
              class="ml-auto rounded-md border border-border bg-card px-3 py-1 text-xs font-semibold text-foreground/80 hover:bg-muted-foreground/5"
              @click="startEdit(s)"
            >
              Edit
            </button>
          </div>

          <!-- Recent ingest runs (lazy-loaded). -->
          <div v-if="runsOpen.has(s.id)" class="mt-3 border-t border-border pt-3">
            <div v-if="runsLoading[s.id]" class="text-xs text-muted-foreground/70">
              Loading runs…
            </div>
            <div
              v-else-if="(runs[s.id] ?? []).length === 0"
              class="text-xs text-muted-foreground/70"
            >
              No ingest runs recorded yet.
            </div>
            <ul v-else class="space-y-1 text-xs">
              <li
                v-for="r in runs[s.id]"
                :key="r.id"
                class="flex items-baseline gap-2 flex-wrap"
              >
                <span class="text-muted-foreground/70 shrink-0">
                  {{ new Date(r.created_at).toLocaleString() }}
                </span>
                <span class="text-ink-900">
                  {{ r.processed }} processed ·
                  <span class="text-success">{{ r.inserted }} new</span> ·
                  <span class="text-primary">{{ r.updated }} updated</span>
                  <span
                    v-if="r.errors_count > 0"
                    class="ml-1 text-destructive"
                  >· {{ r.errors_count }} errors</span>
                </span>
                <span class="ml-auto text-[10px] text-muted-foreground/70">
                  {{ r.triggered_by }}
                  <span v-if="r.duration_ms != null"> · {{ r.duration_ms }}ms</span>
                </span>
              </li>
            </ul>
          </div>
        </div>

        <!-- Edit mode -->
        <div v-else class="space-y-2">
          <code class="text-xs text-muted-foreground">{{ s.slug }}</code>
          <label class="block text-sm">
            <span class="text-foreground/80">Display name</span>
            <input
              v-model="editForm[s.id]!.display_name"
              type="text"
              class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </label>
          <label class="block text-sm">
            <span class="text-foreground/80">Base URL</span>
            <input
              v-model="editForm[s.id]!.base_url"
              type="url"
              class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </label>
          <label class="inline-flex items-center gap-2 text-sm">
            <input
              v-model="editForm[s.id]!.enabled"
              type="checkbox"
              class="rounded border-border"
            />
            <span class="text-foreground/80">Enabled</span>
          </label>
          <label class="block text-sm">
            <span class="text-foreground/80">Staleness TTL (hours)</span>
            <input
              v-model.number="editForm[s.id]!.staleness_ttl_hours"
              type="number"
              min="1"
              max="8760"
              step="1"
              class="mt-1 w-32 rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </label>
          <label class="block text-sm">
            <span class="text-foreground/80">Notes</span>
            <textarea
              v-model="editForm[s.id]!.notes"
              rows="2"
              class="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </label>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-ring"
              @click="saveEdit(s)"
            >
              Save
            </button>
            <button
              type="button"
              class="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground/80 hover:bg-muted-foreground/5"
              @click="cancelEdit(s.id)"
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    </ul>

    <!-- One-time secret — Phase 6 Operations primitive (persistent: secret shown once) -->
    <UiModal
      :open="!!oneTimeSecret"
      :title="oneTimeSecret ? `New ingest secret for &quot;${oneTimeSecret.slug}&quot;` : ''"
      subtitle="Copy this value and store it securely. It's the only time we'll show it in plain text — future reveals come from the underlying row, but rotation invalidates the previous value immediately."
      width="lg"
      persistent
      @update:open="(v) => { if (!v) oneTimeSecret = null }"
    >
      <div v-if="oneTimeSecret" class="rounded-md border border-border bg-surface-2 p-3">
        <code class="text-xs font-mono text-foreground break-all select-all">
          {{ oneTimeSecret.secret }}
        </code>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="btn-secondary"
            @click="copyToClipboard(oneTimeSecret!.secret)"
          >
            Copy
          </button>
          <button
            type="button"
            class="btn-primary"
            @click="oneTimeSecret = null"
          >
            Done
          </button>
        </div>
      </template>
    </UiModal>
  </div>
</template>
