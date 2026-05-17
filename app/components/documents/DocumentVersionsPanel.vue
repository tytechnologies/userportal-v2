<script setup lang="ts">
/**
 * Versions panel for the draft detail page. Shows the snapshot
 * timeline + lets the broker mint a new snapshot.
 *
 * Snapshots are the durable history — every approval request, every
 * "before sending to the lawyer" moment, every revision. They're
 * append-only on the server (the migration enforces no UPDATE/DELETE
 * policy) so versioning is genuinely a paper trail.
 *
 * The diff viewer is a separate component (DocumentDiffViewer) that
 * this panel delegates to via emit when the user picks two versions
 * to compare.
 */
import { onMounted, ref, watch } from 'vue'
import { showToast } from '~/helpers/helpers'
import UiBadge from '~/components/ui/UiBadge.vue'

type Version = {
  id: string
  draft_id: string
  version_number: number
  snapshot_body: string | null
  label: string | null
  created_at: string
  created_by: { id: string; full_name: string | null; avatar_url: string | null } | null
}

const props = defineProps<{
  draftId: string
}>()

const emit = defineEmits<{
  /** Compare two versions. Parent renders the DocumentDiffViewer. */
  (e: 'compare', a: Version, b: Version): void
}>()

const versions = ref<Version[]>([])
const loading = ref(false)
const minting = ref(false)
const newLabel = ref('')

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Version[] }>(`/api/document-drafts/${props.draftId}/versions`)
    versions.value = res.data ?? []
  } catch {
    versions.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.draftId, load)

async function snapshot() {
  if (minting.value) return
  minting.value = true
  try {
    await $fetch(`/api/document-drafts/${props.draftId}/versions`, {
      method: 'POST',
      body: { label: newLabel.value.trim() || undefined },
    })
    newLabel.value = ''
    await load()
    showToast({ title: 'Version snapshotted', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Snapshot failed',
      icon: 'error',
    })
  } finally {
    minting.value = false
  }
}

// Compare picker — broker selects two versions then clicks "Compare".
// Most-recent + previous is the common case so we pre-select that
// when at least 2 versions exist.
const pickedA = ref<string | null>(null)
const pickedB = ref<string | null>(null)
watch(versions, (vs) => {
  if (vs.length >= 2 && !pickedA.value && !pickedB.value) {
    pickedA.value = vs[1]?.id ?? null   // older
    pickedB.value = vs[0]?.id ?? null   // newer
  }
})

function compare() {
  const a = versions.value.find((v) => v.id === pickedA.value)
  const b = versions.value.find((v) => v.id === pickedB.value)
  if (!a || !b || a.id === b.id) {
    showToast({ title: 'Pick two different versions', icon: 'error' })
    return
  }
  emit('compare', a, b)
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
</script>

<template>
  <section class="ui-card p-4">
    <header class="mb-3 flex items-baseline justify-between gap-2">
      <div>
        <h3 class="text-card-title">Versions</h3>
        <p class="mt-0.5 text-meta">
          Append-only snapshots. Every approval is anchored to a
          version, so "what was approved when" is always answerable.
        </p>
      </div>
    </header>

    <!-- Snapshot composer -->
    <form
      class="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3"
      @submit.prevent="snapshot"
    >
      <input
        v-model="newLabel"
        type="text"
        maxlength="80"
        placeholder="Optional label (e.g. pre-notary, post-revisions)"
        class="min-w-[180px] flex-1 rounded-md border border-input bg-card px-3 py-1.5 text-xs focus:outline-none focus:border-primary focus:ring-2 focus:ring-ring/25"
      />
      <button
        type="submit"
        class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent focus-ring disabled:opacity-50"
        :disabled="minting"
      >
        {{ minting ? 'Snapshotting…' : '+ Snapshot now' }}
      </button>
    </form>

    <p
      v-if="loading"
      class="text-xs text-muted-foreground"
    >
      Loading versions…
    </p>
    <p
      v-else-if="versions.length === 0"
      class="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-xs text-muted-foreground"
    >
      No snapshots yet. Snapshot before requesting approval so reviewers
      see exactly the version you intended.
    </p>

    <ul v-else class="space-y-1.5">
      <li
        v-for="v in versions"
        :key="v.id"
        class="flex flex-wrap items-baseline gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
      >
        <UiBadge variant="neutral" size="xs">v{{ v.version_number }}</UiBadge>
        <span v-if="v.label" class="font-semibold text-foreground">{{ v.label }}</span>
        <span v-else class="italic text-muted-foreground">untitled</span>
        <span class="text-[11px] text-muted-foreground">
          by {{ v.created_by?.full_name || 'someone' }} · {{ relativeTime(v.created_at) }}
        </span>
      </li>
    </ul>

    <!-- Compare picker — only shown when ≥2 versions exist. -->
    <div
      v-if="versions.length >= 2"
      class="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"
    >
      <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Compare
      </span>
      <select
        v-model="pickedA"
        class="rounded-md border border-input bg-card px-2 py-1.5 text-xs"
      >
        <option v-for="v in versions" :key="v.id" :value="v.id">
          v{{ v.version_number }}{{ v.label ? ` · ${v.label}` : '' }}
        </option>
      </select>
      <span aria-hidden="true" class="text-muted-foreground">→</span>
      <select
        v-model="pickedB"
        class="rounded-md border border-input bg-card px-2 py-1.5 text-xs"
      >
        <option v-for="v in versions" :key="v.id" :value="v.id">
          v{{ v.version_number }}{{ v.label ? ` · ${v.label}` : '' }}
        </option>
      </select>
      <button
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-ring"
        @click="compare"
      >
        Compare
      </button>
    </div>
  </section>
</template>
