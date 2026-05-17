<script setup lang="ts">
/**
 * Slide-over drawer showing the change history for one listing.
 *
 * Reads from /api/listings/[id]/activities (RLS gates visibility — an
 * agent only sees actions on listings they can see). Renders the same
 * timeline entries the inline panel on the listing-detail page uses,
 * plus an expanded field-level diff section for `listing.updated`
 * events whose metadata.changes is populated by the
 * listings_audit_diff trigger (migration 20260507000007).
 *
 * Trigger flow:
 *   ListingsTable row → "History" → emit showHistory(id) →
 *   pages/listings/index.vue → opens this drawer with listingId.
 */
import { ref, computed, watch } from 'vue'
import {
  configFor,
  COLOR_DOT,
  listingFieldLabel,
  listingChangedFields,
} from '~/components/timeline/eventConfig'

type Activity = {
  id: string
  user_id: string | null
  action: string
  entity: string
  entity_id: string | null
  metadata: Record<string, any> | null
  created_at: string
  actor: {
    id?: string | null
    full_name?: string | null
    email?: string | null
    avatar_url?: string | null
  } | null
}

const props = defineProps<{
  open: boolean
  listingId: number | null
}>()

const emit = defineEmits<{
  close: []
}>()

const items = ref<Activity[]>([])
const loading = ref(false)
const errorMsg = ref<string | null>(null)
const expanded = ref<Record<string, boolean>>({})

watch(
  () => [props.open, props.listingId] as const,
  async ([open, id]) => {
    if (!open || !id) return
    items.value = []
    expanded.value = {}
    errorMsg.value = null
    loading.value = true
    try {
      const res = await $fetch<{ data: Activity[] }>(
        `/api/listings/${encodeURIComponent(String(id))}/activities`,
      )
      items.value = res.data ?? []
    } catch (err: any) {
      errorMsg.value =
        err?.statusMessage || err?.message || 'Failed to load history'
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

function close() {
  emit('close')
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// Money / boolean / long-text rendering. The trigger stores raw values
// in jsonb so we get types here directly.
function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return v.toLocaleString()
  const s = String(v)
  if (s.length > 80) return s.slice(0, 80) + '…'
  return s
}

const isEmpty = computed(() => !loading.value && items.value.length === 0)
const hasError = computed(() => !!errorMsg.value)
</script>

<template>
  <!-- Backdrop + slide-over. Tailwind transition-on-mount via v-if so
       the panel animates in/out. Click backdrop or press Escape to
       close. -->
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      <div
        class="absolute inset-0 bg-foreground/50 transition-opacity"
        @click="close"
      />
      <div
        class="absolute right-0 top-0 h-full w-full max-w-md transform bg-card shadow-2xl transition-transform"
        @keydown.esc="close"
      >
        <header class="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 class="text-base font-semibold text-foreground">Change history</h2>
            <p class="text-xs text-muted-foreground">
              Listing #{{ listingId }} ·
              <span v-if="loading">loading…</span>
              <span v-else>{{ items.length }} {{ items.length === 1 ? 'event' : 'events' }}</span>
            </p>
          </div>
          <button
            type="button"
            class="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Close history"
            @click="close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div class="h-[calc(100%-65px)] overflow-y-auto px-5 py-4">
          <div
            v-if="loading"
            class="rounded-lg border border-border bg-muted/50 p-6 text-center text-sm text-muted-foreground"
          >
            Loading…
          </div>

          <div
            v-else-if="hasError"
            class="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
          >
            {{ errorMsg }}
          </div>

          <div
            v-else-if="isEmpty"
            class="rounded-lg border border-border bg-muted/50 p-6 text-center text-sm text-muted-foreground"
          >
            No activity recorded for this listing yet.
            <p class="mt-1 text-xs text-muted-foreground/70">
              Future edits, archives, and assignments will appear here.
            </p>
          </div>

          <ul v-else class="space-y-3">
            <li
              v-for="ev in items"
              :key="ev.id"
              class="rounded-lg border border-border bg-background p-3"
            >
              <div class="flex items-start gap-2">
                <span
                  class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                  :class="COLOR_DOT[configFor(ev.action).color] ?? 'bg-muted'"
                  aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-foreground">
                    <span v-if="configFor(ev.action).icon" aria-hidden="true">
                      {{ configFor(ev.action).icon }}
                    </span>
                    {{ configFor(ev.action).label }}
                  </p>
                  <p
                    v-if="configFor(ev.action).meta?.(ev.metadata ?? {})"
                    class="mt-0.5 text-xs text-muted-foreground"
                  >
                    {{ configFor(ev.action).meta!(ev.metadata ?? {}) }}
                  </p>
                  <p class="mt-0.5 text-xs text-muted-foreground">
                    {{ formatTs(ev.created_at) }}
                    <span v-if="ev.actor?.full_name || ev.actor?.email" class="text-muted-foreground/70">
                      · {{ ev.actor?.full_name || ev.actor?.email }}
                    </span>
                  </p>

                  <!-- Field-level diff for listing.updated. Only render
                       when metadata.changes is populated; expand on
                       demand to keep the timeline scannable. -->
                  <template v-if="ev.action === 'listing.updated' && listingChangedFields(ev.metadata).length > 0">
                    <button
                      type="button"
                      class="mt-2 text-xs font-semibold text-primary hover:underline"
                      @click="expanded[ev.id] = !expanded[ev.id]"
                    >
                      {{ expanded[ev.id] ? 'Hide changes' : `View ${listingChangedFields(ev.metadata).length} ${listingChangedFields(ev.metadata).length === 1 ? 'change' : 'changes'}` }}
                    </button>
                    <dl
                      v-if="expanded[ev.id]"
                      class="mt-2 space-y-1.5 rounded-md bg-muted/50 p-2 text-xs"
                    >
                      <div
                        v-for="col in listingChangedFields(ev.metadata)"
                        :key="col"
                        class="grid grid-cols-[6rem_1fr] gap-2"
                      >
                        <dt class="font-semibold text-foreground">
                          {{ listingFieldLabel(col) }}
                        </dt>
                        <dd class="min-w-0 break-words text-foreground">
                          <span class="text-destructive line-through">
                            {{ fmtValue(ev.metadata?.changes?.[col]?.from) }}
                          </span>
                          <span class="mx-1 text-muted-foreground/70">→</span>
                          <span class="text-success">
                            {{ fmtValue(ev.metadata?.changes?.[col]?.to) }}
                          </span>
                        </dd>
                      </div>
                    </dl>
                  </template>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Teleport>
</template>
