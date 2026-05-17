<script setup lang="ts">
/**
 * /transactions/[id] — transaction room detail.
 *
 * Surfaces every linked entity in one place:
 *   - Header: name, status, anchored listing/deal/contact
 *   - Participants tab: people on the deal (users + external contacts)
 *   - Documents tab: linked document_drafts (templates, AI-generated, uploaded)
 *   - Files tab: arbitrary supporting uploads (IDs, tax clearances, etc.)
 *   - Activity tab: unified audit feed
 *
 * Status workflow buttons advance open → in_review → closed and a
 * separate cancel/archive path. Closing the room does not cascade to
 * the linked deal — that's still managed on the pipeline surface.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from '~/helpers/helpers'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiWorkspaceTabs, { type WorkspaceTab } from '~/components/ui/UiWorkspaceTabs.vue'
import UiBreadcrumb from '~/components/ui/UiBreadcrumb.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const roomId = computed(() => String(route.params.id))

type Participant = {
  id: string
  role: string
  user_id: string | null
  contact_id: number | null
  user: { id: string; full_name: string | null; avatar_url: string | null } | null
  contact: { id: number; full_name: string | null; email: string | null; mobile_phone: string | null } | null
}
type LinkedDoc = {
  id: string
  draft_id: string
  added_at: string
  draft: { id: string; title: string | null; status: string; doc_type_key: string | null; updated_at: string } | null
}
type RoomFile = {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  description: string | null
  uploaded_at: string
}
type Room = {
  id: string
  name: string
  status: 'open' | 'in_review' | 'closed' | 'archived' | 'cancelled'
  listing_id: number | null
  buyer_contact_id: number | null
  seller_contact_id: number | null
  deal_id: string | null
  organization_id: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
  listing: { id: number; title: string | null; sale_price: number | null; rent_price: number | null; street_address: string | null; barangay: string | null } | null
  deal: { id: string; title: string | null; stage_key: string; deal_value: number | null; currency: string } | null
  buyer_contact: { id: number; full_name: string | null; email: string | null; mobile_phone: string | null } | null
  seller_contact: { id: number; full_name: string | null; email: string | null; mobile_phone: string | null } | null
  organization: { id: string; name: string } | null
  participants: Participant[]
  documents: LinkedDoc[]
  files: RoomFile[]
}

const room = ref<Room | null>(null)
const loading = ref(true)
const errorMsg = ref<string | null>(null)

useHead({
  title: () => room.value?.name ? `${room.value.name} | Transactions` : 'Transaction',
})

async function load() {
  loading.value = true
  errorMsg.value = null
  try {
    room.value = await $fetch<Room>(`/api/transaction-rooms/${roomId.value}`)
  } catch (err: any) {
    errorMsg.value = err?.statusMessage || err?.message || 'Failed to load transaction'
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(roomId, load)

// ----- Status transitions -------------------------------------------
const updating = ref(false)
async function setStatus(next: Room['status']) {
  if (!room.value || updating.value) return
  updating.value = true
  try {
    room.value = await $fetch<Room>(`/api/transaction-rooms/${roomId.value}`, {
      method: 'PATCH',
      body: { status: next },
    })
    showToast({ title: `Marked ${next.replace('_', ' ')}`, icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Status change failed',
      icon: 'error',
    })
  } finally {
    updating.value = false
  }
}

type StatusVariant = 'success' | 'neutral' | 'primary' | 'warning' | 'destructive'
function statusVariant(s: Room['status']): StatusVariant {
  switch (s) {
    case 'open':      return 'primary'
    case 'in_review': return 'warning'
    case 'closed':    return 'success'
    case 'archived':  return 'neutral'
    case 'cancelled': return 'destructive'
  }
}

// ----- Participant add ----------------------------------------------
const newParticipant = ref<{ contact_id: string; role: string }>({ contact_id: '', role: 'buyer' })
const addingParticipant = ref(false)
async function addParticipant() {
  if (!room.value || addingParticipant.value) return
  const cid = Number(newParticipant.value.contact_id)
  if (!Number.isFinite(cid) || cid <= 0) {
    showToast({ title: 'Enter a valid contact id', icon: 'error' })
    return
  }
  addingParticipant.value = true
  try {
    await $fetch(`/api/transaction-rooms/${roomId.value}/participants`, {
      method: 'POST',
      body: { contact_id: cid, role: newParticipant.value.role },
    })
    newParticipant.value.contact_id = ''
    await load()
    showToast({ title: 'Participant added', icon: 'success' })
  } catch (err: any) {
    showToast({
      title: err?.statusMessage || err?.message || 'Could not add participant',
      icon: 'error',
    })
  } finally {
    addingParticipant.value = false
  }
}

function moneyLabel(amount: number | null, currency: string | null = 'PHP'): string {
  if (amount == null) return '—'
  const sym = currency === 'PHP' ? '₱' : (currency || '')
  return `${sym} ${Number(amount).toLocaleString()}`
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ----- Workspace tabs -----------------------------------------------
// The detail surface is long enough that scrolling between sections
// gets old fast. Tabs let brokers jump between the four content
// areas (Overview / Participants / Documents / Files) without
// scrolling, and the count badges show what needs attention.
type TabId = 'overview' | 'participants' | 'documents' | 'files'
const activeTab = ref<TabId>('overview')

const tabs = computed<WorkspaceTab[]>(() => {
  if (!room.value) return []
  return [
    { id: 'overview',     label: 'Overview' },
    {
      id: 'participants',
      label: 'Participants',
      count: room.value.participants.length,
      severity: 'neutral',
    },
    {
      id: 'documents',
      label: 'Documents',
      count: room.value.documents.length,
      severity: 'primary',
    },
    {
      id: 'files',
      label: 'Files',
      count: room.value.files.length,
      severity: 'neutral',
    },
  ]
})
</script>

<template>
  <AdminPageShell :permission="false" max-width="6xl">
    <UiCard v-if="loading" padding="md" class="text-center text-sm text-muted-foreground">
      Loading…
    </UiCard>

    <UiCard v-else-if="errorMsg" padding="md" class="border-destructive/30 bg-destructive/10 text-center text-sm text-destructive">
      {{ errorMsg }}
    </UiCard>

    <template v-else-if="room">
      <!-- Breadcrumb — orientation in the new domain layout. -->
      <UiBreadcrumb :entity="room.name" />

      <!-- Header card -->
      <UiCard padding="md">
        <div class="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <NuxtLink
              to="/transactions"
              class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-ring rounded"
            >
              <span aria-hidden="true">←</span>
              All transactions
            </NuxtLink>
            <h1 class="mt-1 text-page-title">{{ room.name }}</h1>
            <div class="mt-1 flex flex-wrap items-center gap-2">
              <UiBadge :variant="statusVariant(room.status)" size="sm">
                {{ room.status.replace('_', ' ') }}
              </UiBadge>
              <span class="text-[11px] text-muted-foreground tabular-nums">
                Updated {{ formatTs(room.updated_at) }}
              </span>
            </div>
          </div>

          <!-- Status workflow buttons -->
          <div class="flex flex-wrap gap-1.5">
            <button
              v-if="room.status !== 'in_review'"
              type="button"
              class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring disabled:opacity-50"
              :disabled="updating"
              @click="setStatus('in_review')"
            >
              Mark in review
            </button>
            <button
              v-if="room.status !== 'closed'"
              type="button"
              class="rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-success-foreground hover:bg-success/90 focus-ring disabled:opacity-50"
              :disabled="updating"
              @click="setStatus('closed')"
            >
              Close room
            </button>
            <button
              v-if="room.status !== 'archived' && room.status !== 'cancelled'"
              type="button"
              class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent focus-ring disabled:opacity-50"
              :disabled="updating"
              @click="setStatus('archived')"
            >
              Archive
            </button>
          </div>
        </div>

        <!-- Anchor strip: linked listing / deal / contacts -->
        <dl class="mt-4 grid gap-3 border-t border-border pt-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt class="text-muted-foreground">Listing</dt>
            <dd v-if="room.listing" class="mt-0.5">
              <NuxtLink :to="`/listings/${room.listing.id}`" class="text-primary hover:underline focus-ring rounded">
                {{ room.listing.title || `#${room.listing.id}` }}
              </NuxtLink>
              <p v-if="room.listing.sale_price" class="mt-0.5 tabular-nums text-foreground">
                {{ moneyLabel(room.listing.sale_price) }}
              </p>
              <p v-else-if="room.listing.rent_price" class="mt-0.5 tabular-nums text-foreground">
                {{ moneyLabel(room.listing.rent_price) }}/mo
              </p>
            </dd>
            <dd v-else class="mt-0.5 italic text-muted-foreground">Not set</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Deal</dt>
            <dd v-if="room.deal" class="mt-0.5">
              <NuxtLink :to="`/deals/${room.deal.id}`" class="text-primary hover:underline focus-ring rounded">
                {{ room.deal.title || `Deal ${room.deal.id.slice(0, 8)}` }}
              </NuxtLink>
              <p class="mt-0.5 text-muted-foreground">
                {{ room.deal.stage_key.replace(/_/g, ' ') }}
              </p>
            </dd>
            <dd v-else class="mt-0.5 italic text-muted-foreground">Not anchored</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Buyer</dt>
            <dd v-if="room.buyer_contact" class="mt-0.5">
              <NuxtLink :to="`/contacts/${room.buyer_contact.id}`" class="text-primary hover:underline focus-ring rounded">
                {{ room.buyer_contact.full_name }}
              </NuxtLink>
              <p v-if="room.buyer_contact.mobile_phone" class="mt-0.5 text-muted-foreground tabular-nums">
                {{ room.buyer_contact.mobile_phone }}
              </p>
            </dd>
            <dd v-else class="mt-0.5 italic text-muted-foreground">Not set</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Seller</dt>
            <dd v-if="room.seller_contact" class="mt-0.5">
              <NuxtLink :to="`/contacts/${room.seller_contact.id}`" class="text-primary hover:underline focus-ring rounded">
                {{ room.seller_contact.full_name }}
              </NuxtLink>
            </dd>
            <dd v-else class="mt-0.5 italic text-muted-foreground">Not set</dd>
          </div>
        </dl>
      </UiCard>

      <!-- Workspace tabs — sticky to the top of the scroll, with
           live counts on each tab. Header card above stays visible
           always (anchor info), tabs control which body section
           renders below. -->
      <UiWorkspaceTabs v-model="activeTab" :tabs="tabs" aria-label="Transaction tabs" />

      <!-- Overview tab — quick stats, audit-style summary of the
           room state. The hydrated anchors above already cover the
           lede; this surface is mostly empty in v1, kept as a tab so
           the workspace pattern is honored consistently. -->
      <UiCard v-show="activeTab === 'overview'" padding="md">
        <h2 class="mb-3 text-card-title">Overview</h2>
        <dl class="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt class="text-muted-foreground">Created</dt>
            <dd class="mt-0.5 text-foreground tabular-nums">{{ formatTs(room.created_at) }}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Last updated</dt>
            <dd class="mt-0.5 text-foreground tabular-nums">{{ formatTs(room.updated_at) }}</dd>
          </div>
          <div v-if="room.closed_at">
            <dt class="text-muted-foreground">Closed</dt>
            <dd class="mt-0.5 text-foreground tabular-nums">{{ formatTs(room.closed_at) }}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Participants</dt>
            <dd class="mt-0.5 text-foreground">{{ room.participants.length }} people</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Documents</dt>
            <dd class="mt-0.5 text-foreground">{{ room.documents.length }} linked</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Files</dt>
            <dd class="mt-0.5 text-foreground">{{ room.files.length }} uploaded</dd>
          </div>
        </dl>
      </UiCard>

      <!-- Participants -->
      <UiCard v-show="activeTab === 'participants'" padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Participants ({{ room.participants.length }})</h2>
        </header>

        <ul v-if="room.participants.length > 0" class="space-y-1.5">
          <li
            v-for="p in room.participants"
            :key="p.id"
            class="flex flex-wrap items-baseline gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
          >
            <UiBadge variant="neutral" size="xs">{{ p.role.replace('_', ' ') }}</UiBadge>
            <span v-if="p.user" class="font-semibold text-foreground">
              {{ p.user.full_name || 'Unnamed user' }}
            </span>
            <NuxtLink
              v-else-if="p.contact"
              :to="`/contacts/${p.contact.id}`"
              class="font-semibold text-primary hover:underline focus-ring rounded"
            >
              {{ p.contact.full_name || `Contact #${p.contact.id}` }}
            </NuxtLink>
            <span class="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {{ p.user ? '(internal)' : '(external)' }}
            </span>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">
          No participants yet. Add at least the buyer and seller below.
        </p>

        <!-- Quick-add participant -->
        <form
          class="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"
          @submit.prevent="addParticipant"
        >
          <input
            v-model="newParticipant.contact_id"
            type="number"
            min="1"
            placeholder="Contact id"
            class="w-24 rounded-md border border-input bg-card px-2 py-1.5 text-xs"
          />
          <select
            v-model="newParticipant.role"
            class="rounded-md border border-input bg-card px-2 py-1.5 text-xs"
          >
            <option value="buyer">Buyer</option>
            <option value="seller">Seller</option>
            <option value="buyer_agent">Buyer agent</option>
            <option value="seller_agent">Seller agent</option>
            <option value="co_broker">Co-broker</option>
            <option value="attorney">Attorney</option>
            <option value="witness">Witness</option>
            <option value="notary">Notary</option>
            <option value="manager">Manager</option>
            <option value="observer">Observer</option>
          </select>
          <button
            type="submit"
            class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-ring disabled:opacity-50"
            :disabled="!newParticipant.contact_id || addingParticipant"
          >
            {{ addingParticipant ? 'Adding…' : '+ Add' }}
          </button>
          <p class="text-[11px] text-muted-foreground">
            (Type-ahead picker shipping in Phase 2 — for now, paste the contact id from /contacts.)
          </p>
        </form>
      </UiCard>

      <!-- Linked documents -->
      <UiCard v-show="activeTab === 'documents'" padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Documents ({{ room.documents.length }})</h2>
        </header>
        <ul v-if="room.documents.length > 0" class="space-y-1.5">
          <li
            v-for="d in room.documents"
            :key="d.id"
            class="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
          >
            <UiBadge :variant="d.draft?.status === 'signed' ? 'success' : 'neutral'" size="xs">
              {{ d.draft?.status || 'unknown' }}
            </UiBadge>
            <NuxtLink
              v-if="d.draft"
              :to="`/document-drafts/${d.draft.id}`"
              class="min-w-0 flex-1 truncate text-xs font-medium text-foreground hover:text-primary focus-ring rounded"
            >
              {{ d.draft.title || d.draft.doc_type_key || `Draft ${d.draft.id.slice(0, 8)}` }}
            </NuxtLink>
            <span class="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {{ formatTs(d.added_at) }}
            </span>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">
          No documents linked yet. Generate or upload from a listing or contact, then attach via the document detail page (linker UI ships in Phase 2).
        </p>
      </UiCard>

      <!-- Files -->
      <UiCard v-show="activeTab === 'files'" padding="md">
        <header class="mb-3 flex items-baseline justify-between gap-2">
          <h2 class="text-card-title">Files ({{ room.files.length }})</h2>
        </header>
        <ul v-if="room.files.length > 0" class="space-y-1.5">
          <li
            v-for="f in room.files"
            :key="f.id"
            class="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
          >
            <span class="font-mono text-muted-foreground">{{ f.mime_type }}</span>
            <span class="font-semibold text-foreground">{{ f.filename }}</span>
            <span class="text-muted-foreground tabular-nums">{{ (f.size_bytes / 1_000_000).toFixed(1) }}MB</span>
            <span class="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {{ formatTs(f.uploaded_at) }}
            </span>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">
          No supporting files uploaded. (Upload UI ships in Phase 2.)
        </p>
      </UiCard>
    </template>
  </AdminPageShell>
</template>
