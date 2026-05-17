<script setup lang="ts">
/**
 * Notifications inbox.
 *
 * The bell in the navbar (NotificationBell.vue) shows the most-recent
 * unread items. This page is the full archive: paginated history,
 * filterable by status + kind, with mark-as-read / dismiss / mark-all
 * actions.
 *
 * All data via /api/notifications/* — no direct Supabase calls.
 * Auth: required (the global auth.global.ts middleware redirects
 * unauthenticated visitors to /login before this page mounts).
 */
import { ref, computed, onMounted, watch } from 'vue'
import {
  useNotifications,
  type Notification,
} from '~/composables/useNotifications'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Notifications | Housinginteractive' })

const { listNotifications, markRead, markUnread, dismiss, markAllRead } =
  useNotifications()

const PAGE_SIZE = 20

type StatusFilter = 'all' | 'unread' | 'read'
const status = ref<StatusFilter>('all')
const kindFilter = ref('')
const page = ref(1)

const items = ref<Notification[]>([])
const total = ref(0)
const unreadCount = ref(0)
const totalPages = ref(1)

const loading = ref(true)
const refreshing = ref(false)
const updating = ref<Record<string, boolean>>({})

async function load() {
  refreshing.value = true
  try {
    const res = await listNotifications({
      page: page.value,
      pageSize: PAGE_SIZE,
      unread: status.value === 'unread' || undefined,
      kind: kindFilter.value.trim() || undefined,
    })
    items.value = res.data
    total.value = res.total
    unreadCount.value = res.unread_count
    totalPages.value = res.total_pages || 1

    // The "read" filter isn't directly supported by the API
    // (only `unread: true` is). Apply it client-side on the page slice.
    if (status.value === 'read') {
      items.value = items.value.filter((n) => n.read_at != null)
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load notifications',
      icon: 'error',
    })
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

watch([status, kindFilter, page], load)
onMounted(load)

function changePage(next: number) {
  if (next < 1 || next > totalPages.value) return
  page.value = next
}

async function onToggleRead(n: Notification) {
  if (updating.value[n.id]) return
  updating.value[n.id] = true
  try {
    if (n.read_at) {
      const updated = await markUnread(n.id)
      Object.assign(n, updated)
      unreadCount.value += 1
    } else {
      const updated = await markRead(n.id)
      Object.assign(n, updated)
      unreadCount.value = Math.max(0, unreadCount.value - 1)
    }
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to update',
      icon: 'error',
    })
  } finally {
    delete updating.value[n.id]
  }
}

async function onDismiss(n: Notification) {
  if (updating.value[n.id]) return
  // Optimistic remove with restore on failure.
  const prevIndex = items.value.findIndex((x) => x.id === n.id)
  if (prevIndex < 0) return
  const removed = items.value[prevIndex]!
  items.value.splice(prevIndex, 1)
  total.value = Math.max(0, total.value - 1)
  if (!removed.read_at) unreadCount.value = Math.max(0, unreadCount.value - 1)

  updating.value[n.id] = true
  try {
    await dismiss(n.id)
  } catch (err: any) {
    items.value.splice(prevIndex, 0, removed)
    total.value += 1
    if (!removed.read_at) unreadCount.value += 1
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to dismiss',
      icon: 'error',
    })
  } finally {
    delete updating.value[n.id]
  }
}

async function onMarkAllRead() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const res = await markAllRead()
    showToast({
      title: `Marked ${res.updated} as read`,
      icon: 'success',
    })
    await load()
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to mark all',
      icon: 'error',
    })
  } finally {
    refreshing.value = false
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

// Compact kind → glyph map. Anything not in the map renders the
// generic dot. Keeps the icon strip readable without dragging in a
// font/icon library. Includes the new doc-system + pipeline kinds
// so the inbox matches the verbs the rest of the platform uses.
const kindGlyph: Record<string, string> = {
  'task.assigned':                 '✓',
  'contact.note_added':            '✎',
  'listing.note_added':            '✎',
  'listing.shared':                '⇄',
  'listing.inquiry_received':      '✉',
  'verification.submitted':        '◷',
  'verification.approved':         '★',
  'verification.rejected':         '⨯',
  // Pipeline
  'deal.created':                  '◇',
  'deal.stage_changed':            '→',
  'deal.closed_won':               '★',
  'deal.closed_lost':              '⨯',
  'viewing.scheduled':             '◷',
  'viewing.completed':             '✓',
  'inquiry.new':                   '✉',
  // Documents
  'document_draft.created':        '✎',
  'document_draft.submitted':      '◷',
  'document_draft.approval_requested': '◷',
  'document_draft.approved':       '✓',
  'document_draft.rejected':       '⨯',
  'document_draft.exported':       '⤓',
  'document_draft.signed':         '★',
  'transaction_room.created':      '⌂',
  'transaction_room.message':      '✉',
  'docusign.envelope_sent':        '⇄',
  'docusign.envelope_completed':   '★',
  'docusign.envelope_declined':    '⨯',
}
function glyphFor(kind: string): string {
  return kindGlyph[kind] || '•'
}

// Classify a notification's kind into one of four domains so the
// inbox can group + filter by what part of the platform a notice
// came from. Any new domain prefix automatically falls into 'system'
// until it gets a rule here.
type Domain = 'pipeline' | 'documents' | 'crm' | 'system'
function domainOf(kind: string): Domain {
  if (
    kind.startsWith('deal.')
    || kind.startsWith('viewing.')
    || kind.startsWith('inquiry.')
  ) return 'pipeline'
  if (
    kind.startsWith('document')
    || kind.startsWith('transaction_room.')
    || kind.startsWith('docusign.')
    || kind.startsWith('clause.')
  ) return 'documents'
  if (
    kind.startsWith('contact.')
    || kind.startsWith('listing.')
  ) return 'crm'
  return 'system'
}

const DOMAIN_LABELS: Record<Domain, string> = {
  pipeline:  'Pipeline',
  documents: 'Documents',
  crm:       'CRM',
  system:    'System',
}
const DOMAIN_ORDER: Domain[] = ['pipeline', 'documents', 'crm', 'system']

type DomainFilter = 'all' | Domain
const domain = ref<DomainFilter>('all')
watch(domain, () => { page.value = 1 })

// Apply the domain filter client-side over the page slice the API
// returned. Server-side filtering would be more correct under heavy
// pagination, but the API doesn't currently expose a domain knob and
// adding one is a bigger lift than this UX needs.
const filteredByDomain = computed(() => {
  if (domain.value === 'all') return items.value
  return items.value.filter((n) => domainOf(n.kind) === domain.value)
})

// Per-domain counts for the filter chips. Computed against the
// currently-loaded page so the numbers reflect "what's visible on
// this page" rather than the full inbox — avoids a second API call.
const domainCounts = computed(() => {
  const out: Record<Domain, number> = { pipeline: 0, documents: 0, crm: 0, system: 0 }
  for (const n of items.value) out[domainOf(n.kind)] += 1
  return out
})

// Group rendering: when no narrowing filters are active, group the
// page slice by domain so the inbox reads as four discrete sections
// rather than one long mixed scroll. Otherwise stay flat — the user
// has already narrowed by intent.
const showGrouped = computed(() =>
  status.value === 'all' && domain.value === 'all' && !kindFilter.value.trim(),
)

const groupedItems = computed(() => {
  const groups: Record<Domain, Notification[]> = { pipeline: [], documents: [], crm: [], system: [] }
  for (const n of items.value) groups[domainOf(n.kind)].push(n)
  return DOMAIN_ORDER
    .map((d) => ({ domain: d, label: DOMAIN_LABELS[d], items: groups[d] }))
    .filter((g) => g.items.length > 0)
})

const isEmpty = computed(() => !loading.value && filteredByDomain.value.length === 0)
</script>

<template>
  <div class="min-h-screen bg-card">
    <div class="container mx-auto max-w-3xl px-4 py-8">
      <header class="mb-6 flex items-baseline gap-3 flex-wrap">
        <h1 class="text-2xl font-bold text-foreground">Notifications</h1>
        <p class="text-sm text-muted-foreground">
          {{ total.toLocaleString() }} total
          <span v-if="unreadCount > 0">· {{ unreadCount }} unread</span>
        </p>
        <div class="ml-auto flex items-center gap-2">
          <button
            v-if="unreadCount > 0"
            type="button"
            class="text-sm font-semibold text-primary hover:underline disabled:opacity-50"
            :disabled="refreshing"
            @click="onMarkAllRead"
          >
            Mark all as read
          </button>
          <button
            type="button"
            class="text-sm text-muted-foreground hover:underline disabled:opacity-50"
            :disabled="refreshing"
            @click="load"
          >
            {{ refreshing ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </header>

      <!-- Filters -->
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <div
          class="inline-flex rounded-md border border-border bg-background p-0.5 text-xs"
          role="tablist"
          aria-label="Notification status"
        >
          <button
            v-for="s in (['all', 'unread', 'read'] as StatusFilter[])"
            :key="s"
            type="button"
            class="px-3 py-1 rounded-md font-semibold transition-colors capitalize"
            :class="
              status === s
                ? 'bg-primary text-white'
                : 'text-muted-foreground hover:bg-muted'
            "
            @click="status = s; page = 1"
          >
            {{ s }}
          </button>
        </div>
        <input
          v-model="kindFilter"
          type="text"
          placeholder="Filter by kind (e.g. task.assigned)"
          class="flex-1 min-w-[200px] rounded-md border border-border px-3 py-1.5 text-sm focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
          @input="page = 1"
        />
      </div>

      <!-- Domain chip strip. Filters the visible items to one of four
           buckets — Pipeline, Documents, CRM, System. Counts reflect
           the current page only (avoids a second API call); for a
           true cross-page tally we'd add a server-side aggregate. -->
      <div class="mb-4 flex flex-wrap items-center gap-1.5">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Domain:</span>
        <button
          type="button"
          class="rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors duration-150 ease-out focus-ring"
          :class="domain === 'all'
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
          @click="domain = 'all'"
        >
          All
        </button>
        <button
          v-for="d in DOMAIN_ORDER"
          :key="d"
          type="button"
          class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors duration-150 ease-out focus-ring"
          :class="domain === d
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
          :disabled="domainCounts[d] === 0"
          @click="domain = d"
        >
          {{ DOMAIN_LABELS[d] }}
          <span
            class="rounded-full px-1.5 py-0 text-[10px] tabular-nums"
            :class="domain === d ? 'bg-primary-foreground/20' : 'bg-card'"
          >
            {{ domainCounts[d] }}
          </span>
        </button>
      </div>

      <!-- Loading -->
      <div
        v-if="loading"
        class="rounded-xl border border-border bg-background p-5 text-center text-sm text-muted-foreground"
      >
        Loading notifications…
      </div>

      <!-- Empty -->
      <div
        v-else-if="isEmpty"
        class="rounded-xl border border-border bg-background p-5 text-center"
      >
        <p class="text-sm font-semibold text-foreground">Nothing to show.</p>
        <p class="mt-1 text-xs text-muted-foreground">
          {{
            status === 'unread'
              ? 'You\'re all caught up.'
              : 'New activity on your listings, contacts, or assignments will appear here.'
          }}
        </p>
      </div>

      <!-- Grouped view (no filters applied). Renders one section per
           non-empty domain so the inbox reads as four buckets rather
           than one long mixed scroll. -->
      <div v-else-if="showGrouped" class="space-y-6">
        <section
          v-for="g in groupedItems"
          :key="g.domain"
        >
          <header class="mb-2 flex items-baseline gap-2">
            <h2 class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {{ g.label }}
            </h2>
            <span class="text-[11px] tabular-nums text-muted-foreground/70">
              {{ g.items.length }}
            </span>
          </header>
          <ul class="space-y-2">
            <li
              v-for="n in g.items"
              :key="n.id"
              class="rounded-xl border bg-card p-4 transition-colors"
              :class="n.read_at ? 'border-border' : 'border-primary/30 bg-primary/10'"
            >
              <div class="flex items-start gap-3">
                <span
                  class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-foreground"
                  aria-hidden="true"
                >
                  {{ glyphFor(n.kind) }}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2 flex-wrap">
                    <p
                      class="text-sm truncate"
                      :class="n.read_at ? 'text-foreground' : 'font-semibold text-foreground'"
                    >
                      {{ n.title }}
                    </p>
                    <span class="text-[11px] text-muted-foreground/70 shrink-0">{{ relativeTime(n.created_at) }}</span>
                    <code class="text-[10px] text-muted-foreground/70 truncate">{{ n.kind }}</code>
                  </div>
                  <p v-if="n.body" class="mt-1 text-sm text-muted-foreground line-clamp-2">{{ n.body }}</p>
                  <div class="mt-2 flex flex-wrap gap-2 text-xs">
                    <NuxtLink v-if="n.href" :to="n.href" class="text-primary hover:underline" @click="!n.read_at && onToggleRead(n)">Open</NuxtLink>
                    <button type="button" class="text-muted-foreground hover:underline disabled:opacity-50" :disabled="!!updating[n.id]" @click="onToggleRead(n)">{{ n.read_at ? 'Mark unread' : 'Mark read' }}</button>
                    <button type="button" class="text-muted-foreground/70 hover:text-destructive hover:underline disabled:opacity-50" :disabled="!!updating[n.id]" @click="onDismiss(n)">Dismiss</button>
                  </div>
                </div>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- Flat list (any filter active). -->
      <ul v-else class="space-y-2">
        <li
          v-for="n in filteredByDomain"
          :key="n.id"
          class="rounded-xl border bg-card p-4 transition-colors"
          :class="
            n.read_at
              ? 'border-border'
              : 'border-primary/30 bg-primary/10'
          "
        >
          <div class="flex items-start gap-3">
            <span
              class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-foreground"
              aria-hidden="true"
            >
              {{ glyphFor(n.kind) }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2 flex-wrap">
                <p
                  class="text-sm truncate"
                  :class="n.read_at ? 'text-foreground' : 'font-semibold text-foreground'"
                >
                  {{ n.title }}
                </p>
                <span class="text-[11px] text-muted-foreground/70 shrink-0">
                  {{ relativeTime(n.created_at) }}
                </span>
                <code class="text-[10px] text-muted-foreground/70 truncate">{{ n.kind }}</code>
              </div>
              <p
                v-if="n.body"
                class="mt-1 text-sm text-muted-foreground line-clamp-2"
              >
                {{ n.body }}
              </p>
              <div class="mt-2 flex flex-wrap gap-2 text-xs">
                <NuxtLink
                  v-if="n.href"
                  :to="n.href"
                  class="text-primary hover:underline"
                  @click="!n.read_at && onToggleRead(n)"
                >
                  Open
                </NuxtLink>
                <button
                  type="button"
                  class="text-muted-foreground hover:underline disabled:opacity-50"
                  :disabled="!!updating[n.id]"
                  @click="onToggleRead(n)"
                >
                  {{ n.read_at ? 'Mark unread' : 'Mark read' }}
                </button>
                <button
                  type="button"
                  class="text-muted-foreground/70 hover:text-destructive hover:underline disabled:opacity-50"
                  :disabled="!!updating[n.id]"
                  @click="onDismiss(n)"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </li>
      </ul>

      <!-- Pagination -->
      <div
        v-if="!loading && totalPages > 1"
        class="mt-6 flex items-center justify-between text-sm"
      >
        <button
          type="button"
          class="rounded-md border border-border bg-background px-3 py-1.5 font-semibold text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          :disabled="page <= 1 || refreshing"
          @click="changePage(page - 1)"
        >
          ← Previous
        </button>
        <span class="text-muted-foreground">
          Page {{ page }} of {{ totalPages }}
        </span>
        <button
          type="button"
          class="rounded-md border border-border bg-background px-3 py-1.5 font-semibold text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          :disabled="page >= totalPages || refreshing"
          @click="changePage(page + 1)"
        >
          Next →
        </button>
      </div>
    </div>
  </div>
</template>
