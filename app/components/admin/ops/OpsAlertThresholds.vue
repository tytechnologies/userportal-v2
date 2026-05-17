<script setup lang="ts">
/**
 * Admin-tunable alert thresholds for /admin/operations.
 *
 * Reads /api/admin/ops/alert-thresholds, lets the operator edit
 * each value inline, and PUTs the diff. Only edited rows are sent
 * back — server-side allowlist + range caps prevent typos / runaway
 * values.
 *
 * Why a small custom form instead of a generic settings page: there
 * are exactly 4 knobs (today), they're cohesive (alert noise floor),
 * and the operator's mental model is "tune what I'm getting paged
 * about." Putting them next to the alert feed keeps that loop tight.
 */
import { computed, onMounted, ref } from 'vue'
import { showToast } from '~/helpers/helpers'

type Threshold = {
  key: string
  value_int: number
  description: string
  updated_at: string
  updated_by: string | null
}

const items = ref<Threshold[]>([])
const drafts = ref<Record<string, number>>({})
const loading = ref(true)
const saving = ref(false)
const errorMsg = ref<string | null>(null)

async function load() {
  loading.value = true
  errorMsg.value = null
  try {
    const res = await $fetch<{ thresholds: Threshold[] }>(
      '/api/admin/ops/alert-thresholds',
    )
    items.value = res.thresholds || []
    // Reset drafts to current server values.
    drafts.value = Object.fromEntries(
      items.value.map((t) => [t.key, t.value_int]),
    )
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to load thresholds'
    showToast({ title: errorMsg.value ?? '', icon: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(load)

const dirtyKeys = computed(() =>
  items.value
    .filter((t) => drafts.value[t.key] !== t.value_int)
    .map((t) => t.key),
)

const isDirty = computed(() => dirtyKeys.value.length > 0)

async function save() {
  if (!isDirty.value) return
  saving.value = true
  try {
    const updates = dirtyKeys.value.map((key) => ({
      key,
      value_int: Number(drafts.value[key]),
    }))
    await $fetch('/api/admin/ops/alert-thresholds', {
      method: 'PUT',
      body: { updates },
    })
    showToast({
      title: `Saved ${updates.length} threshold${updates.length === 1 ? '' : 's'}`,
      icon: 'success',
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.data?.statusMessage || err?.statusMessage || err?.message || 'Save failed',
      icon: 'error',
    })
  } finally {
    saving.value = false
  }
}

function reset() {
  drafts.value = Object.fromEntries(
    items.value.map((t) => [t.key, t.value_int]),
  )
}

// Pretty-print the unit for the input suffix. Inferred from the key
// suffix so adding a new threshold "foo_seconds" picks up "seconds"
// automatically without touching this map.
function unitFor(key: string): string {
  if (key.endsWith('_minutes')) return 'min'
  if (key.endsWith('_hours')) return 'h'
  if (key.endsWith('_days')) return 'd'
  if (key.endsWith('_seconds')) return 's'
  if (key.endsWith('_failures')) return 'fails'
  return ''
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return d.toLocaleDateString()
}
</script>

<template>
  <section
    class="rounded-xl border border-border bg-background p-4"
    aria-label="Alert thresholds"
  >
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-sm font-semibold text-foreground">Alert thresholds</p>
      <p class="text-xs text-muted-foreground">
        Tune what the dashboard treats as "page worthy." Changes apply
        instantly to the alert feed.
      </p>
    </div>

    <div
      v-if="loading && items.length === 0"
      class="rounded-md border border-border bg-muted/50 p-6 text-center text-xs text-muted-foreground"
    >
      Loading…
    </div>
    <div
      v-else-if="errorMsg"
      class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
    >
      {{ errorMsg }}
    </div>
    <div v-else class="space-y-2">
      <div
        v-for="t in items"
        :key="t.key"
        class="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-3 md:flex-row md:items-center md:gap-3"
      >
        <div class="min-w-0 flex-1">
          <code class="block font-mono text-[11px] font-semibold text-foreground">
            {{ t.key }}
          </code>
          <p class="text-xs text-muted-foreground">{{ t.description }}</p>
          <p
            v-if="t.updated_at"
            class="mt-0.5 text-[10px] text-muted-foreground/70"
          >
            Last changed {{ formatTs(t.updated_at) }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <input
            v-model.number="drafts[t.key]"
            type="number"
            min="1"
            class="w-24 rounded-md border border-border px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
            :class="drafts[t.key] !== t.value_int ? 'border-amber-400 bg-warning/10' : ''"
          />
          <span class="w-8 text-xs text-muted-foreground">{{ unitFor(t.key) }}</span>
        </div>
      </div>

      <div class="flex items-center gap-2 pt-2">
        <button
          type="button"
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!isDirty || saving"
          @click="save"
        >
          {{ saving ? 'Saving…' : `Save ${dirtyKeys.length || ''} change${dirtyKeys.length === 1 ? '' : 's'}` }}
        </button>
        <button
          type="button"
          class="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!isDirty || saving"
          @click="reset"
        >
          Reset
        </button>
        <p v-if="isDirty" class="text-xs text-warning">
          Unsaved: {{ dirtyKeys.join(', ') }}
        </p>
      </div>
    </div>
  </section>
</template>
