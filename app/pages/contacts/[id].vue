<script setup lang="ts">
// Contact detail page. Edit + delete live here so the URL is shareable
// and back/forward navigates between view/edit naturally. RLS does the
// "is this contact mine?" check; if it isn't, getContactById returns
// null and we render the not-found state.

import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useContacts, type Contact, type ContactInput } from '~/composables/useContacts'
import { useTimeline, type TimelineEvent } from '~/composables/useTimeline'
import { showToast } from '~/helpers/helpers'
import { formatMoney } from '~/utils'
import ContactForm from '~/components/contacts/ContactForm.vue'
import TimelineEntry from '~/components/timeline/TimelineEntry.vue'
import TasksPanel from '~/components/crm/TasksPanel.vue'
import NotesPanel from '~/components/crm/NotesPanel.vue'
import ContactDealsSection from '~/components/contacts/ContactDealsSection.vue'
import ContactDraftsSection from '~/components/contacts/ContactDraftsSection.vue'
import ShareListingModal from '~/components/crm/ShareListingModal.vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const {
  getContactById,
  updateContact,
  deleteContact,
  fetchLinkedListings,
} = useContacts()
const { fetchContactTimeline } = useTimeline()

const id = computed(() => Number(route.params.id))
const contact = ref<Contact | null>(null)
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)
const notFound = ref(false)

const isEditing = ref(false)
const isSaving = ref(false)
const isDeleting = ref(false)

// Linked-data panels. Both load lazily after the main contact arrives —
// the detail card paints first, the side panels stream in. RLS gates
// what the caller can actually see (linked listings respect listings
// RLS; activities respect activities RLS).
type LinkedListing = Awaited<ReturnType<typeof fetchLinkedListings>>[number]
const linkedListings = ref<LinkedListing[]>([])
const linkedListingsLoading = ref(false)
const timeline = ref<TimelineEvent[]>([])
const timelineLoading = ref(false)

async function loadLinkedListings(contactId: number) {
  linkedListingsLoading.value = true
  try {
    linkedListings.value = await fetchLinkedListings(contactId)
  } finally {
    linkedListingsLoading.value = false
  }
}

async function loadTimeline(contactId: number) {
  timelineLoading.value = true
  try {
    timeline.value = await fetchContactTimeline(contactId)
  } finally {
    timelineLoading.value = false
  }
}

// Re-fetch panels whenever the underlying contact id changes (e.g. an
// admin clicks through several contacts in succession without unmount).
// Also re-load timeline after the user edits the contact themselves so
// the just-emitted contact.updated row appears without a manual refresh.
watch(
  () => contact.value?.id ?? null,
  (id) => {
    if (id) {
      loadLinkedListings(id)
      loadTimeline(id)
    } else {
      linkedListings.value = []
      timeline.value = []
    }
  },
)

// Share-modal state. Per-row share button on the linked-listings list
// opens this modal pre-populated with the chosen listing.
const shareModalOpen = ref(false)
const shareModalListing = ref<LinkedListing | null>(null)
function openShareModal(l: LinkedListing) {
  shareModalListing.value = l
  shareModalOpen.value = true
}

function listingPriceLabel(l: LinkedListing): string {
  if (l.for_sale && l.sale_price) return `${formatMoney(l.sale_price, true)}`
  if (l.for_rent && l.rent_price) return `${formatMoney(l.rent_price, true)}/mo`
  return '—'
}

function listingTagLabel(l: LinkedListing): string {
  const parts: string[] = []
  if (l.for_sale) parts.push('For Sale')
  if (l.for_rent) parts.push('For Rent')
  if (parts.length === 0) parts.push('—')
  return parts.join(' • ')
}

useHead(() => ({
  title: contact.value?.full_name
    ? `${contact.value.full_name} | Contacts`
    : 'Contact | Housinginteractive',
}))

async function load() {
  isLoading.value = true
  errorMessage.value = null
  notFound.value = false
  try {
    if (!Number.isFinite(id.value)) {
      notFound.value = true
      return
    }
    const row = await getContactById(id.value)
    if (!row) {
      // Either it doesn't exist or RLS hid it. Same UX either way.
      notFound.value = true
      return
    }
    contact.value = row
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Failed to load contact.'
  } finally {
    isLoading.value = false
  }
}

onMounted(load)

async function onSave(payload: ContactInput) {
  if (!contact.value) return
  isSaving.value = true
  try {
    contact.value = await updateContact(contact.value.id, payload)
    isEditing.value = false
    showToast({ title: 'Contact updated.', icon: 'success' })
    // Pull the new contact.updated row into the timeline immediately
    // rather than waiting for the next page visit.
    if (contact.value?.id) loadTimeline(contact.value.id)
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not save contact.', icon: 'error' })
  } finally {
    isSaving.value = false
  }
}

async function onDelete() {
  if (!contact.value) return
  // Browser-native confirm on purpose: matches the existing app's pattern
  // for low-risk destructive ops, no extra component to maintain.
  const ok = window.confirm(
    `Delete "${contact.value.full_name}"? This cannot be undone.`,
  )
  if (!ok) return
  isDeleting.value = true
  try {
    await deleteContact(contact.value.id)
    showToast({ title: 'Contact deleted.', icon: 'success' })
    router.replace('/contacts')
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not delete contact.', icon: 'error' })
    isDeleting.value = false
  }
}

const initial = computed(() => {
  return (contact.value?.full_name ?? '?').trim().charAt(0).toUpperCase() || '?'
})
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <NuxtLink
      to="/contacts"
      class="inline-flex items-center gap-1 text-meta hover:text-foreground focus-ring rounded"
    >
      <span aria-hidden="true">←</span>
      All contacts
    </NuxtLink>

    <!-- Loading skeleton -->
    <UiCard v-if="isLoading" padding="md">
      <UiSkeleton :circle="true" class="mb-4 h-12 w-12" />
      <UiSkeleton class="mb-2 h-4 w-1/3" />
      <UiSkeleton class="h-3 w-1/2" />
    </UiCard>

    <UiCard
      v-else-if="errorMessage"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-center"
    >
      <p class="text-sm text-destructive">{{ errorMessage }}</p>
      <button
        type="button"
        class="mt-3 rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-colors duration-150 ease-out hover:bg-destructive/90 focus-ring"
        @click="load"
      >
        Try again
      </button>
    </UiCard>

    <!-- Not-found state — same UX whether the row really doesn't exist or
         RLS hid it from this user. Don't tell the caller the difference. -->
    <UiCard
      v-else-if="notFound"
      padding="md"
      class="border-dashed text-center py-10"
    >
      <h1 class="text-base font-semibold text-foreground">Contact not found</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        This contact may have been deleted or you don't have access to it.
      </p>
      <NuxtLink
        to="/contacts"
        class="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
      >
        Back to contacts
      </NuxtLink>
    </UiCard>

    <UiCard v-else-if="contact" padding="none">
      <!-- View mode -->
      <div v-if="!isEditing">
        <div class="flex flex-col gap-4 border-b border-border p-6 sm:flex-row sm:items-center">
          <div
            class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xl font-semibold text-primary"
            aria-hidden="true"
          >
            {{ initial }}
          </div>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-lg font-semibold text-foreground">
              {{ contact.full_name }}
            </h1>
            <p v-if="contact.designation" class="truncate text-sm text-muted-foreground">
              {{ contact.designation }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <NuxtLink
              :to="{ path: '/document-drafts/new', query: { contact_id: contact.id } }"
              class="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors duration-150 ease-out hover:bg-accent focus-ring"
              title="Create a new document draft pre-linked to this contact"
            >
              + Document
            </NuxtLink>
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
              @click="isEditing = true"
            >
              Edit
            </button>
            <button
              type="button"
              class="rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors duration-150 ease-out hover:bg-destructive/15 focus-ring disabled:opacity-60"
              :disabled="isDeleting"
              @click="onDelete"
            >
              <span v-if="isDeleting">Deleting…</span>
              <span v-else>Delete</span>
            </button>
          </div>
        </div>

        <dl class="grid grid-cols-1 gap-x-6 gap-y-4 p-6 sm:grid-cols-2">
          <div>
            <dt class="text-xs font-semibold text-muted-foreground">Email</dt>
            <dd class="mt-1 break-all text-sm text-foreground">
              {{ contact.email || '—' }}
            </dd>
          </div>
          <div>
            <dt class="text-xs font-semibold text-muted-foreground">Mobile phone</dt>
            <dd class="mt-1 text-sm text-foreground">
              {{ contact.mobile_phone || '—' }}
            </dd>
          </div>
          <div v-if="contact.home_phone">
            <dt class="text-xs font-semibold text-muted-foreground">Home phone</dt>
            <dd class="mt-1 text-sm text-foreground">
              {{ contact.home_phone }}
            </dd>
          </div>
          <div v-if="contact.link">
            <dt class="text-xs font-semibold text-muted-foreground">Link</dt>
            <dd class="mt-1 break-all text-sm text-foreground">
              <a :href="contact.link" target="_blank" rel="noopener" class="text-primary hover:underline">
                {{ contact.link }}
              </a>
            </dd>
          </div>
          <div class="sm:col-span-2">
            <dt class="text-xs font-semibold text-muted-foreground">Notes</dt>
            <dd class="mt-1 whitespace-pre-wrap text-sm text-foreground">
              {{ contact.notes || '—' }}
            </dd>
          </div>
        </dl>
      </div>

      <!-- Edit mode -->
      <div v-else class="p-6">
        <h2 class="mb-4 text-base font-semibold text-foreground">Edit contact</h2>
        <ContactForm
          :initial="contact"
          :busy="isSaving"
          @submit="onSave"
          @cancel="isEditing = false"
        />
      </div>
    </UiCard>

    <!-- Linked panels — render only in view mode and only when a contact
         is loaded. Two-column on wide screens, stacked on mobile. -->
    <div
      v-if="contact && !isEditing"
      class="grid gap-4 lg:grid-cols-2"
    >
      <!-- Linked listings -->
      <UiCard padding="none">
        <header class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-card-title">
            Linked listings
            <span v-if="!linkedListingsLoading" class="ml-1 text-xs font-normal text-muted-foreground">
              ({{ linkedListings.length }})
            </span>
          </h2>
        </header>

        <ul v-if="linkedListingsLoading" class="divide-y divide-border">
          <li v-for="n in 3" :key="n" class="px-4 py-3">
            <UiSkeleton class="h-3 w-1/3" />
            <UiSkeleton class="mt-2 h-3 w-1/2" />
          </li>
        </ul>

        <div
          v-else-if="linkedListings.length === 0"
          class="px-4 py-10 text-center text-sm text-muted-foreground"
        >
          No listings linked to this contact yet.
        </div>

        <ul v-else class="divide-y divide-border">
          <li
            v-for="listing in linkedListings"
            :key="listing.listing_id"
            class="flex items-center gap-3 px-4 py-3"
          >
            <div
              class="h-2 w-2 shrink-0 rounded-full"
              :class="listing.is_online ? 'bg-success' : 'bg-muted'"
              :title="listing.is_online ? 'Online' : 'Offline'"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-foreground">
                {{ listing.title || `Listing #${listing.listing_id}` }}
              </p>
              <p class="truncate text-xs text-muted-foreground">
                {{ listingTagLabel(listing) }}
                <span v-if="listing.city_name"> · {{ listing.city_name }}</span>
              </p>
            </div>
            <div class="text-right text-xs text-muted-foreground">
              {{ listingPriceLabel(listing) }}
            </div>
            <button
              class="text-xs text-primary hover:underline focus-ring rounded"
              title="Share listing"
              @click="openShareModal(listing)"
            >
              Share
            </button>
          </li>
        </ul>
      </UiCard>

      <!-- Unified activity timeline: contact + linked listing + linked
           document events, ordered by created_at. -->
      <UiCard padding="none">
        <header class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-card-title">Activity</h2>
          <span v-if="!timelineLoading" class="text-xs text-muted-foreground/70 tabular-nums">
            {{ timeline.length }}
          </span>
        </header>

        <div v-if="timelineLoading" class="space-y-3 p-4">
          <UiSkeleton v-for="n in 3" :key="n" class="h-3 w-2/3" />
        </div>

        <div
          v-else-if="timeline.length === 0"
          class="px-4 py-10 text-center text-sm text-muted-foreground"
        >
          No activity recorded yet.
        </div>

        <ol v-else class="relative border-l border-border px-4 py-4">
          <TimelineEntry
            v-for="event in timeline"
            :key="event.id"
            :event="event"
          />
        </ol>
      </UiCard>

      <!-- Pipeline activity — every deal where this contact is the
           buyer, split active vs. closed. Mounted above tasks/notes
           because "what deals are we working on with this person" is
           the lead question for any broker opening a contact page. -->
      <ContactDealsSection :contact-id="contact!.id" />

      <!-- Documents linked to this contact — drafts, AI bodies,
           uploaded PDFs. Same wizard as the listing/deal surfaces;
           pre-links to this contact only. -->
      <ContactDraftsSection :contact-id="contact!.id" />

      <!-- CRM panels: tasks + notes scoped to this contact. RLS keeps
           them per-user (or team/all per role). Both manage their own
           load + composer state. -->
      <TasksPanel :contact-id="contact!.id" />
      <NotesPanel :contact-id="contact!.id" />
    </div>

    <!-- Share modal — instantiated once at page level, opened by
         per-row share buttons on the linked-listings panel. -->
    <ShareListingModal
      v-if="shareModalListing"
      :open="shareModalOpen"
      :listing-id="shareModalListing.listing_id"
      :listing-title="shareModalListing.title"
      @close="shareModalOpen = false"
    />
  </AdminPageShell>
</template>
