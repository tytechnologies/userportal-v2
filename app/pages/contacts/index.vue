<script setup lang="ts">
// Contacts list page. Replaces the old monolithic /contacts page (now
// at /contacts-legacy). Reads through useContacts() so RLS handles the
// "only my contacts" scope — the page itself never knows about
// owner_user_id.
//
// State machine: loading → (empty | loaded | error). The new-contact
// modal mounts inside the same page so list refresh is one function call.

import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useContacts, type Contact, type ContactInput } from '~/composables/useContacts'
import { showToast } from '~/helpers/helpers'
import ContactForm from '~/components/contacts/ContactForm.vue'
import AdminPageShell from '~/components/admin/shell/AdminPageShell.vue'
import UiPageHeader from '~/components/ui/UiPageHeader.vue'
import UiCard from '~/components/ui/UiCard.vue'
import UiSkeleton from '~/components/ui/UiSkeleton.vue'

definePageMeta({
  layout: 'default',
})

useHead({ title: 'Contacts | Housinginteractive' })

const { fetchContacts, createContact } = useContacts()
const router = useRouter()

const contacts = ref<Contact[]>([])
const isLoading = ref(true)
const errorMessage = ref<string | null>(null)

const search = ref('')
const sort = ref<'created_at' | 'full_name'>('created_at')
const order = ref<'asc' | 'desc'>('desc')

// Filtering happens client-side once we've already loaded the slice the
// user can see. Server-side ilike is only used when the user explicitly
// hits "Search" — keeps typing fast on the common case (a few hundred
// rows). For >5k contacts per user, switch to server-side debounce.
const filtered = computed<Contact[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return contacts.value
  return contacts.value.filter((c) => {
    return (
      (c.full_name ?? '').toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q) ||
      (c.mobile_phone ?? '').toLowerCase().includes(q)
    )
  })
})

async function load() {
  isLoading.value = true
  errorMessage.value = null
  try {
    contacts.value = await fetchContacts({ sort: sort.value, order: order.value })
  } catch (err: any) {
    errorMessage.value = err?.message ?? 'Failed to load contacts.'
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  load()
  // Quick-create deep link: /contacts?new=1 opens the create modal
  // (same affordance the dashboard quick-actions row uses).
  const route = useRoute()
  if (route.query.new === '1') isCreateOpen.value = true
})

// Modal state for create. Edit lives on the detail page so the URL is
// shareable and back/forward behaves; cuts modal complexity here in half.
const isCreateOpen = ref(false)
const isCreating = ref(false)

async function onCreateSubmit(payload: ContactInput) {
  isCreating.value = true
  try {
    const created = await createContact(payload)
    isCreateOpen.value = false
    // Optimistic insert — drop the new row at the top so the user sees
    // immediate feedback. We refetch only on next navigation.
    contacts.value = [created, ...contacts.value]
    showToast({ title: 'Contact created.', icon: 'success' })
  } catch (err: any) {
    showToast({ title: err?.message ?? 'Could not create contact.', icon: 'error' })
  } finally {
    isCreating.value = false
  }
}

// Letter avatar — single neutral chip. Phase 5 dropped the saturated
// 6-color rainbow palette (rose/amber/emerald/sky/violet/pink) per
// "color only when meaningful." The initial letter does the scanning
// work; per-name color was decorative.
function initial(name: string | null | undefined): string {
  return (name ?? '?').trim().charAt(0).toUpperCase() || '?'
}

function open(contact: Contact) {
  router.push(`/contacts/${contact.id}`)
}
</script>

<template>
  <AdminPageShell :permission="false" max-width="7xl">
    <UiPageHeader
      title="Contacts"
      description="People you've added to your address book. Only you can see these."
    >
      <template #actions>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
          @click="isCreateOpen = true"
        >
          New contact
        </button>
      </template>
    </UiPageHeader>

    <!-- Search + sort bar -->
    <UiCard padding="sm">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          v-model="search"
          type="search"
          placeholder="Search by name, email, or phone…"
          class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus-ring sm:max-w-md"
        />
        <div class="flex items-center gap-2 sm:ml-auto">
          <label class="text-xs font-medium text-muted-foreground" for="sort">Sort</label>
          <select
            id="sort"
            v-model="sort"
            class="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus-ring"
            @change="load"
          >
            <option value="created_at">Recently added</option>
            <option value="full_name">Name</option>
          </select>
          <select
            v-model="order"
            class="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus-ring"
            @change="load"
          >
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
        </div>
      </div>
    </UiCard>

    <!-- Loading skeleton matches the row shape so the page doesn't reflow. -->
    <UiCard v-if="isLoading" padding="none">
      <ul class="divide-y divide-border">
        <li v-for="n in 6" :key="n" class="flex items-center gap-3 px-4 py-3">
          <UiSkeleton :circle="true" class="h-9 w-9" />
          <div class="flex-1 space-y-2">
            <UiSkeleton class="h-3 w-1/3" />
            <UiSkeleton class="h-3 w-1/2" />
          </div>
        </li>
      </ul>
    </UiCard>

    <UiCard
      v-else-if="errorMessage"
      padding="md"
      class="border-destructive/30 bg-destructive/10 text-center"
    >
      <p class="text-sm text-destructive">{{ errorMessage }}</p>
      <button
        type="button"
        class="mt-3 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground transition-colors duration-150 ease-out hover:bg-destructive/90 focus-ring"
        @click="load"
      >
        Try again
      </button>
    </UiCard>

    <UiCard v-else-if="filtered.length === 0" padding="none">
      <EmptyState
        variant="neutral"
        size="cozy"
        :title="search ? 'No matches' : 'No contacts yet'"
        :description="search
          ? 'Try a different search term — names, emails, and phones are all searched.'
          : 'Add your first contact to start building your address book.'"
      >
        <template v-if="!search" #cta>
          <button
            type="button"
            class="rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-ring"
            @click="isCreateOpen = true"
          >
            New contact
          </button>
        </template>
      </EmptyState>
    </UiCard>

    <UiCard v-else padding="none">
      <ul class="divide-y divide-border">
        <li
          v-for="c in filtered"
          :key="c.id"
          class="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-150 ease-out hover:bg-accent/40 focus-ring"
          role="button"
          tabindex="0"
          @click="open(c)"
          @keydown.enter.prevent="open(c)"
          @keydown.space.prevent="open(c)"
        >
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted-foreground/10 text-sm font-semibold text-foreground/70"
            aria-hidden="true"
          >
            {{ initial(c.full_name) }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-foreground">
              {{ c.full_name }}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              {{ c.email || c.mobile_phone || 'No contact info' }}
            </p>
          </div>
          <div class="hidden text-xs text-muted-foreground sm:block">
            {{ c.mobile_phone || '' }}
          </div>
        </li>
      </ul>
    </UiCard>

    <!-- New contact — Phase 6 Operations primitive -->
    <UiModal
      :open="isCreateOpen"
      title="New contact"
      width="md"
      @update:open="isCreateOpen = $event"
    >
      <ContactForm
        :busy="isCreating"
        @submit="onCreateSubmit"
        @cancel="isCreateOpen = false"
      />
    </UiModal>
  </AdminPageShell>
</template>
