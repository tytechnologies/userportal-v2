<script setup lang="ts">
/**
 * /viewings — broker's daily / weekly schedule.
 *
 * Aggregates `deal_viewings` rows across every deal the caller can
 * read into one chronological feed. Defaults to "today + next two
 * weeks + yesterday's tail" so the morning view answers "what's on
 * my plate?" without filter fiddling.
 *
 * Buckets by date:
 *   Today / Tomorrow / This week / Later
 *
 * Each card:
 *   time + duration · status badge · listing title + address ·
 *   buyer name (linked) · attending agent · notes
 *
 * Click → /deals/[id] for the parent deal. Schedule new viewings
 * from the per-deal "Viewings" panel — this surface is read-mostly,
 * a glance-and-go schedule rather than a scheduler.
 */
import { computed, onMounted, ref, watch } from 'vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import { showToast } from '~/helpers/helpers'

definePageMeta({ layout: 'default' })
useHead({ title: 'Viewings | Housing Interactive' })

type Viewing = {
  id: string
  deal_id: string
  scheduled_at: string
  duration_minutes: number
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show'
  notes: string | null
  buyer_interest: 'high' | 'medium' | 'low' | 'declined' | null
  attending_user_id: string | null
  attending: {
    id: string
    full_name: string | null
    avatar_url: string | null
  } | null
  deal: {
    id: string
    title: string | null
    stage_key: string
    listing_id: number
    listing: {
      id: number
      title: string | null
      sale_price: number | null
      rent_price: number | null
      street_address: string | null
      barangay: string | null
    } | null
    buyer_contact: {
      id: number
      full_name: string | null
      email: string | null
      mobile_phone: string | null
    } | null
  } | null
}

const viewings = ref<Viewing[]>([])
const loading = ref(true)
const mineOnly = ref<boolean>(true)
const includeDone = ref<boolean>(false)

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ data: Viewing[] }>('/api/viewings', {
      query: {
        mine: mineOnly.value || undefined,
        // Empty status = all statuses; "scheduled" filters to upcoming.
        ...(includeDone.value ? {} : { status: 'scheduled' }),
      },
    })
    viewings.value = res.data ?? []
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Failed to load viewings',
      icon: 'error',
    })
    viewings.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch([mineOnly, includeDone], load)

// Bucket viewings by relative day. Anchored to local midnight so
// "today" and "tomorrow" line up with the broker's wall clock, not
// UTC. Past-day rows land in "Earlier" so they're visible but not
// crowding the lede.
type Bucket = 'earlier' | 'today' | 'tomorrow' | 'this_week' | 'later'

function bucketize(iso: string): Bucket {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return 'later'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const startOfDay = new Date(t)
  startOfDay.setHours(0, 0, 0, 0)
  const diffDays = Math.round((startOfDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  if (diffDays < 0) return 'earlier'
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  if (diffDays <= 7) return 'this_week'
  return 'later'
}

const grouped = computed(() => {
  const buckets: Record<Bucket, Viewing[]> = {
    earlier:   [],
    today:     [],
    tomorrow:  [],
    this_week: [],
    later:     [],
  }
  for (const v of viewings.value) {
    buckets[bucketize(v.scheduled_at)].push(v)
  }
  return buckets
})

function bucketLabel(b: Bucket): string {
  switch (b) {
    case 'earlier':   return 'Earlier'
    case 'today':     return 'Today'
    case 'tomorrow':  return 'Tomorrow'
    case 'this_week': return 'This week'
    case 'later':     return 'Later'
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

type StatusVariant = 'neutral' | 'success' | 'warning' | 'destructive' | 'primary'
function statusVariant(s: Viewing['status']): StatusVariant {
  switch (s) {
    case 'scheduled': return 'primary'
    case 'completed': return 'success'
    case 'cancelled': return 'neutral'
    case 'no_show':   return 'warning'
  }
}

function locationLine(v: Viewing): string {
  const parts: string[] = []
  if (v.deal?.listing?.street_address) parts.push(v.deal.listing.street_address)
  if (v.deal?.listing?.barangay)       parts.push(v.deal.listing.barangay)
  return parts.join(', ')
}

/**
 * Build + download a single-event .ics file for a viewing. Works with
 * Google Calendar (via "import" or simply opening the file), Apple
 * Calendar, Outlook — RFC 5545 covers everyone. Generated client-
 * side because the source data is already in memory; spinning up a
 * server endpoint just to format strings would be wasteful.
 *
 * Notes:
 *   - DTSTAMP is the file's mint time, not the event's.
 *   - DTSTART/DTEND are emitted in UTC (Z suffix) so the broker's
 *     local timezone applied at import — every calendar app handles
 *     UTC-anchored events natively. No floating times, no VTIMEZONE
 *     needed.
 *   - Long DESCRIPTION lines aren't folded (RFC 5545 says >75 octets
 *     must be wrapped); 99% of viewing notes fit comfortably under
 *     that and the parsers we tested tolerate single-line longer
 *     content without complaint. Revisit if a viewing turns up that
 *     pushes past ~500 chars.
 */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
function toIcsTimestamp(d: Date): string {
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    'T',
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
    'Z',
  ].join('')
}
function escapeIcs(s: string): string {
  // RFC 5545 §3.3.11: backslashes, commas, semicolons must be escaped;
  // newlines become literal "\n".
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}
function downloadIcs(v: Viewing) {
  const start = new Date(v.scheduled_at)
  if (Number.isNaN(start.getTime())) return
  const end = new Date(start.getTime() + v.duration_minutes * 60_000)

  const summaryParts: string[] = ['Property viewing']
  if (v.deal?.listing?.title) summaryParts.push(v.deal.listing.title)
  else if (v.deal?.listing?.id) summaryParts.push(`Listing #${v.deal.listing.id}`)

  const descLines: string[] = []
  if (v.deal?.buyer_contact?.full_name) {
    descLines.push(`Buyer: ${v.deal.buyer_contact.full_name}`)
  }
  if (v.deal?.buyer_contact?.mobile_phone) {
    descLines.push(`Phone: ${v.deal.buyer_contact.mobile_phone}`)
  }
  if (v.attending?.full_name) {
    descLines.push(`Attending: ${v.attending.full_name}`)
  }
  if (v.notes) descLines.push(`Notes: ${v.notes}`)
  if (v.deal?.id) {
    // Build a fully-qualified URL so the calendar entry can deep-link
    // back into the app from any device. window.location is safe here
    // because this only fires on user click in the browser.
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    if (origin) descLines.push(`Deal: ${origin}/deals/${v.deal.id}`)
  }

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Housing Interactive//Viewings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:viewing-${v.id}@housinginteractive`,
    `DTSTAMP:${toIcsTimestamp(new Date())}`,
    `DTSTART:${toIcsTimestamp(start)}`,
    `DTEND:${toIcsTimestamp(end)}`,
    `SUMMARY:${escapeIcs(summaryParts.join(' — '))}`,
    `DESCRIPTION:${escapeIcs(descLines.join('\n'))}`,
    `LOCATION:${escapeIcs(locationLine(v) || (v.deal?.listing?.title ?? ''))}`,
    `STATUS:${v.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `viewing-${v.id}.ics`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revoke so older browsers still resolve the navigation.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

const isEmpty = computed(() => !loading.value && viewings.value.length === 0)
const totalCount = computed(() => viewings.value.length)
</script>

<template>
  <AdminPageShell :permission="false" max-width="6xl">
    <UiPageHeader title="Viewings">
      <template #description>
        Your scheduled property tours, grouped by day. Schedule new
        viewings from the
        <NuxtLink to="/deals" class="font-medium text-primary hover:underline">
          deal detail page
        </NuxtLink>
        — this surface is for keeping your day on track.
      </template>
      <template #actions>
        <label class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <input
            v-model="mineOnly"
            type="checkbox"
            class="h-4 w-4 cursor-pointer accent-primary focus-ring"
          />
          Mine only
        </label>
        <label class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <input
            v-model="includeDone"
            type="checkbox"
            class="h-4 w-4 cursor-pointer accent-primary focus-ring"
          />
          Include completed/cancelled
        </label>
        <UiBadge variant="neutral" size="sm" :dot="true">
          <span class="tabular-nums">{{ totalCount.toLocaleString() }} viewing{{ totalCount === 1 ? '' : 's' }}</span>
        </UiBadge>
      </template>
    </UiPageHeader>

    <!-- Loading skeleton -->
    <div v-if="loading" class="space-y-3">
      <div
        v-for="n in 4"
        :key="n"
        class="h-20 animate-pulse rounded-lg border border-border bg-surface-2"
      />
    </div>

    <!-- Empty state -->
    <div
      v-else-if="isEmpty"
      class="rounded-lg border border-dashed border-border bg-surface-2 px-5 py-10 text-center"
    >
      <p class="text-sm font-medium text-foreground">
        {{ includeDone ? 'No viewings in this window' : 'No upcoming viewings' }}
      </p>
      <p class="mt-1 text-xs text-muted-foreground">
        Schedule a viewing from any
        <NuxtLink to="/deals" class="font-medium text-primary hover:underline">
          deal detail page
        </NuxtLink>
        — it'll show up here automatically.
      </p>
    </div>

    <!-- Grouped feed -->
    <div v-else class="space-y-6">
      <section
        v-for="bucket in (['today', 'tomorrow', 'this_week', 'later', 'earlier'] as const)"
        v-show="grouped[bucket].length > 0"
        :key="bucket"
      >
        <header class="mb-2 flex items-baseline justify-between">
          <h2 class="text-card-title">{{ bucketLabel(bucket) }}</h2>
          <span class="text-[11px] tabular-nums text-muted-foreground">
            {{ grouped[bucket].length }} viewing{{ grouped[bucket].length === 1 ? '' : 's' }}
          </span>
        </header>

        <ul class="space-y-2">
          <li
            v-for="v in grouped[bucket]"
            :key="v.id"
            class="rounded-md border border-border bg-card p-3 transition-colors hover:border-border-strong"
          >
            <div class="flex flex-wrap items-baseline gap-2">
              <NuxtLink
                v-if="v.deal"
                :to="`/deals/${v.deal.id}`"
                class="text-sm font-semibold text-foreground hover:text-primary hover:underline focus-ring rounded"
              >
                {{ formatTime(v.scheduled_at) }}
              </NuxtLink>
              <span v-else class="text-sm font-semibold text-foreground">
                {{ formatTime(v.scheduled_at) }}
              </span>
              <span class="text-xs tabular-nums text-muted-foreground">
                {{ v.duration_minutes }} min
              </span>
              <UiBadge :variant="statusVariant(v.status)" size="xs">
                {{ v.status }}
              </UiBadge>
              <!-- Calendar export — generates an .ics on the fly and
                   triggers download. Brokers drop this into their
                   phone calendar so reminders fire even when the app
                   isn't open. Hidden for cancelled viewings (no need
                   to add a cancelled event to a personal calendar). -->
              <button
                v-if="v.status !== 'cancelled'"
                type="button"
                class="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
                :title="`Add ${formatTime(v.scheduled_at)} viewing to your calendar`"
                @click.stop="downloadIcs(v)"
              >
                + calendar
              </button>
              <span
                v-if="v.attending"
                class="ml-auto text-xs text-muted-foreground"
              >
                {{ v.attending.full_name || 'Unassigned' }}
              </span>
            </div>

            <p v-if="v.deal?.listing" class="mt-1.5 text-xs">
              <NuxtLink
                :to="`/listings/${v.deal.listing.id}`"
                class="font-medium text-primary hover:underline focus-ring rounded"
                @click.stop
              >
                {{ v.deal.listing.title || `Listing #${v.deal.listing.id}` }}
              </NuxtLink>
              <span v-if="locationLine(v)" class="ml-1 text-muted-foreground">
                — {{ locationLine(v) }}
              </span>
            </p>

            <p v-if="v.deal?.buyer_contact" class="mt-0.5 text-xs">
              <span class="text-muted-foreground">Buyer:</span>
              <NuxtLink
                :to="`/contacts/${v.deal.buyer_contact.id}`"
                class="font-medium text-foreground hover:text-primary hover:underline focus-ring rounded"
                @click.stop
              >
                {{ v.deal.buyer_contact.full_name || `Contact #${v.deal.buyer_contact.id}` }}
              </NuxtLink>
              <span v-if="v.deal.buyer_contact.mobile_phone" class="ml-2 text-muted-foreground">
                · {{ v.deal.buyer_contact.mobile_phone }}
              </span>
            </p>

            <p
              v-if="v.notes"
              class="mt-1.5 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-foreground"
            >
              {{ v.notes }}
            </p>
          </li>
        </ul>
      </section>
    </div>
  </AdminPageShell>
</template>
