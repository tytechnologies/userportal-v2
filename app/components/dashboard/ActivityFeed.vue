<script setup lang="ts">
// Org activity feed. Reads from /api/dashboard/activity which queries
// the audit `activities` table; RLS scopes to what the caller can see
// (own actions for agents, team for managers, all for admins).
//
// Each event renders as "<actor> · <action> · <relative time>" with a
// colored dot keyed off the action's entity prefix (listing.* /
// contact.* / document.* / task.*). Click-through is deferred — the
// audit row's metadata.* (contact_id, listing_id, draft_id) is the
// hook for navigation but the action labels alone are enough for
// the at-a-glance feed; deep links land in Phase B.

import { onMounted, ref, watch } from 'vue'
import { useDashboardFilter } from '~/composables/useDashboardFilter'

type ActivityRow = {
  id: string
  action: string
  entity: string
  created_at: string
  actor: { id: string; full_name: string | null; avatar_url: string | null } | null
  metadata: Record<string, unknown> | null
}

const filter = useDashboardFilter()
const events = ref<ActivityRow[]>([])
const isLoading = ref(true)

async function load() {
  isLoading.value = true
  try {
    const res = await $fetch<{ data: ActivityRow[] }>('/api/dashboard/activity', {
      query: { limit: 15, from: filter.fromIso.value, to: filter.toIso.value },
    })
    events.value = res?.data ?? []
  } catch {
    events.value = []
  } finally {
    isLoading.value = false
  }
}

onMounted(load)
watch(() => filter.watchKey.value, load)

// Glyph + color + phrasing per action verb. Adding the new doc-system
// + pipeline verbs here so they read naturally instead of "exported a
// document_draft" / "stage_changed a deal". Anything not in the table
// falls back to the auto verb→entity formatter below — same result as
// before, just better hits for the verbs the platform fires today.
type ActionMeta = {
  glyph: string
  tone: 'primary' | 'success' | 'warning' | 'destructive' | 'muted'
  label: string
}
const ACTION_META: Record<string, ActionMeta> = {
  // Pipeline
  'deal.created':                    { glyph: '◇', tone: 'primary',     label: 'opened a new deal' },
  'deal.stage_changed':              { glyph: '→', tone: 'primary',     label: 'moved a deal to a new stage' },
  'deal.closed_won':                 { glyph: '★', tone: 'success',     label: 'closed a deal — won' },
  'deal.closed_lost':                { glyph: '⨯', tone: 'destructive', label: 'closed a deal — lost' },
  'viewing.scheduled':               { glyph: '◷', tone: 'primary',     label: 'scheduled a viewing' },
  'viewing.completed':               { glyph: '✓', tone: 'success',     label: 'completed a viewing' },
  'inquiry.received':                { glyph: '✉', tone: 'primary',     label: 'received a new inquiry' },
  'inquiry.assigned':                { glyph: '→', tone: 'muted',       label: 'reassigned an inquiry' },
  'inquiry.converted_to_deal':       { glyph: '◇', tone: 'success',     label: 'converted an inquiry to a deal' },

  // Documents
  'document_draft.created':          { glyph: '✎', tone: 'primary',     label: 'started a new document draft' },
  'document_draft.submitted':        { glyph: '◷', tone: 'warning',     label: 'submitted a draft for review' },
  'document_draft.approval_requested': { glyph: '◷', tone: 'warning',   label: 'requested approval on a draft' },
  'document_draft.approved':         { glyph: '✓', tone: 'success',     label: 'approved a document' },
  'document_draft.rejected':         { glyph: '⨯', tone: 'destructive', label: 'rejected a document' },
  'document_draft.exported':         { glyph: '⤓', tone: 'primary',     label: 'exported a document' },
  'document_draft.signed':           { glyph: '★', tone: 'success',     label: 'finalized a signed document' },
  'document_draft.validated':        { glyph: '✓', tone: 'success',     label: 'passed document validation' },
  'transaction_room.created':        { glyph: '⌂', tone: 'primary',     label: 'opened a transaction room' },
  'transaction_room.closed':         { glyph: '✓', tone: 'muted',       label: 'closed a transaction room' },
  'docusign.envelope_sent':          { glyph: '⇄', tone: 'primary',     label: 'sent an envelope for e-signature' },
  'docusign.envelope_completed':     { glyph: '★', tone: 'success',     label: 'collected all signatures' },
  'docusign.envelope_declined':      { glyph: '⨯', tone: 'destructive', label: 'had an envelope declined' },
  'clause.created':                  { glyph: '✎', tone: 'primary',     label: 'added a clause to the library' },
  'clause.revised':                  { glyph: '✎', tone: 'primary',     label: 'revised a clause' },

  // CRM
  'listing.created':                 { glyph: '⌂', tone: 'primary',     label: 'created a listing' },
  'listing.published':               { glyph: '★', tone: 'success',     label: 'published a listing' },
  'listing.archived':                { glyph: '⨯', tone: 'muted',       label: 'archived a listing' },
  'listing.shared':                  { glyph: '⇄', tone: 'primary',     label: 'shared a listing' },
  'listing.note_added':              { glyph: '✎', tone: 'muted',       label: 'left a note on a listing' },
  'contact.created':                 { glyph: '◇', tone: 'primary',     label: 'added a new contact' },
  'contact.note_added':              { glyph: '✎', tone: 'muted',       label: 'left a note on a contact' },
  'contact.merged':                  { glyph: '⇄', tone: 'muted',       label: 'merged duplicate contacts' },

  // System
  'task.assigned':                   { glyph: '✓', tone: 'primary',     label: 'assigned a task' },
  'task.completed':                  { glyph: '✓', tone: 'success',     label: 'completed a task' },
  'verification.submitted':          { glyph: '◷', tone: 'warning',     label: 'submitted for verification' },
  'verification.approved':           { glyph: '★', tone: 'success',     label: 'verified an account' },
  'verification.rejected':           { glyph: '⨯', tone: 'destructive', label: 'rejected a verification' },
}

const TONE_DOT: Record<ActionMeta['tone'], string> = {
  primary:     'bg-primary',
  success:     'bg-success',
  warning:     'bg-warning',
  destructive: 'bg-destructive',
  muted:       'bg-muted-foreground/40',
}
const TONE_GLYPH: Record<ActionMeta['tone'], string> = {
  primary:     'bg-primary/10 text-primary',
  success:     'bg-success/10 text-success',
  warning:     'bg-warning/10 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
  muted:       'bg-muted text-muted-foreground',
}

function metaFor(action: string): ActionMeta {
  const explicit = ACTION_META[action]
  if (explicit) return explicit
  // Fallback: same verb→entity formatter the feed used before this
  // table existed. The dot is muted unless the entity is "listing"
  // (the platform's main object).
  const parts = action.split('.')
  const entity = parts[0] ?? ''
  const verb = parts[1] ?? ''
  const article = /^[aeiou]/i.test(entity) ? 'an' : 'a'
  return {
    glyph: '•',
    tone: entity === 'listing' ? 'primary' : 'muted',
    label: verb
      ? `${verb.replace(/_/g, ' ')} ${article} ${entity.replace(/_/g, ' ')}`
      : action,
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}
</script>

<template>
  <section
    class="flex h-full flex-col ui-card"
    aria-label="Activity feed"
  >
    <header class="border-b border-border px-5 py-4">
      <h3 class="text-sm font-semibold text-foreground">Activity</h3>
      <p class="mt-0.5 text-xs text-muted-foreground">
        Latest events across the portal
      </p>
    </header>

    <div v-if="isLoading" class="space-y-3 p-5">
      <div v-for="n in 5" :key="n" class="flex items-start gap-3">
        <span class="mt-1.5 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/30" />
        <div class="flex-1 space-y-1">
          <Skeleton class="h-3 w-2/3" />
          <Skeleton class="h-2 w-1/3" />
        </div>
      </div>
    </div>

    <EmptyState
      v-else-if="events.length === 0"
      variant="neutral"
      size="cozy"
      title="No activity yet"
      description="Events from the team — listings, contacts, tasks, documents — will surface here."
    />

    <ul v-else class="max-h-[28rem] divide-y divide-border overflow-y-auto">
      <li v-for="e in events" :key="e.id" class="flex items-start gap-3 px-5 py-3">
        <span
          :class="[
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs',
            TONE_GLYPH[metaFor(e.action).tone],
          ]"
          aria-hidden="true"
        >
          {{ metaFor(e.action).glyph }}
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm text-foreground/90">
            <span class="font-medium text-foreground">{{ e.actor?.full_name || 'Someone' }}</span>
            <span class="text-muted-foreground"> {{ metaFor(e.action).label }}</span>
          </p>
          <p class="text-xs text-muted-foreground/80">{{ relativeTime(e.created_at) }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>
