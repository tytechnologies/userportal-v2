<script setup>
/**
 * Top navigation bar — Phase 2 redesign.
 *
 * The lg+ surface owns:
 *   - global search trigger (opens the same useCommandPalette as ⌘K
 *     and the sidebar's search row)
 *   - quick-create dropdown (+ → New listing / contact / task / document).
 *     Inquiries are intentionally NOT here — they are created only by
 *     visitors via the public website's listing-detail Inquire form
 *     → /api/public/inquiries → public.inquiries. Operators do not
 *     hand-author inquiries from the portal (the inquiries table
 *     captures real visitor traffic; manual creation muddies the
 *     funnel metrics).
 *   - notification bell
 *   - avatar pill with dropdown (My Profile / Change Password / Sign out)
 *
 * On <lg the surface adds a hamburger that opens the sidebar drawer
 * + a compact wordmark (the sidebar drawer is closed by default on
 * mobile, so the brand surface lives here).
 *
 * Removed in this rewrite:
 *   - dead horizontal nav (the sidebar took over)
 *   - duplicate brand logo on lg+ (sidebar already has it)
 *   - mobile menu (the sidebar drawer is the canonical mobile nav)
 *
 * Preserved:
 *   - Profile + Change Password modals (opened from the avatar dropdown)
 *   - NotificationBell component (CRM bell, reads /api/notifications)
 *   - Avatar fetch logic via getContactAvatar
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import Magnify from 'vue-material-design-icons/Magnify.vue'
import Plus from 'vue-material-design-icons/Plus.vue'
import Menu from 'vue-material-design-icons/Menu.vue'
import ChevronDown from 'vue-material-design-icons/ChevronDown.vue'
import HomeCity from 'vue-material-design-icons/HomeCity.vue'
import AccountMultiple from 'vue-material-design-icons/AccountMultiple.vue'
import CheckboxMarkedOutline from 'vue-material-design-icons/CheckboxMarkedOutline.vue'
import FileDocument from 'vue-material-design-icons/FileDocument.vue'
import BrandLogo from '~/components/BrandLogo.vue'
import NewDocumentWizardModal from '~/components/listings/NewDocumentWizardModal.vue'
import NotificationBell from '@/components/crm/NotificationBell.vue'
import Modal from '@/components/Modal'
import ChangePasswordForm from '~/components/pages/contacts/ChangePasswordForm'
import ProfileForm from '~/components/pages/contacts/ProfileForm'
import { showLoading, dismissLoading } from '~/helpers/helpers'
import { getContactAvatar } from '~/services/contacts/getContactImage'
import { useCookies } from '@vueuse/integrations/useCookies'

const router = useRouter()

const modalContactForm = ref(null)
const modalChangePasswordForm = ref(null)
const currentContact = ref(null)

const showUserMenu = ref(false)
const showQuickCreate = ref(false)

const userData = ref({
  full_name: null,
  designation: null,
})
const avatar = ref(null)

// Mac users see ⌘K, others see Ctrl+K. Display-only — the global
// hotkey accepts both.
const hotkeyLabel = computed(() => {
  if (typeof navigator === 'undefined') return 'Ctrl K'
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
})

// First word of the resolved name — keeps the avatar pill compact.
const firstName = computed(() => {
  const name = userData.value.full_name
  if (!name) return null
  const w = name.split(' ')[0]?.trim()
  return w && w.length > 0 ? w : name
})

const palette = useCommandPalette()

// Quick-create dropdown items. Two flavors:
//   - `to`: a route to navigate to (existing pattern)
//   - `action`: a callback to invoke instead of navigating, used for
//     in-place modals like the document wizard. Exactly one is set.
const docWizardOpen = ref(false)
const QUICK_CREATE_ITEMS = [
  { label: 'New listing',  icon: HomeCity,             to: { path: '/listings/new' } },
  { label: 'New contact',  icon: AccountMultiple,      to: { path: '/contacts', query: { new: '1' } } },
  { label: 'New task',     icon: CheckboxMarkedOutline, to: { path: '/tasks',    query: { new: '1' } } },
  // 'New inquiry' removed 2026-05-14 — inquiries originate from the
  // public website only (see component-level comment above).
  // Opens the same NewDocumentWizardModal that listings, deals, and
  // contact pages use — the navbar invocation sends no anchors, so
  // the broker picks listing/contact later from the draft's Linked
  // tab. Three modes (Upload Existing / AI Generate / Template) all
  // work without anchors.
  { label: 'New document', icon: FileDocument,         action: () => { docWizardOpen.value = true } },
]

function quickCreateGo(item) {
  showQuickCreate.value = false
  if (item.action) {
    item.action()
    return
  }
  router.push(item.to)
}

// Register quick-create items as command-palette entries so ⌘K can
// trigger them without opening the dropdown. Group "Create" sits
// alongside "Navigate" / "Admin · *" entries from the sidebars.
let unregisterCreateCmds = null
onMounted(() => {
  const cmds = QUICK_CREATE_ITEMS.map((item) => ({
    id: `create.${item.label.toLowerCase().replace(/\s+/g, '-')}`,
    label: item.label,
    hint: 'Create',
    kind: 'action',
    group: 'Create',
    keywords: ['new', 'create', 'add'],
    perform: () => {
      // Action-style items run in-place (open a modal etc.); route-
      // style items navigate. The dropdown's quickCreateGo() does the
      // same dispatch for click; the palette just bypasses that.
      if (item.action) item.action()
      else if (item.to) router.push(item.to)
    },
  }))
  palette.register(...cmds)
  const ids = cmds.map((c) => c.id)
  unregisterCreateCmds = () => palette.unregister(...ids)
})
onBeforeUnmount(() => {
  if (unregisterCreateCmds) {
    unregisterCreateCmds()
    unregisterCreateCmds = null
  }
})

async function logout() {
  await showLoading()
  try {
    const session = useSupabaseSession()
    if (session.value?.access_token && session.value?.refresh_token) {
      await useSupabaseClient().auth.setSession({
        access_token: session.value.access_token,
        refresh_token: session.value.refresh_token,
      })
    }
    await useSupabaseClient().auth.signOut()
    const cookies = useCookies().getAll()
    Object.keys(cookies).forEach((cookie) => {
      useCookie(cookie).value = null
    })
    router.push('/login')
  } finally {
    await dismissLoading()
  }
}

function closeUserMenu() {
  showUserMenu.value = false
}

function closeQuickCreate() {
  showQuickCreate.value = false
}

async function fetchContact() {
  try {
    // Shared profile cache — see app/composables/useCurrentProfile.ts.
    // Multiple components used to fire their own
    // `from('profiles').select('*').eq('email', …)` queries on mount,
    // producing 4 identical round trips per page load (2026-05-14
    // smoke-test finding). All callers now go through this composable.
    const { profile, refresh } = useCurrentProfile()
    // Force a fresh read since this entry point is the profile-modal
    // opener and the operator probably wants current values.
    await refresh()
    const data = profile.value
    if (!data) return

    let avatarImage = []
    try {
      avatarImage = await getContactAvatar(data.id)
    } catch {
      // Ignore avatar errors — a missing avatar is not fatal.
    }

    currentContact.value = {
      id: data.id,
      full_name: data.display_name || data.full_name || '',
      designation: data.designation || '',
      email: data.email || '',
      contact: data.contact || '',
      link: data.link || '',
      notes: data.notes || '',
      avatar:
        (avatarImage && avatarImage.length > 0 ? avatarImage[0] : null) ||
        'https://img.icons8.com/ios/200/user-male-circle.png',
    }
  } catch (err) {
    console.error('Error in fetchContact:', err)
    throw err
  }
}

async function handleAvatarUpdated() {
  const user = useSupabaseUser()
  // Bail if auth hasn't hydrated — `user.value?.id` would otherwise
  // stringify to "undefined" in the PostgREST URL (eq.undefined) and 400.
  if (!user.value?.id) return
  const { data } = await useSupabaseClient()
    .from('contacts')
    .select('*')
    .eq('owner_user_id', user.value.id)
    .eq('email', user.value?.email)
    .single()

  if (!data) return
  const avatarImage = await getContactAvatar(data.id).catch(() => [])
  if (avatarImage.length > 0) avatar.value = avatarImage[0]
  if (currentContact.value) currentContact.value.avatar = avatar.value
}

async function showProfileForm() {
  try {
    showLoading()
    await fetchContact()
    modalContactForm.value?.toggleModal()
    closeUserMenu()
  } catch (err) {
    alert(`Failed to load profile data. ${err?.message || ''}`)
  } finally {
    dismissLoading()
  }
}

function showChangePasswordForm() {
  modalChangePasswordForm.value?.toggleModal()
  closeUserMenu()
}

function closeModal() {
  modalContactForm.value?.toggleModal()
}

function closePasswordModal() {
  modalChangePasswordForm.value?.toggleModal()
}

onMounted(async () => {
  const user = useSupabaseUser()
  if (!user.value) return

  userData.value.full_name = user.value.user_metadata?.full_name || ''
  userData.value.designation = user.value.user_metadata?.designation || ''

  // Shared profile cache. Used to be a direct
  // `from('profiles').select(...).eq('email', user.email).single()`
  // here AND in fetchContact() above — two round trips per mount.
  // useCurrentProfile() dedupes via useState across components.
  const { profile, refresh } = useCurrentProfile()
  if (!profile.value) await refresh()
  const data = profile.value
  if (!data) return

  if (data.display_name) userData.value.full_name = data.display_name
  if (data.designation) userData.value.designation = data.designation

  const avatarImage = await getContactAvatar(data.id).catch(() => [])
  avatar.value =
    avatarImage.length > 0
      ? avatarImage[0]
      : 'https://img.icons8.com/ios/200/user-male-circle.png'

  currentContact.value = {
    id: data.id,
    full_name: data.display_name,
    designation: data.designation,
    contact: data.contact,
    email: data.email,
    avatar: avatar.value,
  }
})

const initials = computed(() => {
  const n = userData.value.full_name
  if (!n) return '?'
  return n
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('') || n[0]?.toUpperCase() || '?'
})
</script>

<template>
  <header
    class="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border-strong bg-card px-4 sm:px-6"
  >
    <!-- Mobile hamburger + brand. Hidden on lg+ where the sidebar
         owns the brand surface. -->
    <button
      type="button"
      class="lg:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground hover:bg-accent focus-ring"
      aria-label="Open navigation menu"
      @click="useAppSidebar().toggle()"
    >
      <Menu :size="22" />
    </button>
    <NuxtLink
      :to="{ name: 'dashboard' }"
      class="lg:hidden flex items-center"
      aria-label="Dashboard"
    >
      <BrandLogo class="h-9 w-auto" />
    </NuxtLink>

    <!-- Global search trigger. Discoverable from the topbar; opens
         the same command palette as the sidebar row + ⌘K. Spans the
         flexible middle so the topbar stays balanced. -->
    <button
      type="button"
      class="ml-auto hidden md:flex h-9 items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 text-xs text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground hover:border-border-strong w-full max-w-sm focus-ring"
      :title="'Search · ' + hotkeyLabel"
      @click="palette.open()"
    >
      <Magnify :size="16" />
      <!-- Honest label — the palette is a command/navigation jumper,
           not a content search. When content search lands, swap back
           to "Search listings, contacts, deals…" AND update the
           palette's input placeholder + handler. -->
      <span class="flex-1 text-left">Jump to a page or action…</span>
      <kbd class="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {{ hotkeyLabel }}
      </kbd>
    </button>
    <!-- Mobile collapsed search (icon-only) -->
    <button
      type="button"
      class="ml-auto md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      :title="'Search · ' + hotkeyLabel"
      @click="palette.open()"
    >
      <Magnify :size="20" />
    </button>

    <!-- Quick-create dropdown. Brass treatment — the single most
         deliberate "create something" affordance on the entire shell.
         Brass is the editorial accent in the Estate aesthetic; reserving
         it for this CTA + dashboard hero CTA + sidebar active state
         keeps it meaningful (not decorative). -->
    <div class="relative" v-on-clickaway="closeQuickCreate" data-tour="create-button">
      <button
        type="button"
        class="btn-primary"
        aria-label="Create"
        @click="showQuickCreate = !showQuickCreate"
      >
        <Plus :size="16" />
        <span class="hidden sm:inline">Create</span>
        <ChevronDown :size="14" class="hidden sm:inline" />
      </button>
      <transition
        enter-active-class="transition duration-100 ease-out"
        enter-from-class="transform scale-95 opacity-0"
        enter-to-class="transform scale-100 opacity-100"
        leave-active-class="transition duration-75 ease-in"
        leave-from-class="transform scale-100 opacity-100"
        leave-to-class="transform scale-95 opacity-0"
      >
        <div
          v-show="showQuickCreate"
          class="absolute right-0 top-full z-50 mt-2 w-56 origin-top-right rounded-lg border border-border-strong bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-8px_rgba(15,23,42,0.16)]"
        >
          <ul class="py-1.5">
            <li v-for="item in QUICK_CREATE_ITEMS" :key="item.label">
              <button
                type="button"
                class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                @click="quickCreateGo(item)"
              >
                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted-foreground/10 text-muted-foreground">
                  <component :is="item.icon" :size="16" />
                </span>
                <span class="flex-1 font-medium">{{ item.label }}</span>
              </button>
            </li>
          </ul>
        </div>
      </transition>
    </div>

    <!-- Notification bell — existing CRM component, unchanged. -->
    <NotificationBell />

    <!-- Avatar pill + user dropdown. Compact on mobile, name+role on lg. -->
    <div class="relative" v-on-clickaway="closeUserMenu">
      <button
        type="button"
        class="flex items-center gap-2.5 rounded-full px-1 py-1 transition-colors hover:bg-accent focus-ring"
        aria-haspopup="menu"
        :aria-expanded="showUserMenu"
        @click="showUserMenu = !showUserMenu"
      >
        <span
          class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-sm font-semibold text-primary ring-1 ring-primary/30"
        >
          <img
            v-if="avatar"
            :src="avatar"
            :alt="userData.full_name || 'User avatar'"
            class="h-full w-full object-cover"
          />
          <span v-else>{{ initials }}</span>
        </span>
        <span class="hidden lg:flex flex-col text-left leading-tight pr-2">
          <span class="text-sm font-semibold text-foreground">
            {{ firstName || 'No Name' }}
          </span>
          <span class="text-[11px] text-muted-foreground">
            {{ userData.designation || 'Member' }}
          </span>
        </span>
      </button>
      <transition
        enter-active-class="transition duration-100 ease-out"
        enter-from-class="transform scale-95 opacity-0"
        enter-to-class="transform scale-100 opacity-100"
        leave-active-class="transition duration-75 ease-in"
        leave-from-class="transform scale-100 opacity-100"
        leave-to-class="transform scale-95 opacity-0"
      >
        <div
          v-show="showUserMenu"
          class="absolute right-0 top-full z-50 mt-2 w-56 origin-top-right rounded-lg border border-border-strong bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-8px_rgba(15,23,42,0.16)]"
          role="menu"
        >
          <div class="border-b border-border px-3 py-2.5">
            <p class="truncate text-sm font-semibold text-foreground">
              {{ userData.full_name || 'No Name' }}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              {{ userData.designation || 'Member' }}
            </p>
          </div>
          <ul class="py-1">
            <li>
              <button
                type="button"
                class="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                @click="showProfileForm"
              >
                My profile
              </button>
            </li>
            <li>
              <button
                type="button"
                class="block w-full px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                @click="showChangePasswordForm"
              >
                Change password
              </button>
            </li>
            <li>
              <button
                type="button"
                class="block w-full px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                @click="logout"
              >
                Sign out
              </button>
            </li>
          </ul>
        </div>
      </transition>
    </div>

    <Modal title="My Profile" ref="modalContactForm">
      <ProfileForm
        @closeModal="closeModal"
        @avatarUpdated="handleAvatarUpdated"
        :currentContact="currentContact"
      />
    </Modal>

    <Modal title="Change Password" ref="modalChangePasswordForm">
      <ChangePasswordForm
        ref="changePasswordForm"
        @closeModal="closePasswordModal"
      />
    </Modal>

    <!-- Document creation wizard, reachable from + → New document and
         from ⌘K → New document. No anchors are passed from this
         entry point; the broker attaches the draft to a listing or
         contact later from the draft's Linked tab. -->
    <NewDocumentWizardModal
      :open="docWizardOpen"
      :listing-id="null"
      :contact-id="null"
      @update:open="docWizardOpen = $event"
    />
  </header>
</template>
