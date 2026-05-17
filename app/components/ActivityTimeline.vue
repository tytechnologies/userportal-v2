<script setup lang="ts">
// Activity timeline for the listing detail sidebar. There is no
// `activities` table yet, so this component derives entries from
// timestamp columns the listing already exposes:
//   - created_at  → "Listing created"
//   - updated_at  → "Listing updated" (if it differs from created_at)
//   - deleted_at  → "Listing archived"
//
// When a real activities feed lands, the parent can pass an `events`
// prop instead and the component will use it directly. The derived
// fallback path stays for older rows that pre-date the feed.
import { computed } from 'vue'

type RawListing = {
  created_at?: string | null
  updated_at?: string | null
  deleted_at?: string | null
  is_online?: boolean | null
  // Optional: server-provided actor names. Falls back to "—" if absent.
  created_by_name?: string | null
  updated_by_name?: string | null
  // Optional: caller-supplied richer feed (later phase). When present,
  // overrides the derived events.
  events?: TimelineEvent[]
}

export type TimelineEvent = {
  id: string
  kind: 'created' | 'updated' | 'archived' | 'cloned' | 'unarchived'
  // ISO string preferred. Falsy = unknown.
  timestamp: string | null
  actor?: string | null
  // Optional human-readable description. Defaults to a label per kind.
  message?: string
}

const props = defineProps<{
  listing: RawListing | null | undefined
}>()

const formatTimestamp = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  // "Apr 29, 2026 · 11:42 AM" — readable, locale-aware.
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}

const KIND_LABEL: Record<TimelineEvent['kind'], string> = {
  created: 'Listing created',
  updated: 'Listing updated',
  archived: 'Listing archived',
  unarchived: 'Listing reactivated',
  cloned: 'Listing cloned',
}

// Each kind picks a semantic accent. `archived` previously used
// bg-muted which was visually identical to the surrounding card surface
// and made the marker disappear — switched to muted-foreground/50 for
// a clearly visible "neutral past event" dot. `cloned` was bg-primary
// (raw color); now uses primary/60 to stay within the token palette.
const KIND_COLOR: Record<TimelineEvent['kind'], string> = {
  created: 'bg-success',
  updated: 'bg-primary',
  archived: 'bg-muted-foreground/50',
  unarchived: 'bg-success',
  cloned: 'bg-primary/60',
}

const events = computed<TimelineEvent[]>(() => {
  if (!props.listing) return []

  // Caller-supplied feed wins.
  if (props.listing.events && props.listing.events.length > 0) {
    return [...props.listing.events].sort((a, b) =>
      (b.timestamp || '').localeCompare(a.timestamp || ''),
    )
  }

  // Derived feed.
  const out: TimelineEvent[] = []
  if (props.listing.created_at) {
    out.push({
      id: 'derived-created',
      kind: 'created',
      timestamp: props.listing.created_at,
      actor: props.listing.created_by_name ?? null,
    })
  }

  // Only emit an "updated" event if it's distinguishable from creation —
  // most rows have updated_at == created_at on first save.
  if (
    props.listing.updated_at &&
    props.listing.updated_at !== props.listing.created_at
  ) {
    out.push({
      id: 'derived-updated',
      kind: 'updated',
      timestamp: props.listing.updated_at,
      actor: props.listing.updated_by_name ?? null,
    })
  }

  if (props.listing.deleted_at) {
    out.push({
      id: 'derived-archived',
      kind: 'archived',
      timestamp: props.listing.deleted_at,
      actor: null,
    })
  } else if (props.listing.is_online === false) {
    // Listings flipped offline without a deleted_at — closest signal we
    // have to "archived". No timestamp; show the bullet but mark unknown.
    out.push({
      id: 'derived-offline',
      kind: 'archived',
      timestamp: null,
      actor: null,
      message: 'Currently offline',
    })
  }

  // Most recent first.
  return out.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
})
</script>

<template>
  <div>
    <h3 class="mb-3 text-sm font-semibold text-foreground">Activity</h3>
    <p
      v-if="events.length === 0"
      class="text-xs text-muted-foreground/70"
    >
      No activity recorded yet.
    </p>

    <ol v-else class="relative ml-2 border-l border-border">
      <li
        v-for="event in events"
        :key="event.id"
        class="mb-4 ml-4"
      >
        <span
          class="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ring-4 ring-white"
          :class="KIND_COLOR[event.kind]"
          aria-hidden="true"
        />
        <p class="text-sm font-medium text-foreground">
          {{ event.message ?? KIND_LABEL[event.kind] }}
        </p>
        <p class="text-xs text-muted-foreground">
          {{ formatTimestamp(event.timestamp) }}
          <span v-if="event.actor" class="text-muted-foreground/70"> · {{ event.actor }}</span>
        </p>
      </li>
    </ol>
  </div>
</template>
